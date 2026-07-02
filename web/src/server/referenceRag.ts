import { Document, SentenceSplitter, Settings, VectorStoreIndex } from "llamaindex";
import { OpenAI, OpenAIEmbedding } from "@llamaindex/openai";
import OpenAIClient from "openai";
import { MODELS } from "./config.js";
import { loadReferenceSet, type ReferenceRecord, type ReferenceSet } from "./referenceHarvester.js";

interface CachedReferenceIndex {
  set: ReferenceSet;
  index: VectorStoreIndex;
  // ref_index -> 元レコード（アブストラクト全文の復元用）
  recordByRef: Map<string, ReferenceRecord>;
}

// アブストラクトを文単位の小チャンクへ分割する（検索精度向上のため）。
// 表示・LLM提示はアブストラクト全文を使うので、ここは検索専用の細分化。
const abstractSplitter = new SentenceSplitter({ chunkSize: 128, chunkOverlap: 24 });

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

function recordMetadata(set: ReferenceSet, record: ReferenceRecord): Record<string, unknown> {
  const authors = record.pubmed?.authors?.join(", ") || "";
  const year = record.pubmed?.year || "";
  return {
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
  };
}

// アブストラクトを文単位の小チャンクへ分割し、各チャンクに文献メタデータを付与する。
// メタデータは埋め込み・LLM本文から除外し、「文そのもの」だけをベクトル化する
// （ref_index などがembedに混ざるとチャンク細分化の意味が薄れるため）。
function recordToNodes(set: ReferenceSet, record: ReferenceRecord): Document[] {
  const abstract = record.pubmed?.abstract?.trim();
  if (!abstract) return [];
  const metadata = recordMetadata(set, record);
  const excluded = Object.keys(metadata);
  return abstractSplitter.splitText(abstract).map(
    (text) =>
      new Document({
        text,
        metadata,
        excludedEmbedMetadataKeys: excluded,
        excludedLlmMetadataKeys: excluded,
      }),
  );
}

async function buildReferenceIndex(id: string): Promise<CachedReferenceIndex> {
  ensureSettings();
  const set = loadReferenceSet(id);
  const recordByRef = new Map<string, ReferenceRecord>();
  const nodes: Document[] = [];
  for (const record of set.records) {
    const chunks = recordToNodes(set, record);
    if (chunks.length) {
      recordByRef.set(String(record.index), record);
      nodes.push(...chunks);
    }
  }
  if (!nodes.length) throw new Error("No references with an abstract");
  const index = await VectorStoreIndex.init({ nodes });
  return { set, index, recordByRef };
}

async function getReferenceIndex(id: string): Promise<CachedReferenceIndex> {
  if (!cache.has(id)) cache.set(id, buildReferenceIndex(id));
  return cache.get(id)!;
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

// 文チャンクのヒットから、文献（アブストラクト全文）単位のソースを組み立てる。
// abstract は元レコードから復元するため、表示・synthesis は常に全文になる。
function recordToSource(record: ReferenceRecord, score: number): ReferenceSource {
  const authors = record.pubmed?.authors?.join(", ") || "";
  const year = record.pubmed?.year || "";
  return {
    score,
    refIndex: record.index,
    title: record.pubmed?.title || "",
    authors,
    journal: record.pubmed?.journal || "",
    year,
    doi: record.pubmed?.doi || record.doi || "",
    pmid: record.pubmed?.pmid || record.pmid || "",
    href: record.href || "",
    referenceText: record.text || "",
    abstract: record.pubmed?.abstract?.trim() || "",
    citationLabel: citationLabel(authors, year, record.index),
  };
}

async function synthesizeAnswerWithCitations(
  enQuery: string,
  sources: ReferenceSource[],
): Promise<string> {
  const client = new OpenAIClient();
  const context = sources
    .map((source) => {
      const title = source.title ? `Title: ${source.title}` : "";
      const journal = [source.journal, source.year].filter(Boolean).join(", ");
      const journalLine = journal ? `Journal: ${journal}` : "";
      return [
        `Reference [${source.refIndex}] (${source.citationLabel})`,
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
          "Every substantive answer sentence must end with one or more citations in square brackets, using the exact reference numbers shown in brackets for each source, for example [2] or [2, 5].",
          "If a sentence combines evidence from multiple abstracts, cite every reference used for that sentence.",
          "Do not cite references that do not support the sentence.",
          "If the abstracts do not contain enough evidence, say so clearly and cite the closest relevant reference if applicable.",
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
  const { index, recordByRef } = await getReferenceIndex(setId);
  const shouldTranslate = opts.translate ?? hasJapanese(originalQuery);
  const enQuery = opts.enQuery ?? (shouldTranslate ? await translateToEnglish(originalQuery) : originalQuery);

  // 文チャンク単位で検索するため、topK文献を確保できるよう多めに取得する。
  const retrieveK = Math.min(80, topK * 8);
  const retriever = index.asRetriever({ similarityTopK: retrieveK });
  const rawNodes: any[] = await retriever.retrieve(enQuery);

  // ref_index でグループ化し、各文献の最高スコア（＝最も刺さった文）を採用する。
  const bestByRef = new Map<string, number>();
  for (const nws of rawNodes) {
    const node = nws.node ?? nws;
    const refIndex = node.metadata?.ref_index;
    if (refIndex === undefined || refIndex === null) continue;
    const key = String(refIndex);
    const score = typeof nws.score === "number" ? nws.score : 0;
    if (!bestByRef.has(key) || score > bestByRef.get(key)!) bestByRef.set(key, score);
  }

  const sources = [...bestByRef.entries()]
    .map(([key, score]) => {
      const record = recordByRef.get(key);
      return record ? recordToSource(record, score) : null;
    })
    .filter((s): s is ReferenceSource => s !== null)
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
