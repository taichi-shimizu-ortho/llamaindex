import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { ArticleSection, ArticleSet } from "./articleHarvester.js";
import { PATHS } from "./config.js";
import { RXFP1_ARTICLE_PREFIX } from "../shared/rxfp1.js";

interface LegacySection {
  title: string;
  type: string;
  content: string;
  subsections?: { title: string; content: string }[];
}

interface LegacyArticle {
  citekey: string;
  title: string;
  authors: string[];
  published: string;
  source: string;
  doi: string;
  pmid: string;
  is_review?: boolean;
  sections: LegacySection[];
}

const CITEKEY = /^[\w.-]+$/;
const frontmatter = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const NON_BODY = /^(?:abstract|excluded|references?|cited[_ ]by|acknowledg|keywords?|abbreviations?|funding|grants|disclosures?|conflicts? of interest|author contributions|availability of data|data availability|footnotes?)/i;
const paragraphs = (text: string) => (text ?? "").split(/\r?\n[ \t]*\r?\n/).map((value) => value.trim()).filter(Boolean);
const doiOf = (value: unknown) => String(value ?? "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").trim();

export function isRxfp1Body(type: string, title: string): boolean {
  return !NON_BODY.test(type) && !NON_BODY.test(title);
}

function sectionType(title: string) {
  const name = title.replace(/^(?:[\d.\\]+\s+)+/, "");
  if (/^abstract\b/i.test(name)) return "abstract";
  if (!isRxfp1Body("", name)) return "excluded";
  if (/^(figure|fig\.)\s*\d/i.test(name)) return "figure";
  if (/^table\s*\d/i.test(name)) return "table";
  if (/method|material|patients and|experimental procedures/i.test(name)) return "methods";
  if (/result|findings/i.test(name)) return "results";
  if (/discussion/i.test(name)) return "discussion";
  if (/conclusion/i.test(name)) return "conclusion";
  if (/intro|background/i.test(name)) return "intro";
  return "other";
}

function fromLegacy(article: LegacyArticle): ArticleSet {
  const doi = doiOf(article.doi);
  const pmid = String(article.pmid ?? "").trim();
  const sections = article.sections.map((s) => ({
    ...s, paragraphs: paragraphs(s.content),
    subsections: (s.subsections ?? []).map((sub) => ({ ...sub, paragraphs: paragraphs(sub.content) })),
  }));
  return {
    id: RXFP1_ARTICLE_PREFIX + article.citekey, title: article.title,
    authors: Array.isArray(article.authors) ? article.authors : [],
    year: String(article.published ?? "").match(/\b\d{4}\b/)?.[0] ?? "",
    journal: article.source ?? "", doi, pmid, createdAt: "",
    sourceUrl: doi ? `https://doi.org/${doi}` : /^\d+$/.test(pmid) ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : "",
    articleType: article.is_review === undefined ? null : article.is_review ? "review" : "original",
    extractionSource: "rxfp1-legacy-json", sections,
    chunkCount: sections.reduce((n, s) =>
      n + s.paragraphs.length + s.subsections.reduce((total, sub) => total + sub.paragraphs.length, 0), 0),
  };
}

function readLegacyArticles(file: string): ArticleSet[] {
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as { articles: LegacyArticle[] };
  if (!Array.isArray(data.articles)) throw new Error("Invalid RXFP1 bibliography.");
  return data.articles
    .filter((a) => a && typeof a.citekey === "string" && CITEKEY.test(a.citekey) &&
      typeof a.title === "string" && a.title.trim() && Array.isArray(a.sections))
    .map(fromLegacy);
}

function markdownSections(body: string): LegacySection[] {
  const sections: LegacySection[] = [];
  let section: LegacySection = { title: "Main Text", type: "other", content: "", subsections: [] };
  let target: { title: string; content: string } = section;
  sections.push(section);
  for (const line of body.split(/\r?\n/)) {
    const heading = line.match(/^(#{2,3})\s+(.+?)\s*$/);
    if (heading?.[1] === "##") {
      section = { title: heading[2], type: sectionType(heading[2]), content: "", subsections: [] };
      sections.push(section);
      target = section;
    } else if (heading?.[1] === "###") {
      target = { title: heading[2], content: "" };
      section.subsections!.push(target);
    } else if (!/^\s*%%.*%%\s*$/.test(line)) {
      target.content += line + "\n";
    }
  }
  return sections.filter((s) => s.content.trim() || s.subsections?.some((sub) => sub.content.trim()));
}

export function parseRxfp1Markdown(markdown: string, fileKey: string, existing?: ArticleSet): ArticleSet | null {
  const top = markdown.match(frontmatter);
  const metadata = (top ? yaml.load(top[1], { schema: yaml.JSON_SCHEMA }) : {}) as Record<string, unknown> | null;
  if (metadata?.citekey && metadata.citekey !== fileKey) return null;
  if (!CITEKEY.test(fileKey)) return null;
  const main = markdown.match(/^#\s+4\s+Main Text[ \t]*\r?\n([\s\S]*?)(?=^#\s|$(?![\s\S]))/im);
  const mainBody = (main?.[1] ?? "").replace(frontmatter, "").trim();
  const sections = markdownSections(mainBody);
  if (!sections.some((section) => section.type === "abstract" && section.content.trim())) {
    const beforeMain = main?.index === undefined ? markdown : markdown.slice(0, main.index);
    const callout = beforeMain.match(/^>\s*\[!Abstract\][^\r\n]*((?:\r?\n>[^\r\n]*)*)/im)?.[1] ?? "";
    const content = callout.replace(/^>[ \t]?/gm, "").trim();
    if (content) sections.unshift({ title: "Abstract", type: "abstract", content });
  }
  const info = markdown.match(/^>\s*\[!Info\][^\r\n]*(?:\r?\n>[^\r\n]*)*/im)?.[0] ?? "";
  const infoField = (key: string) => info.match(new RegExp(`\\*\\*${key}\\*\\*:\\s*([^\\r\\n]+)`, "i"))?.[1].trim() ?? "";
  const title = String(metadata?.title ?? infoField("Title")).trim() || existing?.title;
  if (!title) return null;
  const doi = doiOf(metadata?.doi ?? infoField("DOI"));
  const pmid = String(metadata?.pmid ?? "").trim();
  if ((existing?.doi && doi && doi.toLowerCase() !== existing.doi.toLowerCase()) ||
      (existing?.pmid && pmid && pmid !== existing.pmid)) return null;
  const authors = Array.isArray(metadata?.authors) ? metadata.authors.filter((author): author is string => typeof author === "string")
    : Array.from(info.matchAll(/\*\*(?:First)?Author\*\*::\s*([^>\r\n]+)/gi), (m) => m[1].trim());
  const tags = Array.isArray(metadata?.tags) ? metadata.tags : [metadata?.tags];
  const parsed = fromLegacy({
    citekey: fileKey, title: existing?.title || title,
    authors: existing?.authors.length ? existing.authors : authors,
    doi: existing?.doi || doi,
    pmid: existing?.pmid || pmid,
    published: existing?.year || String(metadata?.year ?? infoField("Year")),
    source: existing?.journal || String(metadata?.journal ?? infoField("Journal")),
    is_review: existing?.articleType ? existing.articleType === "review"
      : tags.some((tag) => String(tag).toLowerCase() === "review") ? true : undefined,
    sections,
  });
  parsed.extractionSource = "rxfp1-markdown";
  return parsed;
}

function hasBody(set: ArticleSet) {
  return set.sections.some((section) => isRxfp1Body(section.type, section.title) &&
    (section.paragraphs.length || section.subsections.some((sub) => sub.paragraphs.length)));
}

function workKeys(set: ArticleSet): string[] {
  return [set.doi && `doi:${set.doi.toLowerCase()}`, set.pmid && /^\d+$/.test(set.pmid) && `pmid:${set.pmid}`]
    .filter((value): value is string => Boolean(value));
}

export function fileStamp(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return "";
  }
}

let cached: { stamp: string; articles: Map<string, ArticleSet>; errors: string[] } | undefined;

export function loadRxfp1Corpus() {
  const { rxfp1Articles: file, rxfp1MarkdownDir: dir } = PATHS;
  const errors: string[] = [];
  const structured = fileStamp(file);
  const markdownFiles: string[] = [];
  try {
    markdownFiles.push(...fs.readdirSync(dir).filter((name) => name.endsWith(".md")).sort());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push("Could not list the RXFP1 Markdown folder.");
  }
  const stamp = JSON.stringify([structured, errors, markdownFiles.map((name) => [name, fileStamp(path.join(dir, name))])]);
  if (cached?.stamp === stamp) return cached;
  const articles = new Map<string, ArticleSet>();
  const idsByWork = new Map<string, string>();
  function remember(article: ArticleSet) {
    articles.set(article.id, article);
    for (const key of workKeys(article)) idsByWork.set(key, article.id);
  }
  if (structured) {
    try {
      for (const article of readLegacyArticles(file)) remember(article);
    } catch {
      errors.push("Could not read the RXFP1 structured bibliography.");
    }
  }
  for (const name of markdownFiles) {
    const key = path.basename(name, ".md");
    const id = RXFP1_ARTICLE_PREFIX + key;
    const current = articles.get(id);
    if (current && hasBody(current)) continue;
    try {
      const parsed = parseRxfp1Markdown(fs.readFileSync(path.join(dir, name), "utf8"), key, current);
      if (!parsed) continue;
      const existingId = workKeys(parsed).map((work) => idsByWork.get(work)).find(Boolean);
      const existing = current ?? (existingId ? articles.get(existingId) : undefined);
      if (existing && (hasBody(existing) ||
        (!hasBody(parsed) && !parsed.sections.some((section) => section.type === "abstract")))) continue;
      remember(existing ? {
        ...parsed, id: existing.id, title: existing.title, authors: existing.authors.length ? existing.authors : parsed.authors,
        articleType: existing.articleType ?? parsed.articleType,
      } : parsed);
    } catch {
      errors.push(`Could not read RXFP1 note ${name}.`);
    }
  }
  cached = { stamp, articles, errors };
  return cached;
}

export function listRxfp1Articles() {
  return [...loadRxfp1Corpus().articles.values()].map((set) => ({
    id: set.id, title: set.title, authors: set.authors, year: set.year, sourceUrl: set.sourceUrl,
    doi: set.doi, articleType: set.articleType, createdAt: set.createdAt, chunkCount: set.chunkCount, searchable: hasBody(set),
  })).sort((a, b) => a.title.localeCompare(b.title));
}
