import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./config.js";

const ENTREZ_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const TOOL = "llamaindex-reference-web";
const EMAIL = process.env.NCBI_EMAIL ?? process.env.ENTREZ_EMAIL ?? "taichi_shimizu@med.uoeh-u.ac.jp";
let lastEntrezRequestAt = 0;

export interface ReferenceRecord {
  index: number;
  text: string;
  sourceUrl: string;
  href: string;
  doi: string;
  pmid: string;
  pubmedFound: boolean;
  pubmed?: {
    pmid: string;
    doi: string;
    title: string;
    abstract: string;
    authors: string[];
    journal: string;
    year: string;
    publicationTypes: string[];
    source?: string;
  };
  error?: string;
}

export interface ReferenceSet {
  id: string;
  sourceUrl: string;
  title: string;
  createdAt: string;
  totalReferences: number;
  pubmedFound: number;
  abstractFound: number;
  records: ReferenceRecord[];
}

export interface HarvestOptions {
  sourceUrl?: string;
  html?: string;
  title?: string;
  limit?: number;
}

function ensureOutputDir() {
  fs.mkdirSync(PATHS.referenceOutputDir, { recursive: true });
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
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntityStrings<T>(value: T): T {
  if (typeof value === "string") return decodeHtmlEntities(value) as T;
  if (Array.isArray(value)) return value.map((item) => decodeEntityStrings(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, decodeEntityStrings(item)]),
    ) as T;
  }
  return value;
}

function attr(tag: string, name: string): string {
  const re = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i");
  return tag.match(re)?.[1]?.trim() ?? "";
}

function absoluteUrl(href: string, base: string): string {
  try {
    return new URL(href, base || "https://example.org").toString();
  } catch {
    return href;
  }
}

function extractDoi(text: string): string {
  let decoded = text;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    decoded = text;
  }
  const doi = decoded.match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i)?.[0] ?? "";
  return doi.replace(/[)\].,;]+$/g, "");
}

function extractPmid(text: string): string {
  return (
    text.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i)?.[1] ??
    text.match(/ncbi\.nlm\.nih\.gov\/pubmed\/(\d+)/i)?.[1] ??
    text.match(/\bPMID[:\s]+(\d{5,})\b/i)?.[1] ??
    ""
  );
}

function cleanReferenceText(text: string): string {
  return text
    .replace(/\b(Google Scholar|CrossRef|PubMed|Article|CAS|PubMed Central|DOI|View Article)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferTitle(html: string, fallback = ""): string {
  const citationTitle = html.match(/<meta[^>]+name=["']citation_title["'][^>]+content=["']([^"']+)["']/i)?.[1];
  const dcTitle = html.match(/<meta[^>]+name=["'](?:dc\.title|DC\.Title)["'][^>]+content=["']([^"']+)["']/i)?.[1];
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1];
  const titleTag = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  return stripTags(citationTitle ?? dcTitle ?? ogTitle ?? titleTag ?? fallback).slice(0, 220);
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "reference-set";
}

function findReferenceRegions(html: string): string[] {
  const regions = [html];
  const patterns = [
    /<(?:h2|h3|h4)[^>]*>\s*(?:References?|Bibliography|Cited Literature)\s*<\/(?:h2|h3|h4)>/gi,
    /<(?:section|div|ol|ul)[^>]*(?:id|class)=["'][^"']*(?:references?|bibliography|ref-list|citation-list|cited-literature)[^"']*["'][^>]*>/gi,
    /\b(?:References?|Bibliography|Cited Literature)\b/gi,
  ];

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const start = Math.max(0, (match.index ?? 0) - 1000);
      const rest = html.slice(start);
      const afterMarker = Math.max(1000, (match.index ?? 0) - start + 1000);
      const tail = rest.slice(afterMarker);
      const nextMainHeading = tail.search(/<h[12]\b[^>]*>/i);
      const supplementaryHeading = tail.search(/<h[1-4]\b[^>]*>\s*(?:Supplementary Material|Supplemental Material|Supporting Information)\b/i);
      const candidates = [nextMainHeading, supplementaryHeading].filter((n) => n > 0);
      const end = candidates.length ? afterMarker + Math.min(...candidates) : Math.min(rest.length, 500_000);
      regions.push(rest.slice(0, end));
    }
  }

  return regions;
}

function referenceBlocks(region: string): string[] {
  const blocks: string[] = [];
  for (const m of region.matchAll(/<div\b[^>]*id=["']bibr\d+[^"']*["'][^>]*class=["'][^"']*\bcitations\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi)) {
    blocks.push(m[0]);
  }
  if (blocks.length) return blocks;

  for (const m of region.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const block = m[0];
    if (/doi\.org|pubmed|scholar_lookup|crossref|10\.\d{4,9}\//i.test(block)) blocks.push(block);
  }
  if (blocks.length) return blocks;

  for (const m of region.matchAll(/<(?:div|p)\b[^>]*(?:class|id)=["'][^"']*(?:reference|citation|ref-list|refItem|NLM_citation)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|p)>/gi)) {
    const block = m[0];
    if (/doi\.org|pubmed|scholar_lookup|crossref|10\.\d{4,9}\//i.test(block)) blocks.push(block);
  }
  return blocks;
}

function recordFromBlock(block: string, sourceUrl: string, index: number): ReferenceRecord | null {
  const anchors = Array.from(block.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi));
  const hrefs = anchors.map((m) => absoluteUrl(attr(m[1] ?? "", "href"), sourceUrl)).filter(Boolean);
  const haystack = `${stripTags(block)} ${hrefs.join(" ")}`;
  if (isSupplementaryLink(haystack)) return null;
  const pmid = extractPmid(haystack);
  const doi = extractDoi(haystack);
  if (!pmid && !doi && !/scholar_lookup|crossref|scholar.google/i.test(haystack)) return null;

  const href =
    hrefs.find((h) => /pubmed/i.test(h)) ??
    hrefs.find((h) => /scholar\.google/i.test(h)) ??
    hrefs.find((h) => /scholar_lookup/i.test(h)) ??
    hrefs.find((h) => /doi\.org|\/doi\//i.test(h)) ??
    hrefs[0] ??
    "";
  const text = cleanReferenceText(stripTags(block));
  if (/^skip to main content$/i.test(text)) return null;

  return {
    index,
    text: text || href,
    sourceUrl,
    href,
    doi,
    pmid,
    pubmedFound: false,
  };
}

function dedupeRecords(records: ReferenceRecord[]): ReferenceRecord[] {
  const seen = new Set<string>();
  const out: ReferenceRecord[] = [];
  for (const record of records) {
    const key = record.pmid || record.doi.toLowerCase() || record.text.toLowerCase().slice(0, 100);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...record, index: out.length + 1 });
  }
  return out;
}

function sourceDoi(sourceUrl: string, html: string): string {
  return extractDoi(`${sourceUrl} ${html.match(/<meta[^>]+name=["']citation_doi["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? ""}`).toLowerCase();
}

function isSupplementaryLink(text: string): boolean {
  return /(?:\/doi\/suppl\/|\/suppl_file\/|supplementary-materials|core-supplementary-material|\.docx?\b|\.xlsx?\b|\.pptx?\b|\.zip\b)/i.test(text);
}

function scoreRecord(record: ReferenceRecord): number {
  let score = 0;
  if (record.pubmed?.abstract) score += 100;
  if (record.pubmed?.title) score += 20;
  if (record.pubmed?.authors?.length) score += 10;
  if (record.text && !/^https?:\/\//i.test(record.text)) score += 8;
  if (/pubmed/i.test(record.href)) score += 4;
  if (/doi\.org|\/doi\//i.test(record.href)) score += 2;
  if (record.error) score -= 20;
  return score;
}

function dedupeEnrichedRecords(records: ReferenceRecord[], sourceUrl: string, html: string): ReferenceRecord[] {
  const ownDoi = sourceDoi(sourceUrl, html);
  const best = new Map<string, ReferenceRecord>();

  for (const record of records) {
    const doi = (record.pubmed?.doi || record.doi || "").toLowerCase();
    const pmid = record.pubmed?.pmid || record.pmid || "";
    if (ownDoi && doi === ownDoi) continue;
    if (isSupplementaryLink(`${record.href} ${record.doi} ${record.text}`)) continue;
    if (/^(skip to main content|search this journal)$/i.test(record.text.trim())) continue;

    const key = pmid ? `pmid:${pmid}` : doi ? `doi:${doi}` : `text:${record.text.toLowerCase().slice(0, 120)}`;
    const current = best.get(key);
    if (!current || scoreRecord(record) > scoreRecord(current)) {
      best.set(key, record);
    }
  }

  return Array.from(best.values()).map((record, i) => ({ ...record, index: i + 1 }));
}

// SagePub/Atypon: 参照リストは <div id="bibrN-{suffix}" class="citations"> が1件=1文献。
// bibr番号で決定的に全件取得できる（件数のブレが無くなる）。
function extractBibrReferences(html: string, sourceUrl: string): ReferenceRecord[] {
  const markRe = /<div id="bibr(\d+)-([^"]+)" class="citations">/gi;
  const marks: { n: number; start: number }[] = [];
  for (let m = markRe.exec(html); m; m = markRe.exec(html)) {
    marks.push({ n: Number(m[1]), start: m.index });
  }
  if (!marks.length) return [];
  marks.sort((a, b) => a.start - b.start);

  const records: ReferenceRecord[] = [];
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : Math.min(html.length, marks[i].start + 8000);
    const block = html.slice(marks[i].start, end);
    // URLパラメータ抽出のため &amp; を復元
    const links = block.replace(/&amp;/g, "&");

    const content = block.match(/<div class="citation-content">([\s\S]*?)<\/div>/i)?.[1] ?? "";
    const text = cleanReferenceText(stripTags(content.replace(/<span class="label">[^<]*<\/span>/i, "")));

    // PMID: PubMedリンク or Google Scholarの pmid= パラメータ
    const pmid =
      links.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i)?.[1] ?? links.match(/[?&]pmid=(\d+)/i)?.[1] ?? "";

    // DOI: 引用先のDOIのみを採用する。
    // Crossrefのlinkoutは doi=<元論文> & key=<引用先> なので key= を使い、doi= は使わない。
    const scholarDoi = decodeMaybe(links.match(/scholar_lookup\?[^"]*[?&]doi=(10\.[^&"]+)/i)?.[1] ?? "");
    const directDoi = links.match(/doi\.org\/(10\.\d{4,9}\/[^"<\s]+)/i)?.[1] ?? "";
    const keyDoi = decodeMaybe(links.match(/[?&]key=(10\.[^&"]+)/i)?.[1] ?? "");
    const doi = (scholarDoi || directDoi || keyDoi || "").replace(/[)\].,;]+$/g, "");

    const href =
      (links.match(/href="(https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/\d+\/?)"/i)?.[1] ?? "") ||
      (doi ? `https://doi.org/${doi}` : "") ||
      sourceUrl;

    records.push({
      index: marks[i].n,
      text: text || href,
      sourceUrl,
      href,
      doi,
      pmid,
      pubmedFound: false,
    });
  }
  return records;
}

function decodeMaybe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function extractReferenceCandidates(html: string, sourceUrl: string): ReferenceRecord[] {
  const bibr = extractBibrReferences(html, sourceUrl);
  if (bibr.length) return bibr;


  const regionResults = findReferenceRegions(html)
    .map((region) =>
      dedupeRecords(
        referenceBlocks(region)
          .map((block, i) => recordFromBlock(block, sourceUrl, i + 1))
          .filter((record): record is ReferenceRecord => Boolean(record)),
      ),
    )
    .sort((a, b) => b.length - a.length);

  const blockRecords = regionResults[0] ?? [];
  if (blockRecords.length > 1) return blockRecords;

  const region = findReferenceRegions(html)[0] ?? html;

  const anchors = Array.from(region.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi));
  const candidates: ReferenceRecord[] = [];
  const seen = new Set<string>();

  for (const match of anchors) {
    const tag = match[1] ?? "";
    const hrefRaw = attr(tag, "href");
    if (!hrefRaw) continue;

    const href = absoluteUrl(hrefRaw, sourceUrl);
    const text = cleanReferenceText(stripTags(match[2] ?? ""));
    const haystack = `${href} ${text}`;
    if (isSupplementaryLink(haystack)) continue;
    const pmid = extractPmid(haystack);
    const doi = extractDoi(haystack);
    if (/^skip to main content$/i.test(text)) continue;
    const looksUseful =
      Boolean(pmid || doi) ||
      /pubmed|doi\.org|crossref|ncbi\.nlm\.nih\.gov|\/doi\/|scholar\.google|scholar_lookup/i.test(href) ||
      /\bPMID\b|\bDOI\b/i.test(text);
    if (!looksUseful) continue;

    const key = pmid || doi.toLowerCase() || href;
    if (seen.has(key)) continue;
    seen.add(key);

    candidates.push({
      index: candidates.length + 1,
      text: text || href,
      sourceUrl,
      href,
      doi,
      pmid,
      pubmedFound: false,
    });
  }

  return dedupeRecords(candidates);
}

async function fetchText(url: string, params: Record<string, string>): Promise<string> {
  if (url.startsWith(ENTREZ_BASE)) {
    const elapsed = Date.now() - lastEntrezRequestAt;
    const wait = Math.max(0, 380 - elapsed);
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    lastEntrezRequestAt = Date.now();
  }
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u, { headers: { "User-Agent": `${TOOL}/1.0 (${EMAIL})` } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

async function doiToPmid(doi: string): Promise<string> {
  if (!doi) return "";
  const raw = await fetchText(`${ENTREZ_BASE}/esearch.fcgi`, {
    db: "pubmed",
    term: `${doi}[doi]`,
    retmode: "json",
    retmax: "1",
    tool: TOOL,
    email: EMAIL,
  });
  const data = JSON.parse(raw);
  return data?.esearchresult?.idlist?.[0] ?? "";
}

async function titleToPmid(text: string): Promise<string> {
  const query = cleanReferenceText(text).slice(0, 240);
  if (query.length < 20) return "";
  const raw = await fetchText(`${ENTREZ_BASE}/esearch.fcgi`, {
    db: "pubmed",
    term: query,
    retmode: "json",
    retmax: "1",
    tool: TOOL,
    email: EMAIL,
  });
  const data = JSON.parse(raw);
  return data?.esearchresult?.idlist?.[0] ?? "";
}

function xmlText(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? stripTags(m[1]) : "";
}

function xmlTexts(xml: string, tag: string): string[] {
  return Array.from(xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi")))
    .map((m) => stripTags(m[1] ?? ""))
    .filter(Boolean);
}

async function fetchPubmedRecord(pmid: string): Promise<ReferenceRecord["pubmed"] | undefined> {
  if (!pmid) return undefined;
  const xml = await fetchText(`${ENTREZ_BASE}/efetch.fcgi`, {
    db: "pubmed",
    id: pmid,
    rettype: "xml",
    retmode: "xml",
    tool: TOOL,
    email: EMAIL,
  });

  const abstract = xmlTexts(xml, "AbstractText").join("\n\n");
  const authors = Array.from(xml.matchAll(/<Author\b[^>]*>([\s\S]*?)<\/Author>/gi))
    .map((m) => {
      const block = m[1] ?? "";
      return [xmlText(block, "LastName"), xmlText(block, "ForeName")].filter(Boolean).join(" ");
    })
    .filter(Boolean);
  const articleIdBlocks = Array.from(xml.matchAll(/<ArticleId\b([^>]*)>([\s\S]*?)<\/ArticleId>/gi));
  const doi =
    articleIdBlocks.find((m) => /IdType=["']doi["']/i.test(m[1] ?? ""))?.[2]?.trim() ?? "";
  const year =
    xml.match(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>[\s\S]*?<\/PubDate>/i)?.[1] ??
    xml.match(/<ArticleDate[^>]*>[\s\S]*?<Year>(\d{4})<\/Year>/i)?.[1] ??
    "";

  return {
    pmid,
    doi,
    title: xmlText(xml, "ArticleTitle"),
    abstract,
    authors,
    journal: xmlText(xml, "Title"),
    year,
    publicationTypes: xmlTexts(xml, "PublicationType"),
  };
}

async function fetchJson(url: string, params: Record<string, string>): Promise<any> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u, { headers: { "User-Agent": `${TOOL}/1.0 (${EMAIL})`, Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// DOI起点でabstractを補完する（PubMedに無い/abstract欠落の場合のフォールバック）
async function fetchCrossrefMeta(doi: string): Promise<ReferenceRecord["pubmed"] | undefined> {
  if (!doi) return undefined;
  try {
    const data = await fetchJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, { mailto: EMAIL });
    const msg = data?.message;
    if (!msg) return undefined;
    const authors = Array.isArray(msg.author)
      ? msg.author.map((a: any) => [a.family, a.given].filter(Boolean).join(" ")).filter(Boolean)
      : [];
    const year = String(
      msg.issued?.["date-parts"]?.[0]?.[0] ?? msg["published-print"]?.["date-parts"]?.[0]?.[0] ?? "",
    );
    return {
      pmid: "",
      doi: String(msg.DOI ?? doi).toLowerCase(),
      title: Array.isArray(msg.title) ? stripTags(msg.title[0] ?? "") : "",
      abstract: msg.abstract ? stripTags(msg.abstract) : "",
      authors,
      journal: Array.isArray(msg["container-title"]) ? msg["container-title"][0] ?? "" : "",
      year,
      publicationTypes: msg.type ? [msg.type] : [],
      source: "crossref",
    };
  } catch {
    return undefined;
  }
}

async function fetchEuropePmcMeta(doi: string): Promise<ReferenceRecord["pubmed"] | undefined> {
  if (!doi) return undefined;
  try {
    const data = await fetchJson("https://www.ebi.ac.uk/europepmc/webservices/rest/search", {
      query: `DOI:"${doi}"`,
      format: "json",
      resultType: "core",
      pageSize: "1",
    });
    const r = data?.resultList?.result?.[0];
    if (!r) return undefined;
    return {
      pmid: r.pmid ?? "",
      doi: String(r.doi ?? doi).toLowerCase(),
      title: r.title ? stripTags(r.title) : "",
      abstract: r.abstractText ? stripTags(r.abstractText) : "",
      authors: r.authorString ? r.authorString.split(/,\s*/).filter(Boolean) : [],
      journal: r.journalInfo?.journal?.title ?? "",
      year: String(r.pubYear ?? ""),
      publicationTypes: r.pubTypeList?.pubType ?? [],
      source: "europepmc",
    };
  } catch {
    return undefined;
  }
}

// Crossref → Europe PMC の順でabstract付きメタデータを探す
async function fetchAbstractByDoi(doi: string): Promise<ReferenceRecord["pubmed"] | undefined> {
  const crossref = await fetchCrossrefMeta(doi);
  if (crossref?.abstract) return crossref;
  const europepmc = await fetchEuropePmcMeta(doi);
  if (europepmc?.abstract) return europepmc;
  return undefined;
}

async function enrichRecord(record: ReferenceRecord): Promise<ReferenceRecord> {
  try {
    let pmid = record.pmid;
    if (!pmid && record.doi) pmid = await doiToPmid(record.doi);
    if (!pmid) pmid = await titleToPmid(record.text);

    let pubmed = pmid ? await fetchPubmedRecord(pmid) : undefined;
    if (pubmed) pubmed = { ...pubmed, source: "pubmed" };
    const doi = record.doi || pubmed?.doi || "";

    // PubMedでabstractが取れない場合、DOI起点でCrossref→Europe PMCから補完
    if (!pubmed?.abstract && doi) {
      const fallback = await fetchAbstractByDoi(doi);
      if (fallback?.abstract) {
        pubmed = pubmed
          ? { ...pubmed, abstract: fallback.abstract, source: fallback.source }
          : { ...fallback, pmid: pmid || fallback.pmid };
      }
    }

    if (!pubmed) return { ...record, pubmedFound: false, error: "メタデータが見つかりません" };

    return {
      ...record,
      pmid: pmid || pubmed.pmid || "",
      doi,
      pubmedFound: Boolean(pubmed),
      pubmed,
      error: pubmed.abstract ? undefined : "Abstract not found",
    };
  } catch (e: any) {
    return { ...record, error: String(e?.message ?? e) };
  }
}

export function referenceSetPath(id: string): string {
  return path.join(PATHS.referenceOutputDir, `${id}.json`);
}

export function referenceHtmlPath(id: string): string {
  return path.join(PATHS.referenceOutputDir, `${id}.source.html`);
}

export function loadReferenceSet(id: string): ReferenceSet {
  const safeId = id.replace(/[^a-zA-Z0-9_.-]/g, "");
  const raw = fs.readFileSync(referenceSetPath(safeId), "utf-8");
  return decodeEntityStrings(JSON.parse(raw) as ReferenceSet);
}

export function listReferenceSets() {
  if (!fs.existsSync(PATHS.referenceOutputDir)) return [];
  return fs
    .readdirSync(PATHS.referenceOutputDir)
    .filter((f) => f.endsWith(".json"))
    .map((file) => {
      const set = decodeEntityStrings(
        JSON.parse(fs.readFileSync(path.join(PATHS.referenceOutputDir, file), "utf-8")) as ReferenceSet,
      );
      return {
        id: set.id,
        title: set.title,
        sourceUrl: set.sourceUrl,
        totalReferences: set.totalReferences,
        abstractFound: set.abstractFound,
        createdAt: set.createdAt,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function harvestReferences(options: HarvestOptions): Promise<ReferenceSet> {
  if (!options.sourceUrl && !options.html) throw new Error("URLまたはHTMLを入力してください");
  const sourceUrl = options.sourceUrl?.trim() ?? "";
  const html = options.html ?? (await fetchText(sourceUrl, {}));
  const title = options.title?.trim() || inferTitle(html, sourceUrl);
  const limit = Math.max(1, Math.min(200, Number(options.limit ?? 80)));
  const candidates = extractReferenceCandidates(html, sourceUrl).slice(0, limit);
  const enrichedRecords: ReferenceRecord[] = [];

  for (const candidate of candidates) {
    enrichedRecords.push(await enrichRecord(candidate));
  }
  const records = dedupeEnrichedRecords(enrichedRecords, sourceUrl, html);

  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const id = `${slugify(title || sourceUrl)}-${stamp}`;
  const set: ReferenceSet = {
    id,
    sourceUrl,
    title,
    createdAt: new Date().toISOString(),
    totalReferences: records.length,
    pubmedFound: records.filter((r) => r.pubmedFound).length,
    abstractFound: records.filter((r) => r.pubmed?.abstract).length,
    records: records.map((r, i) => ({ ...r, index: i + 1 })),
  };
  const decodedSet = decodeEntityStrings(set);

  ensureOutputDir();
  fs.writeFileSync(referenceSetPath(id), JSON.stringify(decodedSet, null, 2), "utf-8");
  // 入力HTMLを保存しておく（再現性確保・パーサ検証用）
  try {
    fs.writeFileSync(referenceHtmlPath(id), html, "utf-8");
  } catch {
    /* HTML保存に失敗しても結果は返す */
  }
  return decodedSet;
}
