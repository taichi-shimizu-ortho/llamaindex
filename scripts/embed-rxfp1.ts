import { MODELS } from "../src/server/config.js";
import { embedModel } from "../src/server/embeddingStore.js";
import { loadRxfp1Corpus } from "../src/server/rxfp1Corpus.js";
import {
  loadRxfp1Index, rxfp1VectorPassages, saveRxfp1PaperVectors, unitRxfp1Vector,
} from "../src/server/rxfp1Index.js";

const args = process.argv.slice(2);
if (args.length > 1 || (args[0] && args[0] !== "--dry-run")) {
  throw new Error("Usage: npm run embed:rxfp1 -- [--dry-run]");
}

const corpus = loadRxfp1Corpus();
if (!corpus.articles.size || corpus.errors.length) {
  throw new Error(corpus.errors.join("\n") || "The RXFP1 folder has no articles.");
}

const index = await loadRxfp1Index(corpus);
const papers = [...corpus.articles.values()].map((paper) => ({ id: paper.id, passages: rxfp1VectorPassages(paper) }));
const withoutText = papers.filter(({ passages }) => !passages.size);
if (withoutText.length) throw new Error(`No indexable text for ${withoutText.map(({ id }) => id).join(", ")}`);

const total = papers.reduce((count, paper) => count + paper.passages.size, 0);
const pending = papers.filter(({ id }) => !index.cachedPapers.has(id));
console.log(JSON.stringify({
  papers: papers.length, passages: total, reusable: index.vectors.size,
  toEmbed: total - index.vectors.size, papersToSave: pending.length,
}));

if (args[0] !== "--dry-run" && pending.length) {
  const model = embedModel(MODELS.rxfp1Embed);

  function splitForEmbedding(text: string): string[] {
    if (model.truncateMaxTokens([text])[0] === text) return [text];
    const characters = Array.from(text);
    const middle = Math.floor(characters.length / 2);
    const firstHalf = characters.slice(0, middle).join("");
    const space = Math.max(firstHalf.lastIndexOf(" "), firstHalf.lastIndexOf("\n"));
    const cut = space > firstHalf.length / 2 ? space : firstHalf.length;
    return [...splitForEmbedding(text.slice(0, cut).trim()), ...splitForEmbedding(text.slice(cut).trim())];
  }

  let next = 0;
  async function savePending() {
    while (next < pending.length) {
      const paper = pending[next++];
      const vectors = new Map<string, Float32Array>();
      const requested = [];
      for (const [key, text] of paper.passages) {
        const reused = index.vectors.get(key);
        if (reused) vectors.set(key, reused);
        else requested.push({ key, parts: splitForEmbedding(text) });
      }
      const parts = requested.flatMap(({ parts }) => parts);
      const embeddings = parts.length ? await model.getTextEmbeddingsBatch(parts) : [];
      if (embeddings.length !== parts.length) throw new Error(`Embedding count mismatch for ${paper.id}`);
      let offset = 0;
      for (const { key, parts } of requested) {
        const first = unitRxfp1Vector(embeddings[offset]);
        if (!first) throw new Error(`Invalid vector for ${paper.id}`);
        const combined = Array.from(first, (value) => value * parts[0].length);
        for (let i = 1; i < parts.length; i++) {
          const vector = unitRxfp1Vector(embeddings[offset + i]);
          if (!vector) throw new Error(`Invalid vector for ${paper.id}`);
          for (let j = 0; j < vector.length; j++) combined[j] += vector[j] * parts[i].length;
        }
        const vector = unitRxfp1Vector(combined);
        if (!vector) throw new Error(`Invalid averaged vector for ${paper.id}`);
        vectors.set(key, vector);
        offset += parts.length;
      }
      await saveRxfp1PaperVectors(paper.id, vectors);
      console.log(`${paper.id}: ${vectors.size} saved (${requested.length} newly embedded)`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(3, pending.length) }, () => savePending()));
  const result = await loadRxfp1Index();
  if (result.vectors.size !== total || result.cachedPapers.size !== papers.length) {
    throw new Error("RXFP1 changed or some vectors could not be read. Run the command again.");
  }
  console.log(JSON.stringify({ verifiedPapers: result.cachedPapers.size, verifiedPassages: result.vectors.size }));
}
