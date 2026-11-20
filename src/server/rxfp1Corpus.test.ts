import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "rxfp1-corpus-test-"));
process.env.OBSIDIAN_DIR = root;
process.env.RXFP1_ARTICLES_JSON = path.join(root, "articles_all3.json");
process.env.RXFP1_MD_SOURCE_DIR = path.join(root, "markdown");
process.env.RXFP1_STORAGE_ALL_DIR = path.join(root, "typescript");
process.env.RXFP1_PYTHON_STORAGE_DIR = path.join(root, "python");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const { PATHS } = await import("./config.js");
const { loadRxfp1Corpus, parseRxfp1Markdown } = await import("./rxfp1Corpus.js");
const { loadRxfp1Index, rxfp1PassageKey } = await import("./rxfp1Index.js");
const { prepareCorpus, runCorpusQuery } = await import("./corpusRag.js");
const { loadLiterature, retrieveLiterature } = await import("./literatureEvidence.js");

const original = "Mouse articular cartilage contained a marker.";
const markdownText = "The capsular fibrosis improved following the intervention.";
const articleId = "rxfp1.Example2020";
const noteId = "rxfp1.Markdown2021";
const node = { metadata: { citekey: "Example2020", section: "Results", subsection: "" }, text: original };
const axis = Array.from({ length: 3072 }, (_, i) => i === 0 ? 1 : 0);
const currentId = "Other2022";

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

writeJson(PATHS.rxfp1Articles, { articles: [{
  citekey: "Example2020", title: "Example report", doi: "10.1234/example", published: "2020",
  authors: ["Example"], is_review: false, sections: [{ title: "Results", type: "results", content: original }],
}] });
fs.mkdirSync(PATHS.rxfp1MarkdownDir, { recursive: true });
fs.writeFileSync(path.join(PATHS.rxfp1MarkdownDir, "Markdown2021.md"), `---
title: Markdown report
citekey: Markdown2021
doi: 10.1234/markdown
---
# 1 Notes
Personal observations
# 4 Main Text
%% begin main-content %%
## Results
${markdownText}
## References
A separate work.
`);
fs.writeFileSync(path.join(PATHS.rxfp1MarkdownDir, "Duplicate2020.md"), `---
title: Example report
citekey: Duplicate2020
doi: 10.1234/example
---
# 4 Main Text
## Results
Duplicated work under a different citekey.
`);
writeJson(path.join(PATHS.articleOutputDir, currentId + ".json"), {
  id: currentId, title: "Current library only", authors: [], sections: [],
});
const tsEmbeddings = path.join(PATHS.rxfp1StorageTs, "vector_store.json");
writeJson(path.join(PATHS.rxfp1StorageTs, "doc_store.json"), { "docstore/data": {
  exact: { __data__: node },
  wrongText: { __data__: { ...node, text: "Different source text." } },
  wrongSection: { __data__: { ...node, metadata: { ...node.metadata, section: "Discussion" } } },
} });
writeJson(tsEmbeddings, { embeddingDict: { exact: axis, wrongText: axis, wrongSection: axis, missing: axis } });
writeJson(path.join(PATHS.rxfp1StoragePython, "docstore.json"), {
  "docstore/data": { exact: { __data__: JSON.stringify(node) } },
});
writeJson(path.join(PATHS.rxfp1StoragePython, "default__vector_store.json"), { embedding_dict: { exact: axis } });

test("scopes archive data, preserves Markdown body, and labels callout abstracts", () => {
  const archive = loadRxfp1Corpus();
  assert.deepEqual([...archive.articles.keys()], [articleId, noteId]);
  assert(!loadLiterature().sources.some((source) => source.id === noteId));
  assert(!loadLiterature("rxfp1").sources.some((source) => source.id === currentId));
  assert.equal(archive.articles.get(noteId)?.sections[0].paragraphs[0], markdownText);

  const abstract = parseRxfp1Markdown(`---
title: Abstract report
citekey: Abstract2023
---
> [!Abstract]
> This is only an abstract.
# 4 Main Text
`, "Abstract2023");
  assert.deepEqual(abstract?.sections.map((s) => s.type), ["abstract"]);
});

test("uses exact TypeScript vectors and finds Markdown passages with text matching", async () => {
  const index = await loadRxfp1Index();
  assert.equal(index.store, "TypeScript");
  assert.deepEqual([...index.vectors.keys()], [rxfp1PassageKey(articleId, "Results", "", original)]);
  const prep = await prepareCorpus([articleId, noteId]);
  assert.equal(prep.rxfp1?.vectors, 1);
  assert.equal(prep.totalParagraphs, 2);
  await assert.rejects(prepareCorpus([articleId, currentId]), /own search scope/);
  const query = "capsular fibrosis improved";
  const result = await runCorpusQuery([articleId, noteId], query, {
    translate: false, topK: 2, sectionGroups: ["results"],
  }, {
    rxfp1QueryVectors: async () => new Map([[query, Float32Array.from(axis)]]),
    synthesize: async () => ({ model: "fixture", text: "Fixture [S1]" }),
  });
  assert(result.sources.some((s) => s.ranking === "legacy_vector" && s.text === original));
  assert(result.sources.some((s) => s.ranking === "text_match" && s.text === markdownText));

  const retrieval = retrieveLiterature(loadLiterature("rxfp1"), {
    request_id: "fixture", claim_id: null, query, cited_source_ids: ["4"], mode: "both",
  }, { "4": "doi:10.1234/markdown" }, { index, query: Float32Array.from(axis) });
  assert.equal(retrieval.source_checks[0].status, "resolved");
  assert(retrieval.evidence.some((e) => e.retrieval_origin === "cited_source" && e.excerpt === markdownText));
  assert(retrieval.evidence.some((e) => e.retrieval_origin === "broader_search" && e.excerpt === original));
});

test("falls back to the Python vector store when TypeScript is invalid", async () => {
  fs.writeFileSync(tsEmbeddings, "truncated");
  const index = await loadRxfp1Index();
  assert.equal(index.store, "Python");
  assert.equal(index.vectors.size, 1);
  assert.match(index.notes.join(" "), /TypeScript/);
});
