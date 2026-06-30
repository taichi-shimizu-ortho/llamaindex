import fs from "node:fs";
import path from "node:path";
import { citationBaseId, uniqueJsonId } from "./citationId.js";
import { PATHS } from "./config.js";

const EXCLUDED_SECTION_TYPES = new Set(["references", "acknowledgements"]);

export interface ArticleSubsection {
  title: string;
  content: string;
  paragraphs: string[];
}

export interface ArticleSection {
  title: string;
  type: string;
  content: string;
  paragraphs: string[];
  subsections: ArticleSubsection[];
}

export interface ArticleSet {
  id: string;
  sourceUrl: string;
  title: string;
  authors: string[];
  journal: string;
  year: string;
  doi: string;
  createdAt: string;
  sections: ArticleSection[];
  chunkCount: number;
}

export interface ArticleHarvestOptions {
  sourceUrl?: string;
  html?: string;
  title?: string;
}

function ensureOutputDir() {
  fs.mkdirSync(PATHS.articleOutputDir, { recursive: true });
}

function decodeHtmlEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return s
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (match, code: string) => {
      const value = code.toLowerCase().startsWith("x")
        ? Number.parseInt(code.slice(1), 16)
        : Number.parseInt(code, 10);
      return Number.isFinite(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : match;
    })
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

function stripTags(s: string): string {
  return decodeHtmlEntities(s)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<sup\b[\s\S]*?<\/sup>/gi, " ")
    .replace(/<table\b[\s\S]*?<\/table>/gi, " ")
    .replace(/<figcaption\b[\s\S]*?<\/figcaption>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function attr(tag: string, name: string): string {
  const re = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i");
  return decodeHtmlEntities(tag.match(re)?.[1]?.trim() ?? "");
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "article";
}

function classifySection(title: string): string {
  const t = title.toLowerCase().replace(/:$/, "").trim();
  if (t.includes("method") || t.includes("material") || t.includes("study design")) return "materials|methods";
  if (t.includes("result")) return "results";
  if (t.includes("discussion")) return "discussion";
  if (t.includes("conclusion")) return "conclusion";
  if (t.includes("introduction") || t === "intro") return "intro";
  if (t.includes("abstract")) return "abstract";
  if (t.includes("reference")) return "references";
  if (t.includes("acknowledg")) return "acknowledgements";
  return "other";
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": "llamaindex-article-web/1.0" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

function inferTitle(html: string, fallback = ""): string {
  const citationTitle = html.match(/<meta[^>]+name=["']citation_title["'][^>]+content=["']([^"']+)["']/i)?.[1];
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const titleTag = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return stripTags(citationTitle ?? h1 ?? titleTag ?? fallback).slice(0, 260);
}

function inferAuthors(html: string): string[] {
  const metas = Array.from(html.matchAll(/<meta[^>]+name=["']citation_author["'][^>]+content=["']([^"']+)["'][^>]*>/gi))
    .map((m) => stripTags(m[1] ?? ""))
    .filter(Boolean);
  if (metas.length) return metas;

  return Array.from(html.matchAll(/<span\b[^>]+property=["']author["'][^>]*>([\s\S]*?)<\/span>/gi))
    .map((m) => stripTags(m[1] ?? "").replace(/,\s*(MSc|MD|PhD|FRCS|MBA)\b.*$/i, ""))
    .filter(Boolean);
}

function inferMeta(html: string, sourceUrl: string) {
  const meta = (name: string) =>
    stripTags(html.match(new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, "i"))?.[1] ?? "");
  const doi = meta("citation_doi") || sourceUrl.match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i)?.[0] || "";
  const year = meta("citation_publication_date").match(/\d{4}/)?.[0] ?? "";
  return {
    journal: meta("citation_journal_title"),
    year,
    doi: doi.toLowerCase(),
  };
}

function inferAbstractParagraphs(html: string): string[] {
  const metaAbstract =
    stripTags(
      html.match(/<meta[^>]+name=["'](?:citation_abstract|dc\.description|description)["'][^>]+content=["']([^"']+)["'][^>]*>/i)?.[1] ?? "",
    );
  if (metaAbstract) return [metaAbstract];

  const blocks = Array.from(html.matchAll(/<(h[1-4]|p|div)\b[^>]*>([\s\S]*?)<\/\1>/gi)).map((m) => ({
    tag: (m[1] ?? "").toLowerCase(),
    html: m[0] ?? "",
    text: stripTags(m[2] ?? ""),
    start: m.index ?? 0,
    end: (m.index ?? 0) + (m[0] ?? "").length,
  }));
  const marker = blocks.find((block) => /^abstract:?$/i.test(block.text));
  if (!marker) return [];

  const rest = html.slice(marker.end);
  const paragraphs: string[] = [];
  for (const match of rest.matchAll(/<(h[1-4]|p|div)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const tag = (match[1] ?? "").toLowerCase();
    const text = stripTags(match[2] ?? "");
    if (!text) continue;
    if (/^h[1-4]$/.test(tag)) break;
    if (/^(?:keywords?|key words?|mini review|article type|introduction|background|references?)\b/i.test(text)) break;
    paragraphs.push(text);
  }

  return paragraphs;
}

function inferFigureSections(html: string): ArticleSection[] {
  const marker = html.match(/<p\b[^>]*>\s*(?:<(?:strong|b)\b[^>]*>\s*)?Figure\s+legends?(?:\s*<\/(?:strong|b)>)?\s*<\/p>/i);
  if (!marker || marker.index == null) return [];

  const rest = html.slice(marker.index + marker[0].length);
  const blocks = Array.from(rest.matchAll(/<(h[1-4]|p|div)\b[^>]*>([\s\S]*?)<\/\1>/gi))
    .map((m) => ({
      tag: (m[1] ?? "").toLowerCase(),
      text: stripTags(m[2] ?? ""),
    }))
    .filter((block) => block.text);

  const sections: ArticleSection[] = [];
  let current: ArticleSection | null = null;

  for (const block of blocks) {
    if (/^h[1-4]$/.test(block.tag) || /^(?:References?|Acknowledg|Funding|Conflict)\b/i.test(block.text)) break;
    const figureTitle = block.text.match(/^(Figure\s+\d+[A-Za-z]?\.?\s*)(.*)/i);

    if (figureTitle) {
      if (current) sections.push(current);
      const title = figureTitle[1].replace(/[.\s]+$/g, "").trim();
      const firstLegend = figureTitle[2]?.trim();
      current = {
        title,
        type: "figure",
        content: firstLegend,
        paragraphs: firstLegend ? [firstLegend] : [],
        subsections: [],
      };
      continue;
    }

    if (current) {
      current.paragraphs.push(block.text);
      current.content = current.paragraphs.join("\n\n");
    }
  }

  if (current) sections.push(current);
  return sections;
}

function bodyMatter(html: string): string {
  let rest = html;
  const bodyStart = html.search(/<section\b[^>]*(?:id=["']bodymatter["']|property=["']articleBody["'])/i);
  if (bodyStart >= 0) {
    rest = html.slice(bodyStart);
  } else {
    const abstractEnd = html.search(/<\/section>\s*<\/section>[\s\S]{0,200}<section\b[^>]*id=["']bodymatter/i);
    if (abstractEnd >= 0) rest = html.slice(abstractEnd);
  }

  const end = rest.search(/<h2\b[^>]*>(?:<[^>]+>|\s)*(?:Acknowledg|Competing\s+Interests|Conflict\s+of\s+Interest|Funding|Author\s+Contributions|Data\s+Availability|ORCID|Footnote|References|Supplementary\s+Material)\b/i);
  return rest.slice(0, end > 0 ? end : undefined);
}

function headingMarkers(html: string) {
  return Array.from(html.matchAll(/<h([2-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi))
    .map((m) => ({
      level: Number(m[1]),
      title: stripTags(m[2] ?? ""),
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
    }))
    .filter((h) => h.title);
}

function isBoilerplateParagraph(text: string): boolean {
  const t = text.trim();
  return /^https?:\/\/(?:dx\.)?doi\.org\/10\.\d{4,9}\/\S+\s+Digital Object Identifier \(DOI\)$/i.test(t);
}

function paragraphTexts(html: string): string[] {
  const paragraphs = Array.from(
    html.matchAll(/<(?:div|p)\b[^>]*(?:role=["']paragraph["']|class=["'][^"']*(?:paragraph|para)[^"']*["'])[^>]*>([\s\S]*?)<\/(?:div|p)>|<p\b[^>]*>([\s\S]*?)<\/p>/gi)
  )
    .map((m) => stripTags(m[1] || m[2] || ""))
    .filter((text) => text && !isBoilerplateParagraph(text));

  if (paragraphs.length) return paragraphs;

  const fallback = stripTags(html);
  return fallback && !isBoilerplateParagraph(fallback) ? [fallback] : [];
}

function sectionContent(html: string): string {
  return paragraphTexts(html).join("\n\n");
}

export function buildSections(html: string): ArticleSection[] {
  const body = bodyMatter(html);
  const headings = headingMarkers(body);
  const h2s = headings.filter((h) => h.level === 2);
  const top = headings.filter((h) => h.level === 2 && !EXCLUDED_SECTION_TYPES.has(classifySection(h.title)));
  const methods = top.find((h) => classifySection(h.title) === "materials|methods");
  const hasIntroHeading = top.some((h) => classifySection(h.title) === "intro");
  const sections: ArticleSection[] = [];
  const abstractParas = inferAbstractParagraphs(html);
  const figureSections = inferFigureSections(html);

  if (abstractParas.length && !top.some((h) => classifySection(h.title) === "abstract")) {
    sections.push({
      title: "Abstract",
      type: "abstract",
      content: abstractParas.join("\n\n"),
      paragraphs: abstractParas,
      subsections: [],
    });
  }

  if (!hasIntroHeading && methods && methods.start > 0) {
    const introHtml = body.slice(0, methods.start);
    const introParas = paragraphTexts(introHtml);
    if (introParas.length) {
      sections.push({
        title: "Introduction",
        type: "intro",
        content: introParas.join("\n\n"),
        paragraphs: introParas,
        subsections: [],
      });
    }
  }

  for (let i = 0; i < top.length; i += 1) {
    const h = top[i];
    const next = h2s.find((nextH) => nextH.start > h.start)?.start ?? body.length;
    const block = body.slice(h.end, next);
    const subHeads = headingMarkers(block).filter((sub) => sub.level === 3 || sub.level === 4);
    const firstSub = subHeads[0]?.start ?? -1;
    const mainHtml = firstSub >= 0 ? block.slice(0, firstSub) : block;
    const mainParas = paragraphTexts(mainHtml);
    const subsections: ArticleSubsection[] = [];
    let parentSubsection = "";

    for (let j = 0; j < subHeads.length; j += 1) {
      const sub = subHeads[j];
      const nextSub = subHeads[j + 1]?.start ?? block.length;
      const subBlock = block.slice(sub.end, nextSub);
      const subParas = paragraphTexts(subBlock);
      if (sub.level === 3) parentSubsection = sub.title.replace(/:$/, "");
      const title = sub.level === 4 && parentSubsection
        ? `${parentSubsection} > ${sub.title.replace(/:$/, "")}`
        : sub.title.replace(/:$/, "");
      if (!subParas.length) continue;
      subsections.push({
        title,
        content: subParas.join("\n\n"),
        paragraphs: subParas,
      });
    }

    sections.push({
      title: h.title,
      type: classifySection(h.title),
      content: mainParas.join("\n\n"),
      paragraphs: mainParas,
      subsections,
    });
  }

  sections.push(...figureSections);

  return sections.filter((section) => section.paragraphs.length || section.subsections.some((sub) => sub.paragraphs.length));
}

export function articleSetPath(id: string): string {
  return path.join(PATHS.articleOutputDir, `${id}.json`);
}

export function loadArticleSet(id: string): ArticleSet {
  const safeId = id.replace(/[^a-zA-Z0-9_.-]/g, "");
  return JSON.parse(fs.readFileSync(articleSetPath(safeId), "utf-8")) as ArticleSet;
}

export function listArticleSets() {
  if (!fs.existsSync(PATHS.articleOutputDir)) return [];
  return fs
    .readdirSync(PATHS.articleOutputDir)
    .filter((f) => f.endsWith(".json"))
    .map((file) => {
      const set = JSON.parse(fs.readFileSync(path.join(PATHS.articleOutputDir, file), "utf-8")) as ArticleSet;
      return {
        id: set.id,
        title: set.title,
        sourceUrl: set.sourceUrl,
        chunkCount: set.chunkCount,
        createdAt: set.createdAt,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function harvestArticle(options: ArticleHarvestOptions): Promise<ArticleSet> {
  if (!options.sourceUrl && !options.html) throw new Error("Enter a URL or HTML");
  const sourceUrl = options.sourceUrl?.trim() ?? "";
  const html = options.html ?? (await fetchText(sourceUrl));
  const title = options.title?.trim() || inferTitle(html, sourceUrl);
  const meta = inferMeta(html, sourceUrl);
  const sections = buildSections(html);
  if (!sections.length) throw new Error("Could not extract body sections");

  const id = uniqueJsonId(PATHS.articleOutputDir, citationBaseId(html, title, slugify(title || sourceUrl)));
  const set: ArticleSet = {
    id,
    sourceUrl,
    title,
    authors: inferAuthors(html),
    journal: meta.journal,
    year: meta.year,
    doi: meta.doi,
    createdAt: new Date().toISOString(),
    sections,
    chunkCount: sections.reduce(
      (sum, section) => sum + section.paragraphs.length + section.subsections.reduce((n, sub) => n + sub.paragraphs.length, 0),
      0,
    ),
  };

  ensureOutputDir();
  fs.writeFileSync(articleSetPath(id), JSON.stringify(set, null, 2), "utf-8");
  return set;
}
