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

// <sub> はタグ除去でスペース化されると "H 2 O 2" のように壊れるため、
// 先にUnicodeの下付き文字へ変換する。<sup> は本文中の引用上付き番号なので除去する。
const SUBSCRIPT_MAP: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "−": "₋", "=": "₌", "(": "₍", ")": "₎",
};
function convertSub(s: string): string {
  return s.replace(/<sub\b[^>]*>([\s\S]*?)<\/sub>/gi, (_m, inner: string) =>
    Array.from(inner.replace(/<[^>]+>/g, ""))
      .map((ch) => SUBSCRIPT_MAP[ch] ?? ch)
      .join(""),
  );
}

function stripTags(s: string): string {
  return convertSub(decodeHtmlEntities(s))
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
  if (t.includes("outline") || t.includes("cited by") || t.includes("article metrics") || t.includes("recommended articles") || t.includes("keywords") || t.includes("cookie")) return "excluded";
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
  const title = stripTags(citationTitle ?? h1 ?? titleTag ?? fallback).slice(0, 260);
  return title.replace(/\s*-\s*ScienceDirect$/i, "").trim();
}

function inferAuthors(html: string): string[] {
  const metas = Array.from(html.matchAll(/<meta[^>]+name=["']citation_author["'][^>]+content=["']([^"']+)["'][^>]*>/gi))
    .map((m) => stripTags(m[1] ?? ""))
    .filter(Boolean);
  if (metas.length) return metas;

  const sdMatches = Array.from(
    html.matchAll(/<span\b[^>]*class=["'][^"']*given-name[^"']*["'][^>]*>([\s\S]*?)<\/span>\s*<span\b[^>]*class=["'][^"']*surname[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi),
  )
    .map((m) => `${stripTags(m[1])} ${stripTags(m[2])}`.trim())
    .filter(Boolean);
  if (sdMatches.length) return sdMatches;

  return Array.from(html.matchAll(/<span\b[^>]+property=["']author["'][^>]*>([\s\S]*?)<\/span>/gi))
    .map((m) => stripTags(m[1] ?? "").replace(/,\s*(MSc|MD|PhD|FRCS|MBA)\b.*$/i, ""))
    .filter(Boolean);
}

function inferMeta(html: string, sourceUrl: string) {
  const meta = (name: string) =>
    stripTags(html.match(new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, "i"))?.[1] ?? "");
  const doi = meta("citation_doi") || meta("dc.identifier") || sourceUrl.match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i)?.[0] || "";
  const year = meta("citation_publication_date").match(/\d{4}/)?.[0] ?? "";
  return {
    journal: meta("citation_journal_title"),
    year,
    doi: doi.toLowerCase(),
  };
}

function inferAbstractParagraphs(html: string): string[] {
  // 1. Try to extract from known abstract sections in body
  const abstractIds = ["abstract", "abstracts", "structured-abstract", "editor-abstract", "abstract-content", "author-highlights"];
  for (const id of abstractIds) {
    const match = html.match(new RegExp(`<section\\b[^>]*(?:id=["']${id}["']|class=["'][^"']*${id}[^"']*["'])[^>]*>([\\s\\S]*?)<\\/section>`, "i"))
      || html.match(new RegExp(`<div\\b[^>]*(?:id=["']${id}["']|class=["'][^"']*${id}[^"']*["'])[^>]*>([\\s\\S]*?)<\\/div>`, "i"));
    if (match) {
      const inner = match[1].replace(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi, ""); // Remove heading
      const paras = paragraphTexts(inner);
      if (paras.length) return paras;
    }
  }

  // 2. Original fallback logic: look for text "Abstract" block markers
  const blocks = Array.from(html.matchAll(/<(h[1-4]|p|div)\b[^>]*>([\s\S]*?)<\/\1>/gi)).map((m) => ({
    tag: (m[1] ?? "").toLowerCase(),
    html: m[0] ?? "",
    text: stripTags(m[2] ?? ""),
    start: m.index ?? 0,
    end: (m.index ?? 0) + (m[0] ?? "").length,
  }));
  const marker = blocks.find((block) => /^abstract:?$/i.test(block.text));
  if (marker) {
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
    if (paragraphs.length) return paragraphs;
  }

  // 3. Metadata fallback (only if no full text abstract is found)
  const metaAbstract =
    stripTags(
      html.match(/<meta[^>]+(?:name|property)=["'](?:citation_abstract|dc\.description|og:description|description)["'][^>]+content=["']([^"']+)["'][^>]*>/i)?.[1] ?? "",
    );
  if (metaAbstract) return [metaAbstract];

  return [];
}

function inferFigureSections(html: string): ArticleSection[] {
  // 1. Try extracting actual <figure> elements from the document
  const figures: ArticleSection[] = [];
  const figMatches = Array.from(html.matchAll(/<figure\b([^>]*?)>([\s\S]*?)<\/figure>/gi));
  
  if (figMatches.length > 0) {
    for (const m of figMatches) {
      const attrs = m[1];
      const content = m[2];
      
      const idMatch = attrs.match(/id=["']([^"']+)["']/i);
      const id = idMatch ? idMatch[1] : "";
      
      const imgMatch = content.match(/<img\b[^>]*?src=["']([^"']+)["']/i);
      const imageUrl = imgMatch ? imgMatch[1] : "";
      
      const figcaptionMatch = content.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i);
      let legend = "";
      let title = "";
      
      if (figcaptionMatch) {
        const figcaptionContent = figcaptionMatch[1];
        const titleMatch = figcaptionContent.match(/<span\b[^>]*class=["']heading["'][^>]*>([\s\S]*?)<\/span>/i)
          || figcaptionContent.match(/<strong\b[^>]*>([\s\S]*?)<\/strong>/i)
          || figcaptionContent.match(/<b>([\s\S]*?)<\/b>/i);
        
        if (titleMatch) {
          title = stripTags(titleMatch[1]).replace(/[.\s]+$/g, "").trim();
        }
        legend = stripTags(figcaptionContent);
      }
      
      if (!title) {
        title = id ? `Figure ${id}` : "Figure";
      }

      // Skip figure elements that actually represent tables
      const isTableFigure = 
        /\btable\b/i.test(attrs) ||
        /^T\d+/i.test(id) ||
        /^table\b/i.test(title) ||
        /<table\b/i.test(content);
      if (isTableFigure) continue;

      // Normalize "Fig. 1" to "Figure 1" for consistent frontend matching
      title = title.replace(/^fig\b\.?/i, "Figure").trim();
      
      if (!legend) {
        legend = stripTags(content);
      }
      
      const contentText = imageUrl ? `[Image URL: ${imageUrl}]\n\n${legend}` : legend;
      
      figures.push({
        title,
        type: "figure",
        content: contentText,
        paragraphs: [contentText],
        subsections: [],
      });
    }
    return figures;
  }

  // 2. Fallback to old marker-based logic for document structures without <figure> tags
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
  const bodyStart = html.search(/<(?:section|div)\b[^>]*(?:id=["'](?:bodymatter|body)["']|class=["'][^"']*(?:Body|article-body)[^"']*["']|property=["']articleBody["'])/i);
  if (bodyStart >= 0) {
    rest = html.slice(bodyStart);
  } else {
    const abstractEnd = html.search(/<\/section>\s*<\/section>[\s\S]{0,200}<section\b[^>]*id=["']bodymatter/i);
    if (abstractEnd >= 0) rest = html.slice(abstractEnd);
  }

  const end = rest.search(/<h[2-4]\b[^>]*>(?:<[^>]+>|\s)*(?:Acknowledg|Competing\s+Interests|Conflict\s+of\s+Interest|Funding|Author\s+Contributions|Data\s+Availability|ORCID|Footnote|References|Supplementary\s+Material|Article Metrics|Recommended articles)\b/i);
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

function stripTagsNoTable(s: string): string {
  return convertSub(decodeHtmlEntities(s))
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<sup\b[\s\S]*?<\/sup>/gi, " ")
    .replace(/<figcaption\b[\s\S]*?<\/figcaption>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function convertTableToMarkdown(tableHtml: string): string {
  const rows = Array.from(tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi));
  if (rows.length === 0) return "";

  const markdownRows: string[] = [];
  let colCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const rowContent = rows[i][1];
    const cells = Array.from(rowContent.matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi))
      .map(m => stripTagsNoTable(m[2]));
    
    if (cells.length === 0) continue;
    if (cells.length > colCount) colCount = cells.length;

    const mdLine = "| " + cells.join(" | ") + " |";
    markdownRows.push(mdLine);

    if (i === 0) {
      const sep = "| " + Array(cells.length).fill("---").join(" | ") + " |";
      markdownRows.push(sep);
    }
  }

  return markdownRows.join("\n");
}

function paragraphTexts(html: string): string[] {
  const items: { index: number; text: string }[] = [];
  const processedRanges: [number, number][] = [];

  const paraMatches = Array.from(
    html.matchAll(/<(?:div|p)\b[^>]*(?:role=["']paragraph["']|class=["'][^"']*(?:paragraph|para)[^"']*["'])[^>]*>([\s\S]*?)<\/(?:div|p)>|<p\b[^>]*>([\s\S]*?)<\/p>/gi)
  );
  for (const m of paraMatches) {
    const text = stripTags(m[1] || m[2] || "");
    if (text && !isBoilerplateParagraph(text)) {
      items.push({ index: m.index ?? 0, text });
    }
  }

  // Extract <figure> elements that represent tables (including their <figcaption>)
  const figTableMatches = Array.from(html.matchAll(/<figure\b([^>]*?)>([\s\S]*?)<\/figure>/gi));
  for (const m of figTableMatches) {
    const attrs = m[1];
    const content = m[2];
    const isTable = /\btable\b/i.test(attrs) || /<table\b/i.test(content) || /^T\d+/i.test(attrs);
    if (!isTable) continue;

    const start = m.index ?? 0;
    const end = start + m[0].length;
    processedRanges.push([start, end]);

    const tableMatch = content.match(/<table\b[^>]*>([\s\S]*?)<\/table>/i);
    const figcaptionMatch = content.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i);

    const captionText = figcaptionMatch ? stripTagsNoTable(figcaptionMatch[1]) : "";
    const tableMd = tableMatch ? convertTableToMarkdown(tableMatch[0]) : "";

    if (tableMd) {
      const fullText = captionText ? `**${captionText}**\n\n${tableMd}` : tableMd;
      items.push({ index: start, text: fullText });
    }
  }

  // Extract any remaining standalone <table> elements
  const tableMatches = Array.from(html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi));
  for (const m of tableMatches) {
    const start = m.index ?? 0;
    if (processedRanges.some(([rStart, rEnd]) => start >= rStart && start <= rEnd)) {
      continue;
    }
    const md = convertTableToMarkdown(m[0]);
    if (md) {
      items.push({ index: start, text: md });
    }
  }

  items.sort((a, b) => a.index - b.index);
  const results = items.map(item => item.text);

  if (results.length) return results;

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

  if (sections.length === 0 || (sections.length === 1 && sections[0].type === "abstract")) {
    const mainParas = paragraphTexts(body);
    const abstractSet = new Set(sections[0]?.paragraphs || []);
    const remainingParas = mainParas.filter((p) => !abstractSet.has(p));
    if (remainingParas.length) {
      sections.push({
        title: "Main Text",
        type: "other",
        content: remainingParas.join("\n\n"),
        paragraphs: remainingParas,
        subsections: [],
      });
    }
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
