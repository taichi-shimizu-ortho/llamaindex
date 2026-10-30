// 複数論文（10〜30本）をまとめて検索する corpus RAG。
// rxfp1 と同じく 1段落 = 1検索単位とし、各段落に論文メタデータ（引用ラベル・著者・年・誌名・DOI）と
// 構造メタデータ（節・節の種類・小見出し・段落番号）を持たせて、全論文を横断して top-K を引く。
// 埋め込みは論文ごとにディスクキャッシュするので、論文の組み合わせを変えても再埋め込みしない。
import fs from "node:fs";
import { MODELS } from "./config.js";
import { cosineSimilarity, embedModel, getEmbeddings } from "./embeddingStore.js";
import { generateAnswer, hasJapanese, translateToEnglish } from "./llm.js";
import { articleSetPath, loadArticleSet, type ArticleSet } from "./articleHarvester.js";

// 節の種類を論文横断で揃えた分類。取り込み元によって type が "body" や "other" のこともあるので、
// そのときは見出しから推定する。
export type SectionGroup = "intro" | "methods" | "results" | "discussion" | "conclusion" | "figure" | "table" | "other";

const TYPE_GROUPS: Record<string, SectionGroup> = {
  intro: "intro",
  "materials|methods": "methods",
  methods: "methods",
  results: "results",
  discussion: "discussion",
  conclusion: "conclusion",
  figure: "figure",
  table: "table",
};

// 本文以外の定型節（利益相反・著者貢献など）。見出しで判定し、内容のある種類の節には適用しない。
const BOILERPLATE_TITLE =
  /acknowledg|conflicts? of interest|competing interest|author contribution|funding|ethic|data availability|declaration|abbreviation|^keywords?$|^references?$|^notes?$|levels? of evidence/i;

function groupFromTitle(title: string): SectionGroup {
  const t = title.toLowerCase();
  if (/method|material|study design|patients and/.test(t)) return "methods";
  if (/result/.test(t)) return "results";
  if (/discussion|limitation/.test(t)) return "discussion";
  if (/conclusion/.test(t)) return "conclusion";
  if (/introduction|background|purpose/.test(t)) return "intro";
  return "other";
}

function sectionGroup(type: string, title: string): SectionGroup {
  return TYPE_GROUPS[type] ?? groupFromTitle(title);
}

// 段落テキスト中のリンクを落として空白を詰める。表は行構造を残す。
function cleanText(text: string, group: SectionGroup): string {
  const unlinked = text.replace(/\[[^\]]*\]\(https?:\/\/[^\)]+\)/g, "");
  if (group === "table") return unlinked.trim();
  return unlinked.replace(/\s+/g, " ").trim();
}

// 取り込み時の連番サフィックス（-2 など）を落とした ID を引用ラベルにする（例: Li2026）。
function baseLabel(id: string): string {
  return id.replace(/-\d+$/, "");
}

interface Paragraph {
  text: string;
  section: string;
  subsection: string;
  group: SectionGroup;
  paragraphIndex: number;
  totalParagraphs: number;
}

interface PaperIndex {
  set: ArticleSet;
  mtimeMs: number;
  paragraphs: Paragraph[];
  embeddings: number[][];
}

// abstract は本文（Results/Conclusion など）とほぼ同じ文を含み、top-K を同じ内容で食いつぶすので除く。
// 本文が取れていない論文だけは abstract を残して検索できるようにする。
function paragraphsOf(set: ArticleSet, includeAbstract = false): Paragraph[] {
  const out: Paragraph[] = [];
  for (const section of set.sections) {
    if (section.type === "abstract" && !includeAbstract) continue;
    const group = section.type === "abstract" ? "other" : sectionGroup(section.type, section.title);
    if (!TYPE_GROUPS[section.type] && BOILERPLATE_TITLE.test(section.title.trim())) continue;

    const push = (paragraphs: string[], subsection: string) => {
      const texts = paragraphs.map((p) => cleanText(p, group)).filter(Boolean);
      texts.forEach((text, i) =>
        out.push({
          text,
          section: section.title,
          subsection,
          group,
          paragraphIndex: i + 1,
          totalParagraphs: texts.length,
        }),
      );
    };
    push(section.paragraphs, "");
    for (const sub of section.subsections) push(sub.paragraphs, sub.title);
  }
  return out;
}

const cache = new Map<string, Promise<PaperIndex>>();

async function buildPaperIndex(id: string, mtimeMs: number): Promise<PaperIndex> {
  const set = loadArticleSet(id);
  let paragraphs = paragraphsOf(set);
  if (!paragraphs.length) paragraphs = paragraphsOf(set, true);
  if (!paragraphs.length) throw new Error("No paragraphs to search");
  const embeddings = await getEmbeddings("corpus", id, paragraphs.map((p) => p.text));
  return { set, mtimeMs, paragraphs, embeddings };
}

// 論文JSONが再取り込みで更新されたら（mtime が変われば）作り直す。
async function paperIndex(id: string): Promise<PaperIndex> {
  const mtimeMs = fs.statSync(articleSetPath(id)).mtimeMs;
  const cached = cache.get(id);
  if (cached) {
    const index = await cached.catch(() => null);
    if (index && index.mtimeMs === mtimeMs) return index;
  }
  const next = buildPaperIndex(id, mtimeMs);
  cache.set(id, next);
  next.catch(() => cache.delete(id));
  return next;
}

// 埋め込みAPIを叩きすぎないよう、論文ごとの索引作成は数本ずつ並べて走らせる。
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface CorpusPaper {
  id: string;
  // 回答・ソース表示で使う引用ラベル（例: Li2026、同名があれば Li2026a / Li2026b）
  label: string;
  title: string;
  authors: string;
  year: string;
  journal: string;
  doi: string;
  sourceUrl: string;
  paragraphs: number;
  // 直近の検索で top-K に入った段落数（prepare では 0）
  hits: number;
}

export interface CorpusSkipped {
  id: string;
  error: string;
}

interface LoadedCorpus {
  papers: CorpusPaper[];
  indexes: PaperIndex[];
  skipped: CorpusSkipped[];
}

function uniqueIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.map((id) => String(id ?? "").replace(/[^a-zA-Z0-9_.-]/g, "")).filter(Boolean))];
}

// 読めない論文があっても全体は止めず、skipped に理由を返す。
async function loadCorpus(articleIds: unknown): Promise<LoadedCorpus> {
  const ids = uniqueIds(articleIds);
  if (!ids.length) throw new Error("Select at least one paper");
  const settled = await mapLimit(ids, 4, (id) =>
    paperIndex(id).then(
      (index) => ({ id, index, error: "" }),
      (e) => ({ id, index: null, error: String(e?.message ?? e) }),
    ),
  );

  const loaded = settled.filter((s): s is { id: string; index: PaperIndex; error: string } => s.index !== null);
  const skipped = settled.filter((s) => !s.index).map(({ id, error }) => ({ id, error }));

  // 同じ引用ラベルが複数あれば a, b, … を付けて区別する。
  const labelCount = new Map<string, number>();
  for (const { id } of loaded) labelCount.set(baseLabel(id), (labelCount.get(baseLabel(id)) ?? 0) + 1);
  const labelSeen = new Map<string, number>();

  const papers = loaded.map(({ id, index }): CorpusPaper => {
    const base = baseLabel(id);
    let label = base;
    if ((labelCount.get(base) ?? 0) > 1) {
      const n = labelSeen.get(base) ?? 0;
      labelSeen.set(base, n + 1);
      label = `${base}${String.fromCharCode(97 + n)}`;
    }
    const { set } = index;
    return {
      id,
      label,
      title: set.title,
      authors: set.authors.join(", "),
      year: set.year,
      journal: set.journal,
      doi: set.doi,
      sourceUrl: set.sourceUrl,
      paragraphs: index.paragraphs.length,
      hits: 0,
    };
  });

  return { papers, indexes: loaded.map((l) => l.index), skipped };
}

export interface CorpusPrepareResult {
  papers: CorpusPaper[];
  skipped: CorpusSkipped[];
  totalParagraphs: number;
}

// 検索前に埋め込みを用意しておく（初回だけ時間がかかるため、画面を開いた時点で走らせる）。
export async function prepareCorpus(articleIds: unknown): Promise<CorpusPrepareResult> {
  const { papers, skipped } = await loadCorpus(articleIds);
  return { papers, skipped, totalParagraphs: papers.reduce((sum, p) => sum + p.paragraphs, 0) };
}

export interface CorpusSource {
  // 回答中の [S3] と対応する通し番号
  n: number;
  articleId: string;
  label: string;
  score: number;
  cited: boolean;
  title: string;
  authors: string;
  year: string;
  journal: string;
  doi: string;
  sourceUrl: string;
  section: string;
  subsection: string;
  sectionGroup: SectionGroup;
  paragraphIndex: number;
  totalParagraphs: number;
  text: string;
}

export interface CorpusQueryResult {
  scope: "corpus";
  // 検索対象の説明（例: "Folder: Rxfp1 / Clinical"）。md の見出しに残す。
  scopeLabel: string;
  articleIds: string[];
  papers: CorpusPaper[];
  skipped: CorpusSkipped[];
  originalQuery: string;
  enQuery: string;
  // 絞り込んだ節の種類（空 = すべて）
  sectionGroups: SectionGroup[];
  topK: number;
  // 1論文あたりの上限（0 = 上限なし）
  perPaper: number;
  answer: string;
  model: string;
  sources: CorpusSource[];
}

export interface CorpusQueryOptions {
  topK?: number;
  perPaper?: number;
  sectionGroups?: unknown;
  translate?: boolean;
  scopeLabel?: unknown;
}

const ALL_GROUPS: SectionGroup[] = ["intro", "methods", "results", "discussion", "conclusion", "figure", "table", "other"];

function normalizeGroups(value: unknown): SectionGroup[] {
  if (!Array.isArray(value)) return [];
  return ALL_GROUPS.filter((g) => value.includes(g));
}

function sectionPath(source: CorpusSource): string {
  return source.subsection ? `${source.section} > ${source.subsection}` : source.section;
}

// 回答中の [S3] / [S2, S7] を拾う。
export function citedPassages(answer: string): Set<number> {
  const cited = new Set<number>();
  for (const group of answer.match(/\[\s*S\d+(?:\s*[,;]\s*S\d+)*\s*\]/g) ?? []) {
    for (const n of group.match(/\d+/g) ?? []) cited.add(Number(n));
  }
  return cited;
}

async function synthesize(enQuery: string, sources: CorpusSource[]) {
  if (!sources.length) return { text: "No relevant passages were found in the selected papers.", model: MODELS.llm };
  const context = sources
    .map((s) => {
      const meta = [s.authors.split(",")[0]?.trim() && `${s.authors.split(",")[0].trim()} et al.`, s.year, s.journal]
        .filter(Boolean)
        .join(", ");
      return [
        `[S${s.n}] ${s.label} — ${s.title}${meta ? ` (${meta})` : ""}`,
        `Section: ${sectionPath(s)} (${s.sectionGroup}), paragraph ${s.paragraphIndex}/${s.totalParagraphs}`,
        s.text,
      ].join("\n");
    })
    .join("\n\n---\n\n");

  const system = [
    "You are a biomedical research assistant answering from passages drawn from several research articles.",
    "Use only the provided passages; do not add outside knowledge.",
    "After each statement, cite the supporting passages by their identifiers in square brackets, e.g. [S3] or [S2, S7].",
    "Use only S-identifiers for citations; numeric brackets inside passages are the articles' own references and must not be used as citations.",
    "Attribute findings to their paper by its label (e.g. Li2026) when comparing studies, and point out where papers agree, disagree, or report different numbers.",
    "If the passages do not contain enough information, say so clearly.",
    "Always answer in English, regardless of the language of the user's query.",
  ].join(" ");

  return generateAnswer(system, `Passages:\n\n${context}\n\nQuestion: ${enQuery}`);
}

export async function runCorpusQuery(
  articleIds: unknown,
  originalQuery: string,
  opts: CorpusQueryOptions = {},
): Promise<CorpusQueryResult> {
  const topK = Math.max(1, Math.min(40, Number(opts.topK ?? 10) || 10));
  const perPaper = Math.max(0, Math.min(40, Number(opts.perPaper ?? 0) || 0));
  const sectionGroups = normalizeGroups(opts.sectionGroups);
  const allowed = sectionGroups.length ? new Set(sectionGroups) : null;

  const { papers, indexes, skipped } = await loadCorpus(articleIds);
  if (!papers.length) throw new Error(`No searchable papers: ${skipped.map((s) => `${s.id} (${s.error})`).join(", ")}`);

  const shouldTranslate = opts.translate ?? hasJapanese(originalQuery);
  const enQuery = shouldTranslate ? await translateToEnglish(originalQuery) : originalQuery;
  const queryVec = await embedModel().getTextEmbedding(enQuery);

  // 全論文の段落をまとめて採点し、上から順に（1論文あたりの上限を守りつつ）topK 件取る。
  const scored = indexes.flatMap((index, p) =>
    index.paragraphs.flatMap((para, i) =>
      !allowed || allowed.has(para.group) ? [{ p, para, score: cosineSimilarity(queryVec, index.embeddings[i]) }] : [],
    ),
  );
  if (!scored.length) throw new Error(`No paragraphs in the selected section types: ${sectionGroups.join(", ")}`);
  scored.sort((a, b) => b.score - a.score);

  const perPaperCount = new Map<number, number>();
  const picked: typeof scored = [];
  for (const hit of scored) {
    if (picked.length >= topK) break;
    const count = perPaperCount.get(hit.p) ?? 0;
    if (perPaper && count >= perPaper) continue;
    perPaperCount.set(hit.p, count + 1);
    picked.push(hit);
  }

  const sources: CorpusSource[] = picked.map(({ p, para, score }, i) => {
    const paper = papers[p];
    return {
      n: i + 1,
      articleId: paper.id,
      label: paper.label,
      score,
      cited: false,
      title: paper.title,
      authors: paper.authors,
      year: paper.year,
      journal: paper.journal,
      doi: paper.doi,
      sourceUrl: paper.sourceUrl,
      section: para.section,
      subsection: para.subsection,
      sectionGroup: para.group,
      paragraphIndex: para.paragraphIndex,
      totalParagraphs: para.totalParagraphs,
      text: para.text,
    };
  });

  const { text: answer, model } = await synthesize(enQuery, sources);
  const cited = citedPassages(answer);
  for (const source of sources) source.cited = cited.has(source.n);
  for (const [p, count] of perPaperCount) papers[p].hits = count;

  return {
    scope: "corpus",
    scopeLabel: String(opts.scopeLabel ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
    articleIds: papers.map((p) => p.id),
    papers,
    skipped,
    originalQuery,
    enQuery,
    sectionGroups,
    topK,
    perPaper,
    answer,
    model,
    sources,
  };
}
