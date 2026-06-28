import { Document, Settings, VectorStoreIndex } from "llamaindex";
import { OpenAI, OpenAIEmbedding } from "@llamaindex/openai";
import OpenAIClient from "openai";
import { MODELS } from "./config.js";
import { loadReferenceSet, type ReferenceRecord, type ReferenceSet } from "./referenceHarvester.js";

interface CachedReferenceIndex {
  set: ReferenceSet;
  index: VectorStoreIndex;
}

const cache = new Map<string, Promise<CachedReferenceIndex>>();

function ensureSettings() {
  Settings.llm = new OpenAI({ model: MODELS.llm, temperature: 0.1 });
  Settings.embedModel = new OpenAIEmbedding({ model: MODELS.embed });
}

function hasJapanese(s: string): boolean {
  return /[぀-ヿ㐀-鿿]/.test(s);
}

function citationAuthor(authors: string, fallback: string): string {
  const firstAuthor = authors.split(",")[0]?.trim() || fallback;
  const cleaned = firstAuthor
    .replace(/\bet\s+al\.?$/i, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim();
  return cleaned.split(/\s+/)[0] || fallback;
}

function citationYear(year: string): string {
  return year.match(/\d{4}/)?.[0] ?? "n.d.";
}

function citationLabel(authors: string, year: string, refIndex: number | string): string {
  return `${citationAuthor(authors, `Ref${refIndex || ""}`)}${citationYear(year)}`;
}

async function translateToEnglish(text: string): Promise<string> {
  const client = new OpenAIClient();
  const res = await client.chat.completions.create({
    model: MODELS.translate,
    temperature: 0.1,
    messages: [
      {
        role: "user",
        content: `Translate the following Japanese text to English. Return only the translation:\n\n${text}`,
      },
    ],
  });
  return res.choices[0].message.content?.trim() ?? text;
}

function recordToDocument(set: ReferenceSet, record: ReferenceRecord): Document | null {
  const abstract = record.pubmed?.abstract?.trim();
  if (!abstract) return null;
  const authors = record.pubmed?.authors?.join(", ") || "";
  const year = record.pubmed?.year || "";
  return new Document({
    text: abstract,
    metadata: {
      set_id: set.id,
      source_url: set.sourceUrl,
      ref_index: record.index,
      reference_text: record.text,
      href: record.href,
      pmid: record.pubmed?.pmid || record.pmid,
      doi: record.pubmed?.doi || record.doi,
      title: record.pubmed?.title || "",
      authors,
      journal: record.pubmed?.journal || "",
      year,
      publication_types: record.pubmed?.publicationTypes?.join(", ") || "",
      citation_label: citationLabel(authors, year, record.index),
      metadata_source: record.pubmed?.source || "pubmed",
    },
  });
}

async function buildReferenceIndex(id: string): Promise<CachedReferenceIndex> {
  ensureSettings();
  const set = loadReferenceSet(id);
  const documents = set.records
    .map((record) => recordToDocument(set, record))
    .filter((doc): doc is Document => Boolean(doc));
  if (!documents.length) throw new Error("abstract付き参考文献がありません");
  const index = await VectorStoreIndex.init({ nodes: documents });
  return { set, index };
}

async function getReferenceIndex(id: string): Promise<CachedReferenceIndex> {
  if (!cache.has(id)) cache.set(id, buildReferenceIndex(id));
  return cache.get(id)!;
}

function nodeText(n: any): string {
  if (typeof n.getContent === "function") {
    try {
      return n.getContent();
    } catch {
      /* fallthrough */
    }
  }
  return n.text ?? "";
}

type ReferenceSource = {
  score: number;
  refIndex: number | string;
  title: string;
  authors: string;
  journal: string;
  year: string;
  doi: string;
  pmid: string;
  href: string;
  referenceText: string;
  abstract: string;
  citationLabel: string;
};

async function synthesizeAnswerWithCitations(
  enQuery: string,
  sources: ReferenceSource[],
): Promise<string> {
  const client = new OpenAIClient();
  const context = sources
    .map((source, i) => {
      const citation = source.citationLabel;
      const title = source.title ? `Title: ${source.title}` : "";
      const journal = [source.journal, source.year].filter(Boolean).join(", ");
      const journalLine = journal ? `Journal: ${journal}` : "";
      return [
        `Source ${i + 1} (${citation})`,
        title,
        source.authors ? `Authors: ${source.authors}` : "",
        journalLine,
        `Abstract: ${source.abstract}`,
      ].filter(Boolean).join("\n");
    })
    .join("\n\n---\n\n");

  const res = await client.chat.completions.create({
    model: MODELS.llm,
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content: [
          "You answer questions using only the provided PubMed reference abstracts.",
          "Every substantive answer sentence must end with one or more citations in parentheses, using the exact citation labels shown for the sources, for example (Smith2020) or (Smith2020; Lee2022).",
          "If a sentence combines evidence from multiple abstracts, cite every abstract used for that sentence.",
          "Do not cite sources that do not support the sentence.",
          "If the abstracts do not contain enough evidence, say so clearly and cite the closest relevant abstract if applicable.",
          "Always answer in English, regardless of the language of the user's query.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `Query: ${enQuery}`,
          "",
          "Reference abstracts:",
          context,
        ].filter(Boolean).join("\n"),
      },
    ],
  });

  return res.choices[0].message.content?.trim() ?? "";
}

export interface ReferenceQueryResult {
  setId: string;
  originalQuery: string;
  enQuery: string;
  answer: string;
  sources: {
    score: number;
    refIndex: number | string;
    title: string;
    authors: string;
    journal: string;
    year: string;
    doi: string;
    pmid: string;
    href: string;
    referenceText: string;
    abstract: string;
    citationLabel: string;
  }[];
}

export async function runReferenceQuery(
  setId: string,
  originalQuery: string,
  opts: { topK?: number; translate?: boolean; enQuery?: string } = {},
): Promise<ReferenceQueryResult> {
  const topK = Math.max(1, Math.min(20, Number(opts.topK ?? 5)));
  const { index } = await getReferenceIndex(setId);
  const shouldTranslate = opts.translate ?? hasJapanese(originalQuery);
  const enQuery = opts.enQuery ?? (shouldTranslate ? await translateToEnglish(originalQuery) : originalQuery);

  const retriever = index.asRetriever({ similarityTopK: topK });
  const rawNodes: any[] = await retriever.retrieve(enQuery);
  const sources = rawNodes
    .map((nws): ReferenceSource => {
      const node = nws.node ?? nws;
      const meta = node.metadata ?? {};
      const refIndex = meta.ref_index ?? "";
      const authors = meta.authors ?? "";
      const year = meta.year ?? "";
      return {
        score: typeof nws.score === "number" ? nws.score : 0,
        refIndex,
        title: meta.title ?? "",
        authors,
        journal: meta.journal ?? "",
        year,
        doi: meta.doi ?? "",
        pmid: meta.pmid ?? "",
        href: meta.href ?? "",
        referenceText: meta.reference_text ?? "",
        abstract: nodeText(node),
        citationLabel: meta.citation_label ?? citationLabel(authors, year, refIndex),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const answer = await synthesizeAnswerWithCitations(enQuery, sources);

  return {
    setId,
    originalQuery,
    enQuery,
    answer,
    sources,
  };
}
