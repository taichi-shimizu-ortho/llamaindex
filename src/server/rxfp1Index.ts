import { readFile } from "node:fs/promises";
import path from "node:path";
import { MODELS, PATHS } from "./config.js";
import { embedModel } from "./embeddingStore.js";
import { fileStamp, isRxfp1Body, loadRxfp1Corpus } from "./rxfp1Corpus.js";
import { RXFP1_ARTICLE_PREFIX } from "../shared/rxfp1.js";

const DIMENSIONS = 3072;
const stores = [
  { name: "TypeScript", docs: path.join(PATHS.rxfp1StorageTs, "doc_store.json"),
    vectors: path.join(PATHS.rxfp1StorageTs, "vector_store.json"), key: "embeddingDict" },
  { name: "Python", docs: path.join(PATHS.rxfp1StoragePython, "docstore.json"),
    vectors: path.join(PATHS.rxfp1StoragePython, "default__vector_store.json"), key: "embedding_dict" },
] as const;

export function rxfp1PassageKey(id: string, section: string, subsection: string, text: string) {
  return JSON.stringify([id, section, subsection, text.replace(/\r\n/g, "\n").trim()]);
}

export interface Rxfp1Index {
  store: typeof stores[number]["name"] | null;
  vectors: Map<string, Float32Array>;
  notes: string[];
}

function unitVector(values: unknown): Float32Array | undefined {
  if (!Array.isArray(values) || values.length !== DIMENSIONS || !values.every(Number.isFinite)) return;
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!norm || !Number.isFinite(norm)) return;
  return Float32Array.from(values, (value) => value / norm);
}

async function readStore(store: typeof stores[number], allowed: Set<string>): Promise<Map<string, Float32Array>> {
  const docData = JSON.parse(await readFile(store.docs, "utf8"))["docstore/data"];
  const data = JSON.parse(await readFile(store.vectors, "utf8"));
  const embeddings = data[store.key];
  if (!docData || !embeddings || typeof embeddings !== "object") throw new Error("Invalid legacy vector store.");
  const vectors = new Map<string, Float32Array>();
  for (const [id, embedding] of Object.entries(embeddings)) {
    const raw = docData[id]?.__data__;
    if (!raw) continue;
    let node;
    try {
      node = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      continue;
    }
    const meta = node?.metadata;
    if (typeof meta?.citekey !== "string" || typeof meta.section !== "string" || typeof node.text !== "string") continue;
    const key = rxfp1PassageKey(RXFP1_ARTICLE_PREFIX + meta.citekey, meta.section, meta.subsection ?? "", node.text);
    if (allowed.has(key) && !vectors.has(key)) {
      const normalized = unitVector(embedding);
      if (normalized) vectors.set(key, normalized);
    }
  }
  return vectors;
}

async function loadIndex(corpus: ReturnType<typeof loadRxfp1Corpus>, storeStamps: string[][]): Promise<Rxfp1Index> {
  const allowed = new Set<string>();
  for (const set of corpus.articles.values()) {
    for (const section of set.sections) {
      if (!isRxfp1Body(section.type, section.title)) continue;
      for (const text of section.paragraphs) allowed.add(rxfp1PassageKey(set.id, section.title, "", text));
      for (const sub of section.subsections) {
        for (const text of sub.paragraphs) allowed.add(rxfp1PassageKey(set.id, section.title, sub.title, text));
      }
    }
  }
  const notes: string[] = [];
  for (const [i, store] of stores.entries()) {
    if (!storeStamps[i].every(Boolean)) continue;
    try {
      const vectors = await readStore(store, allowed);
      if (vectors.size) return { store: store.name, vectors, notes };
      notes.push(`RXFP1 ${store.name} index has no exact matches to the available body text.`);
    } catch {
      notes.push(`Could not read the RXFP1 ${store.name} index.`);
    }
  }
  notes.push("No reusable RXFP1 vectors were available. Search uses text matching.");
  return { store: null, vectors: new Map(), notes };
}

let cached: { stamp: string; result: Promise<Rxfp1Index> } | undefined;

export function loadRxfp1Index(corpus = loadRxfp1Corpus()): Promise<Rxfp1Index> {
  const storeStamps = stores.map(({ docs, vectors }) => [fileStamp(docs), fileStamp(vectors)]);
  const stamp = JSON.stringify([corpus.stamp, storeStamps]);
  if (cached?.stamp === stamp) return cached.result;
  const result = loadIndex(corpus, storeStamps);
  cached = { stamp, result };
  return result;
}

export async function rxfp1QueryVectors(queries: string[]): Promise<Map<string, Float32Array>> {
  const unique = [...new Set(queries.filter((query) => query.trim()))];
  if (!unique.length) return new Map();
  try {
    const vectors = await embedModel(MODELS.rxfp1Embed).getTextEmbeddingsBatch(unique);
    return new Map(unique.flatMap((query, i) => {
      const normalized = unitVector(vectors[i]);
      return normalized ? [[query, normalized] as const] : [];
    }));
  } catch {
    return new Map();
  }
}

export function rxfp1Similarity(query: Float32Array, passage: Float32Array): number {
  if (query.length !== DIMENSIONS || passage.length !== DIMENSIONS) throw new Error("RXFP1 vector dimension mismatch.");
  let dot = 0;
  for (let i = 0; i < DIMENSIONS; i++) dot += query[i] * passage[i];
  return dot;
}
