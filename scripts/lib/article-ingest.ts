// article-ingest（正本 <DATA_HOME>/articles/*.json）への取り込みを、llamaindex の CLI から呼ぶための共通部分。
// npm run ingest / ingest:offline（新しい論文）と migrate:canonical（既存論文の移行）が使う。
// 正本は 50_article-json と共有なので、ここで書き換えるのは別名・分類・図の実ファイルの対応だけ。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { addAlias, buildAliasIndex } from "article-ingest/aliases";
import { dirFor } from "article-ingest/paths";
import type { Article } from "article-ingest/types";
import { PATHS } from "../../src/server/config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// node_modules/article-ingest は file:../article-ingest へのリンク。Python と npm スクリプトはその実体で動かす。
export function articleIngestDir(): string {
  if (process.env.ARTICLE_INGEST_DIR) return path.resolve(process.env.ARTICLE_INGEST_DIR);
  return fs.realpathSync(path.join(root, "node_modules", "article-ingest"));
}

export function snapshotUrl(file: string): string {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(16384);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, read).toString("latin1").split(/\r?\n\r?\n/)[0];
    // ヘッダの折り返し（長い URL）をつなぐ
    const match = head.replace(/\r?\n[ \t]+/g, "").match(/^Snapshot-Content-Location:\s*(\S+)/im);
    return match?.[1] ?? "";
  } finally {
    fs.closeSync(fd);
  }
}

// article-ingest の importMhtml.py が扱える出版社（importScienceDirect.py と importPublisherMhtml.py）。
// ここに無い出版社（Springer・PNAS・JBJS など）は、llamaindex の convert-local-mhtml.py のまま取り込む。
const SUPPORTED_HOSTS = [
  "sciencedirect.com", "onlinelibrary.wiley.com", "journals.sagepub.com", "mdpi.com", "frontiersin.org",
  "academic.oup.com", "iopscience.iop.org", "boneandjoint.org.uk", "dovepress.com", "pmc.ncbi.nlm.nih.gov",
];

export function articleIngestPublisher(url: string): string | null {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  return SUPPORTED_HOSTS.find((suffix) => host === suffix || host.endsWith(`.${suffix}`)) ?? null;
}

export interface ImportSummary {
  doi: string;
  title: string;
  authors: string[];
  publisher: string;
  sections: number;
  paragraphs: number;
  references: number;
  figures: number;
  embeddedFigures?: number;
  tables: number;
  warnings: string[];
  notices: string[];
}

export interface ImportResult {
  slug: string;
  articlePath: string | null;
  summary: ImportSummary;
}

// MHTML → JATS → npm run build（article-ingest）。dryRun では何も書かない。
export function importMhtml(
  file: string,
  options: { key?: string; figureDirs?: string[]; dryRun?: boolean; force?: boolean; corpus?: boolean } = {},
): ImportResult {
  const args = ["run", "--no-project", "--python", ">=3.10", "python", "-I", path.join(articleIngestDir(), "src", "tools", "importMhtml.py"), file];
  if (options.key) args.push("--key", options.key);
  for (const dir of options.figureDirs ?? []) if (fs.existsSync(dir)) args.push("--figure-dir", dir);
  // 図の画像や文献リストが MHTML に無くても止めずに警告にする（画像は手で保存したものや旧データので後から補える）
  args.push("--lenient");
  if (options.dryRun) args.push("--dry-run");
  if (options.force) args.push("--force");
  if (options.corpus === false) args.push("--no-corpus");
  const result = spawnSync(process.env.UV ?? "uv", args, { cwd: articleIngestDir(), encoding: "utf-8", env: process.env, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  const line = (result.stdout ?? "").split("\n").find((l) => l.startsWith("RESULT "));
  if (result.status !== 0 || !line) {
    const lines = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim().split("\n").filter(Boolean);
    const failed = lines.find((l) => l.startsWith("Failed: ")) ?? lines[lines.length - 1] ?? `exit ${result.status}`;
    throw new Error(`article-ingest: ${failed.replace(/^Failed: /, "")}`);
  }
  return JSON.parse(line.slice("RESULT ".length)) as ImportResult;
}

export function doiKey(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "").replace(/^doi:\s*/, "");
}

export interface CanonicalFile {
  id: string;
  file: string;
  article: Article;
}

// DOI で正本を探す（ファイル名の大文字・小文字に頼らない）。
export function findCanonicalByDoi(doi: string): CanonicalFile | null {
  const target = doiKey(doi);
  if (!target) return null;
  const dir = dirFor("articles");
  if (!fs.existsSync(dir)) return null;
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    const file = path.join(dir, name);
    try {
      const article = JSON.parse(fs.readFileSync(file, "utf-8")) as Article;
      if (doiKey(article.meta?.doi) === target) return { id: article.id, file, article };
    } catch {
      // 読めない JSON は飛ばす（canonicalStore と同じ扱い）
    }
  }
  return null;
}

export function writeArticle(file: string, article: Article) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(article, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}

// 別名を付ける。別の論文が同じ別名を持っていれば例外（呼び出し側で止める）。
export function ensureAliases(canonicalId: string, aliases: string[]): string[] {
  const index = buildAliasIndex();
  const added: string[] = [];
  for (const alias of aliases.filter(Boolean)) {
    const owner = index.byAlias.get(alias.toLowerCase());
    if (owner === canonicalId) continue;
    addAlias(canonicalId, alias);
    index.byAlias.set(alias.toLowerCase(), canonicalId);
    added.push(alias);
  }
  return added;
}

// 引用キーを aliases の先頭にする（llamaindex は aliases[0] を id にする）。extra は旧 id など、ほかの呼び名。
export function setCitationKey(canonicalId: string, key: string, extra: string[] = []): CanonicalFile {
  ensureAliases(canonicalId, [key, ...extra]);
  const file = path.join(dirFor("articles"), `${canonicalId}.json`);
  const article = JSON.parse(fs.readFileSync(file, "utf-8")) as Article;
  const aliases = article.aliases ?? [];
  if (aliases[0]?.toLowerCase() !== key.toLowerCase()) {
    article.aliases = [key, ...aliases.filter((a) => a.toLowerCase() !== key.toLowerCase())];
    writeArticle(file, article);
  }
  return { id: canonicalId, file, article };
}

// 別名の持ち主（正本 id）。無ければ undefined。
export function aliasOwner(alias: string): string | undefined {
  return buildAliasIndex().byAlias.get(alias.toLowerCase());
}

export interface LegacyClassification {
  articleType?: "original" | "review" | "manuscript" | null;
  articleTypeSource?: "pubmed" | "manual";
  publicationTypes?: string[];
  pubmedCheckedAt?: string;
  pmid?: string;
}

// 旧 article_sets の分類を正本の classification（と meta.pmid）へ移す。
// 正本に分類が既にあれば残す。ただし手で付けた種別（manual）は旧データを優先する。
export function transferClassification(article: Article, legacy: LegacyClassification): boolean {
  const manual = legacy.articleTypeSource === "manual";
  const known = manual || !!legacy.pubmedCheckedAt;
  if (!known) return false;
  if (article.classification && !manual) {
    if (!article.meta.pmid && legacy.pmid) article.meta.pmid = legacy.pmid;
    return false;
  }
  article.classification = {
    articleType: legacy.articleType ?? null,
    source: manual ? "manual" : "pubmed",
    ...(legacy.publicationTypes?.length ? { publicationTypes: legacy.publicationTypes } : {}),
    checkedAt: legacy.pubmedCheckedAt ?? new Date().toISOString(),
  } as NonNullable<Article["classification"]>;
  if (legacy.pmid && !article.meta.pmid) article.meta.pmid = legacy.pmid;
  return true;
}

interface LegacySection {
  title: string;
  type: string;
  paragraphs: string[];
  content?: string;
}

const figureNumber = (label: string | undefined) => label?.match(/(\d+)\s*(?:\(([a-z])\))?/i)?.slice(1, 3).filter(Boolean).join("") ?? "";

// 旧 article_sets の図にだけ画像がある（/raw_html/<id>_figures/… に保存してある）場合、
// その画像を <DATA_HOME>/figures/<正本id>/ にコピーして figures[].files に入れる。
// 返り値はコピーした枚数。
export function attachLegacyFigures(article: Article, legacySections: LegacySection[]): number {
  const local = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const s of legacySections.filter((x) => x.type === "figure")) {
    const text = s.content ?? s.paragraphs.join("\n\n");
    const url = text.match(/\[Image URL:\s*(\/raw_html\/[^\]\s]+)\]/)?.[1];
    if (!url) continue;
    const source = path.join(PATHS.rawHtmlDir, ...decodeURIComponent(url.replace(/^\/raw_html\//, "")).split("/"));
    if (!fs.existsSync(source)) continue;
    const number = figureNumber(s.title);
    if (number && !local.has(number)) local.set(number, source);
    byName.set(path.basename(source), source);
  }
  if (!local.size && !byName.size) return 0;
  const dest = path.join(dirFor("figures"), article.id);
  let copied = 0;
  for (const figure of article.figures) {
    if (figure.files?.length) continue;
    const source = figure.graphics.map((g) => byName.get(path.basename(g))).find(Boolean) ?? local.get(figureNumber(figure.label));
    if (!source) continue;
    const name = path.basename(source);
    fs.mkdirSync(dest, { recursive: true });
    const target = path.join(dest, name);
    if (!fs.existsSync(target)) fs.copyFileSync(source, target);
    figure.files = [name];
    copied++;
  }
  return copied;
}

// article-ingest の目録（corpus.json）を更新する。まとめて取り込んだあとに1回だけ呼ぶ。
export function updateCorpus(): void {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["run", "--silent", "corpus", "--", "--update"], { cwd: articleIngestDir(), encoding: "utf-8", env: process.env });
  if (result.status !== 0) console.warn(`  ⚠ corpus update failed: ${(result.stderr || result.stdout || "").trim().split("\n").pop()}`);
}
