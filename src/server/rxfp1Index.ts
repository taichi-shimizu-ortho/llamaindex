import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ArticleSet } from "./articleHarvester.js";
import { MODELS, PATHS } from "./config.js";
import { embedModel } from "./embeddingStore.js";
import { fileStamp, isRxfp1Body, loadRxfp1Corpus } from "./rxfp1Corpus.js";
import { rxfp1ArticleId } from "../shared/rxfp1.js";

const DIMENSIONS = 3072;
const stores = [
  { name: "TypeScript", docs: path.join(PATHS.rxfp1StorageTs, "doc_store.json"),
    vectors: path.join(PATHS.rxfp1StorageTs, "vector_store.json"), key: "embeddingDict" },
  { name: "Python", docs: path.join(PATHS.rxfp1StoragePython, "docstore.json"),
    vectors: path.join(PATHS.rxfp1StoragePython, "default__vector_store.json"), key: "embedding_dict" },
] as const;

export function rxfp1PassageText(text: string): string {
  return text.replace(/\[Image URL:[^\]]*\]/gi, "").replace(/\r\n/g, "\n").trim();
}

export function rxfp1PassageKey(id: string, section: string, subsection: string, text: string) {
  return JSON.stringify([id, section, subsection, rxfp1PassageText(text)]);
}

export function rxfp1VectorPassages(set: ArticleSet): Map<string, string> {
  const passages = new Map<string, string>();
  for (const section of set.sections) {
    if (!isRxfp1Body(section.type, section.title)) continue;
    const groups = [{ title: "", paragraphs: section.paragraphs }, ...section.subsections];
    for (const group of groups) {
      if (!isRxfp1Body("", group.title)) continue;
      for (const raw of group.paragraphs) {
        const text = rxfp1PassageText(raw);
        if (text) passages.set(rxfp1PassageKey(set.id, section.title, group.title, text), text);
      }
    }
  }
  return passages;
}

export interface Rxfp1Index {
  store: "RXFP1" | typeof stores[number]["name"] | null;
  vectors: Map<string, Float32Array>;
  cachedPapers: Set<string>;
  notes: string[];
}

export function unitRxfp1Vector(values: unknown): Float32Array | undefined {
  if (!Array.isArray(values) || values.length !== DIMENSIONS || !values.every(Number.isFinite)) return;
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!norm || !Number.isFinite(norm)) return;
  return Float32Array.from(values, (value) => value / norm);
}

function vectorFile(id: string): string {
  return path.join(PATHS.embeddingCacheDir, "rxfp1", `${id.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
}

const passageHash = (key: string) => createHash("sha256").update(key).digest("hex");

export async function saveRxfp1PaperVectors(id: string, vectors: Map<string, Float32Array>): Promise<void> {
  const file = vectorFile(id);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  const passages = Object.fromEntries([...vectors].map(([key, vector]) => [
    passageHash(key), Array.from(vector, (value) => Number(value.toFixed(7))),
  ]));
  try {
    await writeFile(temporary, JSON.stringify({ model: MODELS.rxfp1Embed, passages }));
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readPaperVectors(id: string, keys: Iterable<string>, vectors: Map<string, Float32Array>): Promise<number> {
  const { model, passages } = JSON.parse(await readFile(vectorFile(id), "utf8"));
  if (model !== MODELS.rxfp1Embed || !passages || typeof passages !== "object" || Array.isArray(passages)) return 0;
  let matches = 0;
  for (const key of keys) {
    const vector = unitRxfp1Vector(passages[passageHash(key)]);
    if (!vector) continue;
    vectors.set(key, vector);
    matches++;
  }
  return matches;
}

async function readStore(store: typeof stores[number], allowed: Set<string>, ids: Map<string, string>): Promise<Map<string, Float32Array>> {
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
    const idForPaper = ids.get(rxfp1ArticleId(meta.citekey));
    if (!idForPaper) continue;
    const key = rxfp1PassageKey(idForPaper, meta.section, meta.subsection ?? "", node.text);
    if (allowed.has(key) && !vectors.has(key)) {
      const normalized = unitRxfp1Vector(embedding);
      if (normalized) vectors.set(key, normalized);
    }
  }
  return vectors;
}

async function loadIndex(corpus: ReturnType<typeof loadRxfp1Corpus>, storeStamps: string[][], paperStamps: Map<string, string>): Promise<Rxfp1Index> {
  const allowed = new Set<string>();
  const ids = new Map<string, string>();
  const vectors = new Map<string, Float32Array>();
  const cachedPapers = new Set<string>();
  const notes = [...corpus.errors];
  for (const set of corpus.articles.values()) {
    for (const legacyId of [set.id, ...(set.legacyRxfp1Ids ?? [])]) ids.set(legacyId, set.id);
    const passages = rxfp1VectorPassages(set);
    for (const key of passages.keys()) allowed.add(key);
    if (!paperStamps.get(set.id)) continue;
    try {
      const matches = await readPaperVectors(set.id, passages.keys(), vectors);
      if (matches && matches === passages.size) cachedPapers.add(set.id);
    } catch {
      notes.push(`Could not read the RXFP1 vectors for ${set.id}.`);
    }
  }
  const currentStore = vectors.size ? "RXFP1" : null;
  if (currentStore && vectors.size === allowed.size) return { store: currentStore, vectors, cachedPapers, notes };

  for (const key of vectors.keys()) allowed.delete(key);
  for (const [i, store] of stores.entries()) {
    if (!storeStamps[i].every(Boolean)) continue;
    try {
      const reused = await readStore(store, allowed, ids);
      if (reused.size) {
        for (const [key, vector] of reused) vectors.set(key, vector);
        return { store: currentStore ?? store.name, vectors, cachedPapers, notes };
      }
      notes.push(`RXFP1 ${store.name} index has no exact matches to the available body text.`);
    } catch {
      notes.push(`Could not read the RXFP1 ${store.name} index.`);
    }
  }
  if (!vectors.size) notes.push("No reusable RXFP1 vectors were available. Search uses text matching.");
  return { store: currentStore, vectors, cachedPapers, notes };
}

let cached: { stamp: string; result: Promise<Rxfp1Index> } | undefined;

export function loadRxfp1Index(corpus = loadRxfp1Corpus()): Promise<Rxfp1Index> {
  const storeStamps = stores.map(({ docs, vectors }) => [fileStamp(docs), fileStamp(vectors)]);
  const paperStamps = new Map([...corpus.articles.keys()].map((id) => [id, fileStamp(vectorFile(id))]));
  const stamp = JSON.stringify([corpus.stamp, storeStamps, [...paperStamps]]);
  if (cached?.stamp === stamp) return cached.result;
  const result = loadIndex(corpus, storeStamps, paperStamps);
  cached = { stamp, result };
  return result;
}

export async function rxfp1QueryVectors(queries: string[]): Promise<Map<string, Float32Array>> {
  const unique = [...new Set(queries.filter((query) => query.trim()))];
  if (!unique.length) return new Map();
  try {
    const vectors = await embedModel(MODELS.rxfp1Embed).getTextEmbeddingsBatch(unique);
    return new Map(unique.flatMap((query, i) => {
      const normalized = unitRxfp1Vector(vectors[i]);
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
