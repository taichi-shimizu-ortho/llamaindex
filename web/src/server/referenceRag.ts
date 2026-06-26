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
      authors: record.pubmed?.authors?.join(", ") || "",
      journal: record.pubmed?.journal || "",
      year: record.pubmed?.year || "",
      publication_types: record.pubmed?.publicationTypes?.join(", ") || "",
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
  const index = await VectorStoreIndex.fromDocuments(documents);
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

  const queryEngine = index.asQueryEngine({ similarityTopK: topK });
  const response: any = await queryEngine.query({ query: enQuery });
  const answer: string = response?.response ?? response?.message?.content ?? String(response ?? "");
  const rawNodes: any[] = response?.sourceNodes ?? [];

  return {
    setId,
    originalQuery,
    enQuery,
    answer,
    sources: rawNodes
      .map((nws) => {
        const node = nws.node ?? nws;
        const meta = node.metadata ?? {};
        return {
          score: typeof nws.score === "number" ? nws.score : 0,
          refIndex: meta.ref_index ?? "",
          title: meta.title ?? "",
          authors: meta.authors ?? "",
          journal: meta.journal ?? "",
          year: meta.year ?? "",
          doi: meta.doi ?? "",
          pmid: meta.pmid ?? "",
          href: meta.href ?? "",
          referenceText: meta.reference_text ?? "",
          abstract: nodeText(node),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK),
  };
}
