import { SentenceSplitter } from "llamaindex";
import OpenAIClient from "openai";
import { MODELS } from "./config.js";
import { cosineSimilarity, embedModel, getEmbeddings } from "./embeddingStore.js";
import { loadReferenceSet, type ReferenceRecord, type ReferenceSet } from "./referenceHarvester.js";

// アブストラクトを文単位の小チャンクへ分割する（検索精度向上のため）。
// 表示・LLM提示はアブストラクト全文を使うので、ここは検索専用の細分化。
const abstractSplitter = new SentenceSplitter({ chunkSize: 128, chunkOverlap: 24 });

// 1チャンク = 埋め込みベクトル + 所属文献(ref_index)。テキストは保持しない
// （表示・提示はレコードのアブストラクト全文を使うため）。
interface Chunk {
  refIndex: string;
  embedding: number[];
}

interface CachedReferenceIndex {
  set: ReferenceSet;
  // ref_index -> 元レコード（アブストラクト全文の復元用）
  recordByRef: Map<string, ReferenceRecord>;
  chunks: Chunk[];
}

const cache = new Map<string, Promise<CachedReferenceIndex>>();

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

async function buildReferenceIndex(id: string): Promise<CachedReferenceIndex> {
  const set = loadReferenceSet(id);
  const recordByRef = new Map<string, ReferenceRecord>();
  for (const record of set.records) {
    if (record.pubmed?.abstract?.trim()) recordByRef.set(String(record.index), record);
  }
  if (!recordByRef.size) throw new Error("No references with an abstract");

  // アブストラクトを文チャンクに分割。ref_index との対応を texts/refs で並列保持。
  const texts: string[] = [];
  const refs: string[] = [];
  for (const [key, record] of recordByRef) {
    for (const text of abstractSplitter.splitText(record.pubmed!.abstract!.trim())) {
      texts.push(text);
      refs.push(key);
    }
  }
  // 埋め込みはディスクキャッシュ経由（再起動時は再埋め込みしない）。
  const embeddings = await getEmbeddings("reference", id, texts);
  const chunks: Chunk[] = embeddings.map((embedding, i) => ({ refIndex: refs[i], embedding }));
  return { set, recordByRef, chunks };
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
  const { recordByRef, chunks } = await getReferenceIndex(setId);
  const shouldTranslate = opts.translate ?? hasJapanese(originalQuery);
  const enQuery = opts.enQuery ?? (shouldTranslate ? await translateToEnglish(originalQuery) : originalQuery);

  // クエリを埋め込み、各チャンクとのコサイン類似度を算出。
  // ref_index でグループ化し、各文献の最高スコア（＝最も刺さった文）を採用する。
  const queryVec = await embedModel().getTextEmbedding(enQuery);
  const bestByRef = new Map<string, number>();
  for (const chunk of chunks) {
    const score = cosineSimilarity(queryVec, chunk.embedding);
    const prev = bestByRef.get(chunk.refIndex);
    if (prev === undefined || score > prev) bestByRef.set(chunk.refIndex, score);
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
