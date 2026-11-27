// 埋め込みベクトルのディスクキャッシュ + コサイン類似度検索の共通処理。
// reference / article の両RAGで共有し、再起動時の再埋め込みを避ける。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { OpenAIEmbedding } from "@llamaindex/openai";
import { MODELS, PATHS } from "./config.js";

const embeddingModels = new Map<string, OpenAIEmbedding>();
export function embedModel(model = MODELS.embed): OpenAIEmbedding {
  let instance = embeddingModels.get(model);
  if (!instance) {
    instance = new OpenAIEmbedding({ model });
    embeddingModels.set(model, instance);
  }
  return instance;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function cacheFilePath(namespace: string, id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(PATHS.embeddingCacheDir, namespace, `${safe}.json`);
}

// モデル名 + 全テキストからシグネチャを作る。
// テキストが1つでも変われば（=分割設定や本文が変われば）自動的にキャッシュ無効化。
function signatureOf(texts: string[]): string {
  const h = crypto.createHash("sha256");
  h.update(MODELS.embed);
  for (const text of texts) {
    h.update("\n\u0000");
    h.update(text);
  }
  return h.digest("hex");
}

function loadCache(namespace: string, id: string, signature: string): number[][] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFilePath(namespace, id), "utf-8"));
    if (raw?.model === MODELS.embed && raw?.signature === signature && Array.isArray(raw.embeddings)) {
      return raw.embeddings as number[][];
    }
  } catch {
    /* キャッシュ無し・破損時は再構築 */
  }
  return null;
}

// 保存済みの埋め込みだけを返す（API は呼ばない）。texts が保存時と違えば null。
export function cachedEmbeddings(namespace: string, id: string, texts: string[]): number[][] | null {
  const cached = loadCache(namespace, id, signatureOf(texts));
  return cached && cached.length === texts.length ? cached : null;
}

function saveCache(namespace: string, id: string, signature: string, embeddings: number[][]): void {
  const file = cacheFilePath(namespace, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ model: MODELS.embed, signature, embeddings }));
}

// テキスト配列に対応する埋め込みを返す。キャッシュがあれば再埋め込みせず読み込む。
// 返る順序は texts と一致するので、呼び出し側はインデックスでメタデータに紐付ける。
export async function getEmbeddings(
  namespace: string,
  id: string,
  texts: string[],
): Promise<number[][]> {
  const signature = signatureOf(texts);
  const cached = loadCache(namespace, id, signature);
  if (cached && cached.length === texts.length) return cached;

  const embeddings = (await embedModel().getTextEmbeddingsBatch(texts)).map((vec) =>
    // 精度は検索順位に十分な範囲で丸め、キャッシュサイズを抑える。
    vec.map((v) => Number(v.toFixed(6))),
  );
  saveCache(namespace, id, signature, embeddings);
  return embeddings;
}
