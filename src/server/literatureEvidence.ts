// Read-only retrieval over the configured local literature. Keep quotations and locators
// server-owned so generation can only link to records that were actually retrieved.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./config.js";
import type { ArticleSet } from "./articleHarvester.js";
import type { ReferenceSet } from "./referenceHarvester.js";
import type { CitationCheck, Evidence, LiteratureCollection, RetrievalMode, RetrievalResult } from "../shared/manuscript.js";
import { rxfp1DocumentIds } from "./library.js";
import { isRxfp1Article } from "../shared/rxfp1.js";
import { rxfp1PassageKey, rxfp1PassageText, rxfp1Similarity, type Rxfp1Index } from "./rxfp1Index.js";
import { fusePassageRanks, rankByText, searchTerms } from "./passageRanking.js";

type Section = ArticleSet["sections"][number];

interface SemanticEvidence {
  index: Rxfp1Index;
  query?: Float32Array;
}

interface Passage {
  text: string;
  locator: Evidence["locator"];
  type: Evidence["evidence_type"];
  limitations: string[];
  group: string;
  terms: Set<string>;
}

interface Source {
  id: string;
  title: string;
  authors: string[];
  year: string;
  doi: string;
  pmid: string;
  passages: Passage[];
}

interface Citation {
  source_id: string;
  reference: string | null;
}

export interface RetrievalRequest {
  request_id: string;
  claim_id: string | null;
  query: string;
  scope?: string;
  cited_source_ids: string[];
  mode: RetrievalMode;
}

const doiOf = (value: string) => value.match(/10\.\d{4,9}\/[^\s"”<>]+/i)?.[0].replace(/[),.;\]]+$/, "").toLowerCase() ?? "";
const titleKey = (value: string) => value.normalize("NFKD").toLowerCase().replace(/\p{M}|[^\p{L}\p{N}]+/gu, "");
const excluded = /^(?:excluded|references?|cited[ _]by|acknowledg|keywords?|abbreviations?|funding|grants|disclosures?|conflicts? of interest|author contributions|availability of data|data availability|footnotes?)/i;

function sectionGroup(type: string, title: string): string {
  if (type === "abstract" || /^abstract\b/i.test(title)) return "abstract";
  if (["methods", "materials|methods", "results", "discussion", "conclusion", "table", "figure"].includes(type)) return type;
  if (/^(?:[\d.]+\s+)?(?:results|findings)\b/i.test(title)) return "results";
  if (/^(?:[\d.]+\s+)?(?:materials and methods|methods)\b/i.test(title)) return "methods";
  if (/^(?:[\d.]+\s+)?(?:discussion|conclusions?)\b/i.test(title)) return "discussion";
  if (/^tables?\s*\d/i.test(title)) return "table";
  if (/^(?:fig\.?|figures?)\s*\d/i.test(title)) return "figure";
  return type;
}

function passagesOf(sections: Section[], articleType?: ArticleSet["articleType"], pdf = false): Passage[] {
  return sections.flatMap((section, sectionIndex) => {
    if (excluded.test(section.type) || excluded.test(section.title)) return [];
    const pieces = [
      { title: null, paragraphs: section.paragraphs },
      ...section.subsections.map((sub) => ({ title: sub.title, paragraphs: sub.paragraphs })),
    ];
    return pieces.flatMap(({ title, paragraphs }, subIndex) => {
      if (title && excluded.test(title)) return [];
      const sectionTitle = section.title || section.type;
      const group = sectionGroup(section.type, title || sectionTitle);
      const type = articleType === "review" ? "secondary_summary"
        : group === "methods" || group === "materials|methods" ? "methods"
        : ["discussion", "conclusion"].includes(group) ? "author_interpretation"
        : articleType === "original" && group === "results" ? "primary_result" : "other";
      return paragraphs.flatMap((raw, paragraphIndex): Passage[] => {
        const text = group === "figure" || group === "table" ? rxfp1PassageText(raw) : raw;
        return !text.trim() ? [] : [{
          text,
          locator: {
            section: sectionTitle,
            subsection: title,
            chunk_id: [sectionIndex + 1, subIndex, paragraphIndex + 1].join("."),
            paragraph: paragraphIndex + 1,
            page: null,
          },
          type, group, terms: searchTerms(text),
          limitations: [
            ...(group === "abstract" ? ["Abstract passage."] : []),
            ...(group === "table" ? ["Table structure may be incomplete in the extracted paragraph."] : []),
            ...(text.includes("\uFFFD") ? ["The passage contains text decoding artifacts."] : []),
            ...(pdf ? ["PDF text extraction. Check exact characters and values against the original page."] : []),
          ],
        }];
      });
    });
  });
}

function sourceFromSet(set: ArticleSet): Source {
  return {
    id: set.id, title: set.title, authors: set.authors ?? [], year: set.year,
    doi: doiOf(set.doi ?? ""), pmid: set.pmid ?? "", passages: passagesOf(set.sections, set.articleType, set.extractionSource === "pdf"),
  };
}

function readSets<T>(dir: string, errors: string[]): T[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`Could not read ${path.basename(dir)}.`);
    return [];
  }
  return files.filter((file) => file.endsWith(".json")).flatMap((file) => {
    try {
      return [JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as T];
    } catch {
      errors.push(`Could not read ${path.basename(dir)}/${file}.`);
      return [];
    }
  });
}

function hasBody(source: Source): boolean {
  return source.passages.some((p) => !["abstract", "figure", "table"].includes(p.group));
}

function recordQuality(source: Source): number {
  return hasBody(source) ? 2 : source.passages.some((p) => p.group === "abstract") ? 1 : 0;
}

function identity(source: Source): string {
  return source.doi || (source.pmid && `pmid:${source.pmid}`) ||
    (source.title && source.year && `${titleKey(source.title)}:${source.year}`) || source.id;
}

function bestCopies(sources: Source[]): Source[] {
  const byWork = new Map<string, Source>();
  for (const source of sources) {
    const key = identity(source);
    const current = byWork.get(key);
    if (!current || recordQuality(source) > recordQuality(current)) byWork.set(key, source);
  }
  return [...byWork.values()];
}

export function loadLiterature(collection: LiteratureCollection = "current") {
  const errors: string[] = [];
  const selected = collection === "current" ? undefined : rxfp1DocumentIds();
  const includes = (id: string) => !selected || selected.has(id);
  if (selected && !selected.size) errors.push("The current RXFP1 folder has no assigned articles.");
  const sources: Source[] = [];
  for (const set of readSets<ArticleSet>(PATHS.articleOutputDir, errors)) {
    if (!includes(set?.id)) continue;
    try {
      sources.push(sourceFromSet(set));
    } catch {
      errors.push(`Could not extract article ${set?.id ?? "(unknown ID)"}.`);
    }
  }
  const abstractSources = readSets<ReferenceSet>(PATHS.referenceOutputDir, errors).filter((set) => includes(set?.id)).flatMap((set) =>
    (Array.isArray(set?.records) ? set.records : []).flatMap((record): Source[] => {
      const meta = record?.pubmed;
      if (!meta?.title || !meta.abstract?.trim() || !meta.pmid) return [];
      return [{
        id: `pmid:${meta.pmid}`, title: meta.title, authors: meta.authors ?? [], year: meta.year,
        doi: doiOf(meta.doi ?? record.doi ?? ""), pmid: meta.pmid,
        passages: passagesOf([{ type: "abstract", title: "Abstract", content: meta.abstract,
          paragraphs: [meta.abstract], subsections: [] }]),
      }];
    }),
  );
  return { sources, abstractSources: bestCopies(abstractSources), errors };
}

function resolveCitation(citation: Citation, sources: Source[]): { check: CitationCheck; source?: Source } {
  const reference = citation.reference;
  const identifier = reference || citation.source_id;
  const doi = doiOf(identifier);
  const pmid = identifier.match(/(?:\bpmid\s*:?\s*|pubmed\.ncbi\.nlm\.nih\.gov\/)(\d+)/i)?.[1];
  const explicitTitles = Array.from(identifier.matchAll(/["“]([^"”]+)["”]/g), (m) => titleKey(m[1]));
  const bare = titleKey(identifier);
  const matches = sources.filter((source) => {
    if ((doi && source.doi && doi !== source.doi) || (pmid && source.pmid && pmid !== source.pmid)) return false;
    if ((doi && doi === source.doi) || (pmid && pmid === source.pmid)) return true;
    if (!reference) return !/^\d+$/.test(identifier) && source.id === identifier;
    const key = titleKey(source.title ?? "");
    if (!key) return false;
    if (explicitTitles.length) {
      if (explicitTitles.includes(key)) return true;
      // A legacy publisher title can carry an inline footnote marker, e.g. "Mice1".
      return isRxfp1Article(source.id) && Boolean(source.year && reference.includes(source.year))
        && /\p{Ll}[1-9]$/u.test(source.title) && explicitTitles.includes(key.slice(0, -1));
    }
    // Require a full title and year in unstructured bibliographies to avoid author-year guesses.
    return key.length >= 24 && Boolean(source.year) && reference.includes(source.year) && bare.includes(key);
  });
  const identified = bestCopies(matches);
  // If DOI or PMID is missing from one catalogue, an exact title and compatible year can
  // still identify a duplicate of the better record. Conflicting identifiers stay ambiguous.
  const preferred = identified.sort((a, b) => recordQuality(b) - recordQuality(a))[0];
  const unique = preferred && identified.every((source) => source === preferred || (
    titleKey(source.title) === titleKey(preferred.title) && source.year === preferred.year
    && !(source.doi && preferred.doi && source.doi !== preferred.doi)
    && !(source.pmid && preferred.pmid && source.pmid !== preferred.pmid)
  ));
  const source = unique ? preferred : undefined;
  const check: CitationCheck = {
    source_id: citation.source_id, article_id: source?.id ?? null, title: source?.title ?? null,
    status: !reference && /^\d+$/.test(identifier) ? "unmapped" : !source ? (identified.length ? "ambiguous" : "not_indexed")
      : hasBody(source) ? "resolved" : recordQuality(source) === 1 ? "abstract_only" : "full_text_unavailable",
  };
  return { check, source };
}

function rank(query: string, sources: Source[], limit: number, perPaper: number, semantic?: SemanticEvidence) {
  const candidates = sources.flatMap((source) => source.passages.map((passage) => ({ source, passage })));
  const boost = (p: Passage) => /^(?:results|methods|materials\|methods|table|figure)$/.test(p.group) ? 1.15 : 1;
  const lexical = rankByText(query, candidates, ({ passage }) => passage.terms, ({ passage }) => boost(passage));
  const queryVector = semantic?.query;
  const dense = !queryVector ? [] : candidates.flatMap((item) => {
    const { source, passage } = item;
    const { section, subsection } = passage.locator;
    const vector = semantic.index.vectors.get(rxfp1PassageKey(source.id, section, subsection ?? "", passage.text));
    return vector ? [{ item, score: rxfp1Similarity(queryVector, vector) * boost(passage) }] : [];
  }).sort((a, b) => b.score - a.score);
  const ranked = fusePassageRanks(lexical, dense, Math.max(30, limit * 5));
  const hits: typeof candidates = [];
  const counts = new Map<string, number>();
  for (const { item: hit } of ranked) {
    const count = counts.get(hit.source.id) ?? 0;
    if (count >= perPaper) continue;
    hits.push(hit);
    counts.set(hit.source.id, count + 1);
    if (hits.length === limit) break;
  }
  return hits;
}

function studyContext(passage: Passage): Evidence["study_context"] {
  // Use explicitly labelled source text. Other context can be assessed from the excerpt.
  const labelled = (label: string) => {
    const sameHeading = new RegExp(`^(?:${label})[.:]?$`, "i");
    if (sameHeading.test(passage.locator.subsection ?? passage.locator.section)) return passage.text.trim();
    return passage.text.match(new RegExp(`^\\s*(?:${label})\\s*:\\s*([^\\r\\n]+)`, "im"))?.[1].trim() ?? null;
  };
  return {
    design: labelled("study design|design"),
    population_or_model: labelled("participants|study population|animal model"),
    comparison: labelled("comparator|control group"),
    outcome: labelled("main outcome measures?|primary outcomes?"),
  };
}

function evidenceRecord(request: RetrievalRequest, { source, passage }: ReturnType<typeof rank>[number],
  origin: Evidence["retrieval_origin"], sourceId: string): Evidence {
  const id = createHash("sha256").update(JSON.stringify([
    request.request_id, origin, sourceId, source.id, passage.locator.chunk_id, passage.text,
  ])).digest("hex").slice(0, 16);
  return {
    evidence_id: `E-${id}`, source_id: sourceId, article_id: source.id, retrieval_origin: origin,
    title: source.title || null, authors: source.authors, year: source.year || null,
    doi_or_pmid: source.doi || (source.pmid && `PMID:${source.pmid}`) || null,
    locator: passage.locator, excerpt: passage.text, evidence_type: passage.type,
    study_context: studyContext(passage),
    limitations: passage.limitations,
  };
}

export function retrieveLiterature(
  corpus: ReturnType<typeof loadLiterature>,
  request: RetrievalRequest,
  references: Record<string, string>,
  semantic?: SemanticEvidence,
): RetrievalResult {
  const evidence: Evidence[] = [];
  const sourceChecks: CitationCheck[] = [];
  const coverage = [...corpus.errors];
  if (semantic) {
    coverage.push(...semantic.index.notes);
    if (semantic.query && semantic.index.store) {
      coverage.push("RXFP1 search combined vector similarity with text matching.");
    } else if (semantic.index.vectors.size) {
      coverage.push("RXFP1 query embedding unavailable. Search used text matching.");
    }
  }
  const query = [request.query, request.scope].filter(Boolean).join(" ");
  const citedWorks = new Set<string>();
  if (request.mode !== "search_literature") {
    const catalogue = [...corpus.sources, ...corpus.abstractSources];
    for (const id of new Set(request.cited_source_ids)) {
      const { check, source } = resolveCitation({ source_id: id, reference: references[id] || null }, catalogue);
      sourceChecks.push(check);
      if (!source) continue;
      citedWorks.add(identity(source));
      const hits = rank(query, [source], 4, 4, semantic);
      for (const hit of hits) evidence.push(evidenceRecord(request, hit, "cited_source", id));
      if (!hits.length) coverage.push(`Citation [${id}] had no matching passages in the available text.`);
    }
  }
  if (request.mode !== "verify_cited_sources") {
    const broader = bestCopies(corpus.sources).filter((source) => hasBody(source) && !citedWorks.has(identity(source)));
    coverage.push(`Related search covered ${broader.length} locally indexed works with body text.`);
    for (const hit of rank(query, broader, 6, 2, semantic)) evidence.push(evidenceRecord(request, hit, "broader_search", hit.source.id));
  }
  const hasCatalogue = corpus.sources.length > 0 || corpus.abstractSources.length > 0;
  return {
    request_id: request.request_id, claim_id: request.claim_id, mode: request.mode,
    search_status: evidence.length ? "evidence_returned"
      : !hasCatalogue && corpus.errors.length ? "retrieval_failed" : "no_relevant_evidence",
    source_checks: sourceChecks, evidence, coverage_notes: coverage,
  };
}
