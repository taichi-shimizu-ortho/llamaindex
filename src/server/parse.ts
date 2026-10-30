// MD → 構造化JSON 変換（Python版 30_batch_convert_articles.py の忠実な移植）
// JSON構造化の「原理」はここに集約されている。
import yaml from "js-yaml";
import type { Article, Section, Subsection, SectionType } from "../shared/types.js";

// JSON出力時に除外するセクションタイプ
// 注: 'other' は含めない（レビュー論文など独自構造を持つ記事の内容を保持）
const EXCLUDE_SECTION_TYPES = new Set(["references", "acknowledgements", "abstract", "cited_by"]);

// --- frontmatter ---------------------------------------------------------

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/;

export function parseFrontmatter(content: string): [Record<string, any>, string] {
  const m = content.match(FRONTMATTER_RE);
  if (m) {
    try {
      const fm = (yaml.load(m[1]) as Record<string, any>) || {};
      return [fm, m[2]];
    } catch (e) {
      console.error(`Error parsing frontmatter YAML: ${e}`);
      return [{}, content];
    }
  }
  return [{}, content];
}

function extractMainTextSection(content: string): string | null {
  // # 4 Main Text セクションを抽出
  const m = content.match(/# 4 Main Text\s*\r?\n([\s\S]*?)(?=\n#(?![#\s])|$)/i);
  return m ? m[1].trim() : null;
}

function parseMainTextFrontmatter(mainText: string): [Record<string, any>, string] {
  const m = mainText.match(FRONTMATTER_RE);
  if (m) {
    try {
      const meta = (yaml.load(m[1]) as Record<string, any>) || {};
      return [meta, mainText];
    } catch (e) {
      console.error(`Error parsing main text frontmatter: ${e}`);
      return [{}, mainText];
    }
  }
  return [{}, mainText];
}

function classifySectionType(title: string): SectionType {
  const t = title.toLowerCase();
  if (t.includes("abstract")) return "abstract";
  if (t.includes("introduction") || t === "intro" || t.includes("background")) return "intro";
  if (t.includes("keyword")) return "keywords";
  if (t.includes("abbreviation")) return "abbreviations";
  if (t.includes("method") || t.includes("material") || t.includes("patient")) return "materials|methods";
  if (t.includes("result")) return "results";
  if (t.includes("discussion")) return "discussion";
  if (t.includes("conclusion")) return "conclusion";
  if (t.includes("reference")) return "references";
  if (t.includes("cited by") || t.includes("citing")) return "cited_by";
  if (t.includes("acknowledgement") || t.includes("acknowledgment")) return "acknowledgements";
  return "other";
}

function extractSubsections(sectionContent: string): Subsection[] {
  const subsections: Subsection[] = [];
  const re = /###\s+([^\n]+)\n([\s\S]*?)(?=\n###\s+|\n##\s+|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sectionContent)) !== null) {
    subsections.push({ title: m[1].trim(), content: m[2].trim() });
  }
  return subsections;
}

function extractSectionsFromMainText(mainTextBody: string, isReview = false): Section[] {
  const sections: Section[] = [];

  // 最初のセクション見出しの位置を探す
  const firstHeading = mainTextBody.match(/\n##\s+/);
  if (firstHeading && firstHeading.index !== undefined) {
    const preamble = mainTextBody.slice(0, firstHeading.index).trim();
    if (preamble && !isReview) {
      sections.push({ title: "Introduction", type: "intro", content: preamble, subsections: [] });
    }
  }

  const re = /##\s+([^\n]+)\n([\s\S]*?)(?=\n##\s+|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(mainTextBody)) !== null) {
    const sectionTitle = m[1].trim();
    let sectionContent = m[2].trim();

    let sectionType: SectionType;
    if (isReview) {
      const tl = sectionTitle.toLowerCase();
      if (tl.includes("acknowledgement") || tl.includes("acknowledgment")) sectionType = "acknowledgements";
      else if (tl.includes("reference")) sectionType = "references";
      else sectionType = "review";
    } else {
      sectionType = classifySectionType(sectionTitle);
    }

    const subsections = extractSubsections(sectionContent);
    if (subsections.length > 0) {
      const firstH3 = sectionContent.indexOf("###");
      sectionContent = firstH3 >= 0 ? sectionContent.slice(0, firstH3).trim() : "";
    }

    sections.push({ title: sectionTitle, type: sectionType, content: sectionContent, subsections });
  }
  return sections;
}

function extractInfoBlockMetadata(content: string): Record<string, any> {
  const metadata: Record<string, any> = {
    first_author: "", authors: [], title: "", year: "",
    journal: "", volume: "", issue: "", doi: "", citekey: "",
  };
  const infoMatch = content.match(/>\s*\[!Info\]([\s\S]*?)(?=\n(?!>)|$)/);
  if (!infoMatch) return metadata;
  const info = infoMatch[1];

  const find = (re: RegExp): string => {
    const m = info.match(re);
    return m ? m[1].trim() : "";
  };

  metadata.first_author = find(/\*\*FirstAuthor\*\*::\s*([^>]+?)(?:\s*>|$)/);
  const authorRe = /\*\*(?:First)?Author\*\*::\s*([^>]+?)(?:\s*>|$)/g;
  const authors: string[] = [];
  let am: RegExpExecArray | null;
  while ((am = authorRe.exec(info)) !== null) {
    const a = am[1].trim();
    if (a) authors.push(a);
  }
  metadata.authors = authors;
  metadata.title = find(/>\s*\*\*Title\*\*:\s*([^\n]+)/);
  metadata.year = find(/>\s*\*\*Year\*\*:\s*(\d+)/);
  metadata.citekey = find(/>\s*\*\*Citekey\*\*:\s*([^\n]+)/);
  metadata.journal = find(/>\s*\*\*Journal\*\*:\s*\*?([^\n*]+)\*?/);
  metadata.volume = find(/>\s*\*\*Volume\*\*:\s*([^\n]+)/);
  metadata.issue = find(/>\s*\*\*Issue\*\*:\s*([^\n]+)/);
  metadata.doi = find(/>\s*\*\*DOI\*\*:\s*([^\n]+)/);
  return metadata;
}

// --- クリーニング --------------------------------------------------------

function removeUrlReferences(text: string): string {
  text = text.replace(/\(https?:\/\/[^)]+\)/g, "");
  text = text.replace(/<[^>]+>/g, "");
  return text;
}

function isHeadingOnly(block: string): boolean {
  const lines = block.split("\n").filter((l) => l.trim());
  return lines.length > 0 && lines.every((l) => /^#{1,6}\s/.test(l));
}

function cleanHeading(block: string): string {
  const cleaned: string[] = [];
  for (let l of block.split("\n")) {
    if (!l.trim()) continue;
    l = l.replace(/^#{1,6}\s*/, ""); // 見出し記号を除去
    l = l.replace(/\\([.\-)])/g, "$1"); // \. \- \) のエスケープ解除
    cleaned.push(l.trim());
  }
  return cleaned.join("\n");
}

function mergeOrphanHeadings(text: string): string {
  // 見出しだけの段落を直後の本文段落に統合する
  if (!text) return text;
  const blocks = text.split("\n\n").map((b) => b.trim()).filter((b) => b);
  const result: string[] = [];
  let pending: string[] = [];
  for (let b of blocks) {
    if (isHeadingOnly(b)) {
      pending.push(cleanHeading(b));
    } else {
      if (pending.length > 0) {
        b = pending.join("\n") + "\n" + b;
        pending = [];
      }
      result.push(b);
    }
  }
  // pending に残った見出しは後続本文が無いので破棄
  return result.join("\n\n");
}

function filterSections(article: Article): Article {
  const filtered: Section[] = [];
  for (const section of article.sections) {
    if (EXCLUDE_SECTION_TYPES.has(section.type)) continue;
    section.content = mergeOrphanHeadings(removeUrlReferences(section.content));
    for (const sub of section.subsections) {
      sub.content = mergeOrphanHeadings(removeUrlReferences(sub.content));
    }
    filtered.push(section);
  }
  article.sections = filtered;
  return article;
}

// --- メイン変換 ----------------------------------------------------------

function normalizeTags(raw: any): string[] {
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) return raw;
  return [];
}

// Python の text モード読み込み相当: CRLF / 単独CR を LF に正規化
function normalizeNewlines(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function mdToStructuredJson(content: string, isReviewOverride?: boolean | null): Omit<Article, "filename" | "pmid" | "publisher" | "entrez_mesh_terms" | "entrez_keywords"> {
  content = normalizeNewlines(content);
  const [frontmatter, remaining] = parseFrontmatter(content);
  const info = extractInfoBlockMetadata(content);
  const mainText = extractMainTextSection(remaining);
  if (!mainText) {
    throw new Error("# 4 Main Text section not found in markdown file");
  }
  const [mainTextMeta, mainTextBody] = parseMainTextFrontmatter(mainText);

  const tags = normalizeTags(frontmatter.tags);

  // review判定: 1.引数 2.frontmatter.review 3.tags
  let isReview: boolean;
  if (isReviewOverride !== undefined && isReviewOverride !== null) {
    isReview = isReviewOverride;
  } else if ("review" in frontmatter) {
    isReview = Boolean(frontmatter.review);
  } else {
    isReview = tags.includes("review");
  }

  const sections = extractSectionsFromMainText(mainTextBody, isReview);

  let published = info.year || mainTextMeta.published || "";
  if (published && typeof published !== "string") published = String(published);

  const authors: string[] = (info.authors && info.authors.length) ? info.authors : (mainTextMeta.author || []);

  return {
    citekey: info.citekey || frontmatter.citekey || "",
    title: info.title || mainTextMeta.title || frontmatter.title || "",
    authors,
    published,
    source: info.journal || mainTextMeta.source || "",
    volume: info.volume || "",
    issue: info.issue || "",
    doi: info.doi || frontmatter.doi || "",
    tags,
    sections,
    is_review: isReview,
  };
}

// ファイル1件を完全な Article に変換（frontmatter の付帯メタも付与）
export function convertArticle(content: string, filename: string): Article {
  content = normalizeNewlines(content);
  const [fm] = parseFrontmatter(content);
  const mdIsReview: boolean | null = "review" in fm ? Boolean(fm.review) : null;

  const base = mdToStructuredJson(content, mdIsReview);
  const article: Article = {
    ...base,
    filename,
    pmid: String(fm.pmid ?? ""),
    publisher: String(fm.publisher ?? ""),
    entrez_mesh_terms: fm.mesh_terms || [],
    entrez_keywords: fm.keywords || [],
  };
  return filterSections(article);
}
