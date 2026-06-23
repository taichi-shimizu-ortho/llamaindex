// [STEP 52 移植] 検索ロジック: 翻訳 → ベクトル検索 → 回答合成 → 引用元整形
import fs from "node:fs";
import { Settings, VectorStoreIndex, storageContextFromDefaults } from "llamaindex";
import { OpenAI, OpenAIEmbedding } from "@llamaindex/openai";
import OpenAIClient from "openai";
import { PATHS, MODELS } from "./config.js";
import type { QueryResult, SourceNode } from "../shared/types.js";

let indexPromise: Promise<VectorStoreIndex> | null = null;

function ensureSettings() {
  Settings.llm = new OpenAI({ model: MODELS.llm, temperature: 0.1 });
  Settings.embedModel = new OpenAIEmbedding({ model: MODELS.embed });
}

export function indexExists(): boolean {
  return fs.existsSync(PATHS.storageAll) && fs.readdirSync(PATHS.storageAll).length > 0;
}

async function loadIndex(): Promise<VectorStoreIndex> {
  if (!indexExists()) {
    throw new Error(`インデックスが見つかりません: ${PATHS.storageAll}\n先に npm run build-index を実行してください`);
  }
  ensureSettings();
  const storageContext = await storageContextFromDefaults({ persistDir: PATHS.storageAll });
  return VectorStoreIndex.init({ storageContext });
}

export function getIndex(): Promise<VectorStoreIndex> {
  if (!indexPromise) indexPromise = loadIndex();
  return indexPromise;
}

export function reloadIndex(): Promise<VectorStoreIndex> {
  indexPromise = loadIndex();
  return indexPromise;
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

// 日本語を含むか簡易判定
function hasJapanese(s: string): boolean {
  return /[぀-ヿ㐀-鿿]/.test(s);
}

export interface QueryOptions {
  topK?: number;
  translate?: boolean; // 日本語→英語翻訳するか（デフォルト: 自動）
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

export async function runQuery(originalQuery: string, opts: QueryOptions = {}): Promise<QueryResult> {
  const topK = opts.topK ?? 5;
  const index = await getIndex();

  // 翻訳（明示指定がなければ日本語検出時のみ）
  const shouldTranslate = opts.translate ?? hasJapanese(originalQuery);
  const enQuery = shouldTranslate ? await translateToEnglish(originalQuery) : originalQuery;

  const queryEngine = index.asQueryEngine({ similarityTopK: topK });
  const response: any = await queryEngine.query({ query: enQuery });

  const answer: string =
    response?.response ?? response?.message?.content ?? String(response ?? "");

  const rawNodes: any[] = response?.sourceNodes ?? [];
  const sources: SourceNode[] = rawNodes
    .map((nws): SourceNode => {
      const node = nws.node ?? nws;
      const meta = node.metadata ?? {};
      return {
        source: "All",
        score: typeof nws.score === "number" ? nws.score : 0,
        citekey: meta.citekey ?? "?",
        title: meta.title ?? "",
        authors: meta.authors ?? "",
        journal: meta.source ?? "", // 構造化JSONの source = ジャーナル名
        published: meta.published ?? "",
        volume: meta.volume ?? "",
        issue: meta.issue ?? "",
        section: meta.section ?? "",
        subsection: meta.subsection ?? "",
        section_type: meta.section_type ?? "",
        paragraph_index: meta.paragraph_index ?? "",
        total_paragraphs: meta.total_paragraphs ?? "",
        doi: meta.doi ?? "",
        pmid: meta.pmid ?? "",
        tags: meta.tags ?? "",
        mesh_terms: meta.mesh_terms ?? "",
        text: nodeText(node),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return {
    original_query: originalQuery,
    en_query: enQuery,
    answer,
    targets: ["All"],
    sources,
  };
}
