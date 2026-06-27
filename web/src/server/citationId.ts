import fs from "node:fs";

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
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleTag(html: string): string {
  return stripTags(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
}

function metaContent(html: string, name: string): string {
  return stripTags(html.match(new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, "i"))?.[1] ?? "");
}

function citationAuthors(html: string): string[] {
  return Array.from(html.matchAll(/<meta[^>]+name=["']citation_author["'][^>]+content=["']([^"']+)["'][^>]*>/gi))
    .map((m) => stripTags(m[1] ?? ""))
    .filter(Boolean);
}

function yearFromHtml(html: string): string {
  const title = titleTag(html);
  return (
    metaContent(html, "citation_publication_date").match(/\d{4}/)?.[0] ??
    title.match(/\b(19|20)\d{2}\b/)?.[0] ??
    ""
  );
}

function firstAuthorFromTitle(html: string, articleTitle: string): string {
  const title = titleTag(html);
  if (!title) return "";
  const tail = title.startsWith(articleTitle) ? title.slice(articleTitle.length) : title;
  const afterDash = tail.match(/-\s*([^,]+)/)?.[1] ?? "";
  return afterDash.replace(/\b(19|20)\d{2}\b.*$/, "").trim();
}

function authorLooksComplete(author: string): boolean {
  const words = author.split(/\s+/).filter(Boolean);
  return author.includes(",") || words.length >= 2;
}

function surname(author: string): string {
  const normalized = author.replace(/([a-z])([A-Z])/g, "$1 $2");
  const noDegrees = normalized.replace(/\b(MD|PhD|MSc|FRCS|MBA|DO|DDS|DVM)\b\.?/gi, "").trim();
  const candidate = noDegrees.includes(",") ? noDegrees.split(",")[0] : noDegrees.split(/\s+/).at(-1);
  return (candidate ?? "").replace(/[^A-Za-z0-9-]/g, "");
}

function capitalizeIdPart(value: string): string {
  if (!value) return "";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function citationBaseId(html: string, articleTitle: string, fallback: string): string {
  const authors = citationAuthors(html);
  const firstAuthor = authors.find(authorLooksComplete) || firstAuthorFromTitle(html, articleTitle);
  const author = capitalizeIdPart(surname(firstAuthor));
  const year = yearFromHtml(html);
  const base = author && year ? `${author}${year}` : fallback;
  return base.replace(/[^A-Za-z0-9_.-]/g, "") || "Article";
}

export function uniqueJsonId(outputDir: string, baseId: string): string {
  let id = baseId;
  let n = 2;
  while (fs.existsSync(`${outputDir}/${id}.json`)) {
    id = `${baseId}-${n}`;
    n += 1;
  }
  return id;
}
