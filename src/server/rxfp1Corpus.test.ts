import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "rxfp1-corpus-test-"));
process.env.OBSIDIAN_DIR = root;
// 正本（article-ingest）も一時フォルダを見る。実データ（Dropbox の箱）を読まない。
process.env.ARTICLE_JSON_DATA_HOME = path.join(root, "article-json");
process.env.RXFP1_ARTICLES_JSON = path.join(root, "articles_all3.json");
process.env.RXFP1_MD_SOURCE_DIR = path.join(root, "markdown");
process.env.RXFP1_STORAGE_ALL_DIR = path.join(root, "typescript");
process.env.RXFP1_PYTHON_STORAGE_DIR = path.join(root, "python");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const { PATHS } = await import("./config.js");
const { loadLegacyRxfp1Corpus, loadRxfp1Corpus, parseRxfp1Markdown } = await import("./rxfp1Corpus.js");
const { loadRxfp1Index, rxfp1PassageKey, rxfp1VectorPassages, saveRxfp1PaperVectors } = await import("./rxfp1Index.js");
const { harvestArticle, listArticleSets } = await import("./articleHarvester.js");
const { prepareCorpus, runCorpusQuery } = await import("./corpusRag.js");
const { loadLiterature, retrieveLiterature } = await import("./literatureEvidence.js");
const { writeLibrary } = await import("./library.js");

const original = "Mouse articular cartilage contained a marker.";
const markdownText = "The capsular fibrosis improved following the intervention.";
const articleId = "rxfp1.Example_2020";
const noteId = "rxfp1.Markdown2021";
const node = { metadata: { citekey: "Example&2020", section: "Results", subsection: "" }, text: original };
const axis = Array.from({ length: 3072 }, (_, i) => i === 0 ? 1 : 0);
const currentId = "Other2022";
const importedId = "Imported2021";

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

writeJson(PATHS.rxfp1Articles, { articles: [{
  citekey: "Example&2020", title: "Example report1", doi: "10.1234/example", published: "2020",
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
  id: currentId, title: "Current library only", authors: [], sections: [], createdAt: "",
});
writeJson(path.join(PATHS.articleOutputDir, importedId + ".json"), {
  id: importedId, title: "Markdown report", authors: [], year: "2021", doi: "10.1234/markdown", createdAt: "",
  sections: [{ title: "Results", type: "results", paragraphs: [markdownText], subsections: [] }],
});
writeLibrary({
  folders: [
    { id: "rx", name: "RXFP1", parentId: null, createdAt: "" },
    { id: "child", name: "New papers", parentId: "rx", createdAt: "" },
  ],
  assignments: { [importedId]: "child" },
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

test("keeps legacy Markdown as a migration input and labels callout abstracts", () => {
  const source = loadLegacyRxfp1Corpus();
  assert.deepEqual([...source.articles.keys()], [articleId, noteId]);
  assert.equal(source.articles.get(noteId)?.sections[0].paragraphs[0], markdownText);
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

test("migrates once, reuses equivalent articles, and reads only per-article JSON at runtime", () => {
  const apply = () => spawnSync(process.execPath, ["--import", "tsx", "scripts/migrate-rxfp1.ts", "--apply"], {
    encoding: "utf8",
  });
  const first = apply();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /"newArticles": 1/);
  assert(!fs.existsSync(path.join(PATHS.articleOutputDir, noteId + ".json")));
  assert.deepEqual(loadRxfp1Corpus().articles.get(importedId)?.legacyRxfp1Ids, [noteId]);
  const retry = apply();
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /"plannedWrites": 0/);
  fs.renameSync(PATHS.rxfp1Articles, PATHS.rxfp1Articles + ".original");
  fs.renameSync(PATHS.rxfp1MarkdownDir, PATHS.rxfp1MarkdownDir + ".original");
  const corpus = loadLiterature("rxfp1_combined");
  assert(!corpus.sources.some((s) => s.id === currentId));
  assert(corpus.sources.some((s) => s.id === articleId));
  assert(loadLiterature().sources.some((s) => s.id === articleId));
  const result = retrieveLiterature(corpus, {
    request_id: "combined", claim_id: null, query: "capsular fibrosis", cited_source_ids: ["1", "2"], mode: "verify_cited_sources",
  }, { "1": '"Example report," Journal (2020).', "2": "10.1234/markdown" });
  assert.deepEqual(result.source_checks.map((check) => [check.article_id, check.status]), [
    [articleId, "resolved"], [importedId, "resolved"],
  ]);
});

test("uses exact TypeScript vectors and finds current passages with text matching", async () => {
  const index = await loadRxfp1Index();
  assert.equal(index.store, "TypeScript");
  assert.deepEqual([...index.vectors.keys()], [rxfp1PassageKey(articleId, "Results", "", original)]);
  const prep = await prepareCorpus([articleId, noteId]);
  assert.equal(prep.rxfp1?.vectors, 1);
  assert.equal(prep.totalParagraphs, 2);
  assert(prep.papers.some((paper) => paper.id === importedId));
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

test("uses saved RXFP1 vectors alongside the archive and drops vectors for changed text", async () => {
  const key = rxfp1PassageKey(importedId, "Results", "", markdownText);
  await saveRxfp1PaperVectors(importedId, new Map([[key, Float32Array.from(axis)]]));
  let index = await loadRxfp1Index();
  assert.equal(index.store, "RXFP1");
  assert(index.cachedPapers.has(importedId));
  assert.equal((await prepareCorpus([articleId, noteId])).rxfp1?.vectors, 2);

  const article = loadRxfp1Corpus().articles.get(importedId)!;
  const figure = {
    title: "Figure 1", type: "figure", content: "", subsections: [],
    paragraphs: ["A caption.\n[Image URL: data:image/png;base64,abc]", "[Image URL: data:image/png;base64,xyz]"],
  };
  const sections = [
    { ...article.sections[0], paragraphs: ["The current text is different."] },
    figure,
  ];
  assert.deepEqual([...rxfp1VectorPassages({ ...article, sections }).values()], ["The current text is different.", "A caption."]);
  writeJson(path.join(PATHS.articleOutputDir, importedId + ".json"), { ...article, sections });
  index = await loadRxfp1Index();
  assert(!index.vectors.has(key));
  assert(!index.cachedPapers.has(importedId));
  const prep = await prepareCorpus([articleId, noteId]);
  assert.equal(prep.totalParagraphs, 3);
  assert.equal(prep.rxfp1?.vectors, 1);
});

test("a DOI reimport updates the same article and keeps the migrated alias", async () => {
  const html = `<meta name="citation_doi" content="10.1234/markdown">
    <meta name="citation_title" content="Markdown report"><meta name="citation_author" content="A Different">
    <meta name="citation_publication_date" content="2021/01/01">
    <article><h2>Results</h2><p>${markdownText}</p></article>`;
  const result = await harvestArticle({ html });
  assert.equal(result.id, importedId);
  assert.deepEqual(result.legacyRxfp1Ids, [noteId]);
  assert.equal(listArticleSets().filter((set) => set.doi === "10.1234/markdown").length, 1);
});
