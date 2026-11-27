import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "canonical-store-test-"));
process.env.OBSIDIAN_DIR = root;
process.env.ARTICLE_JSON_DATA_HOME = path.join(root, "article-json");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const { PATHS } = await import("./config.js");
const { articleIdForDoi, articleSetSourcePath, listArticleSets, loadArticleSet, resolveArticleId } = await import("./articleHarvester.js");
const { loadReferenceSet } = await import("./referenceHarvester.js");
const { writeCanonicalClassification, canonicalEntries } = await import("./canonicalStore.js");

const canonicalDir = path.join(root, "article-json", "articles");
fs.mkdirSync(canonicalDir, { recursive: true });
fs.mkdirSync(PATHS.articleOutputDir, { recursive: true });
fs.mkdirSync(PATHS.referenceOutputDir, { recursive: true });

const para = (id: string, text: string) => ({ id, text, marks: [], refIds: [], figIds: [], tableIds: [], sentences: [] });
function canonical(id: string, doi: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    meta: { doi, title: `Canonical ${id}`, authors: [{ full: "Ann Tester", surname: "Tester", affiliations: [] }], keywords: [], year: "2026" },
    abstract: [{ id: "a1", level: 1, type: "abstract", paragraphs: [para("a1-p1", "Abstract text.")], sections: [] }],
    sections: [{ id: "s1", title: "Introduction", level: 1, type: "introduction", paragraphs: [para("s1-p1", "Canonical body.")], sections: [] }],
    figures: [{ xmlId: "F1", label: "Figure 1", caption: "A figure.", graphics: [], files: ["f1.png"] }],
    tables: [],
    references: [{ doi: "10.1/ref", title: "A cited study", authors: ["Smith J"], year: "2020" }],
    warnings: [],
    source: { flavor: "jats", file: `${id}.xml`, sha256: "x", parsedAt: "2026-11-27T00:00:00.000Z" },
    ...extra,
  };
}
const legacy = (id: string, doi: string, extra: Record<string, unknown> = {}) => ({
  id, sourceUrl: "", title: `Legacy ${id}`, authors: ["Old Author"], journal: "J", year: "2026", doi,
  createdAt: "2026-01-01T00:00:00.000Z", sections: [{ title: "Intro", type: "intro", content: "Legacy body.", paragraphs: ["Legacy body."], subsections: [] }],
  chunkCount: 1, extractionSource: "local-mhtml-offline", ...extra,
});
const write = (file: string, data: unknown) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");

// Martins2026 は旧 JSON と正本の両方にある（別名なし）。Smith2025 は正本だけ（別名あり）。Grassi2020 は PDF 由来の旧 JSON だけ。
write(path.join(canonicalDir, "10-1-martins.json"), canonical("10-1-martins", "10.1/martins"));
write(path.join(canonicalDir, "10-1-smith.json"), canonical("10-1-smith", "10.1/smith", { aliases: ["Smith2025"] }));
write(path.join(PATHS.articleOutputDir, "Martins2026.json"), legacy("Martins2026", "10.1/martins"));
write(path.join(PATHS.articleOutputDir, "Grassi2020.json"), legacy("Grassi2020", "10.1/grassi", { extractionSource: "pdf" }));
write(path.join(PATHS.referenceOutputDir, "Martins2026.json"), {
  id: "Martins2026", title: "Legacy", sourceUrl: "", totalReferences: 1, abstractFound: 1, createdAt: "2026-01-01T00:00:00.000Z", pubmedFound: 1,
  records: [{ index: 1, text: "Smith J. A cited study.", sourceUrl: "", href: "", doi: "10.1/REF", pmid: "", pubmedFound: true,
    pubmed: { pmid: "123", doi: "10.1/ref", title: "A cited study", abstract: "PubMed abstract.", authors: [], journal: "", year: "2020", publicationTypes: [] } }],
});

test("the catalog prefers the canonical article for a shared DOI and keeps the citation key", () => {
  const ids = listArticleSets().map((s) => s.id).sort();
  assert.deepEqual(ids, ["Grassi2020", "Martins2026", "Smith2025"]);
  const martins = loadArticleSet("Martins2026");
  assert.equal(martins.canonicalId, "10-1-martins");
  assert.equal(martins.extractionSource, "article-json:jats");
  assert.ok(martins.sections.some((s) => s.paragraphs.includes("Canonical body.")));
  assert.equal(articleSetSourcePath("Martins2026"), path.join(canonicalDir, "10-1-martins.json"));
});

test("papers only in article_sets (PDF) are read as before", () => {
  const grassi = loadArticleSet("Grassi2020");
  assert.equal(grassi.extractionSource, "pdf");
  assert.equal(grassi.canonicalId, undefined);
  assert.equal(articleSetSourcePath("Grassi2020"), path.join(PATHS.articleOutputDir, "Grassi2020.json"));
});

test("canonical ids, aliases and DOIs resolve to the catalog id", () => {
  assert.equal(resolveArticleId("10-1-martins"), "Martins2026");
  assert.equal(resolveArticleId("10-1-smith"), "Smith2025");
  assert.equal(articleIdForDoi("https://doi.org/10.1/MARTINS"), "Martins2026");
  assert.equal(articleIdForDoi("10.1/grassi"), "Grassi2020");
});

test("figures point at the read-only canonical figure route", () => {
  const figure = loadArticleSet("Smith2025").sections.find((s) => s.type === "figure");
  assert.ok(figure?.content.includes("[Image URL: /canonical-figures/10-1-smith/f1.png]"), figure?.content);
});

test("canonical references carry the PubMed abstract from the old reference set", () => {
  const refs = loadReferenceSet("Martins2026");
  assert.equal(refs.records.length, 1);
  assert.equal(refs.records[0].pubmed?.abstract, "PubMed abstract.");
  assert.equal(refs.records[0].pmid, "123");
  assert.equal(refs.abstractFound, 1);
  assert.equal(loadReferenceSet("Smith2025").records[0].pubmed, undefined);
});

test("classification writes only classification and meta.pmid into the canonical JSON", () => {
  const file = path.join(canonicalDir, "10-1-smith.json");
  const before = JSON.parse(fs.readFileSync(file, "utf8"));
  const entry = canonicalEntries().find((e) => e.canonicalId === "10-1-smith")!;
  writeCanonicalClassification(entry, { articleType: "review", source: "pubmed", publicationTypes: ["Review"], checkedAt: "2026-11-27T01:00:00.000Z" }, "999");
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(after.classification, { articleType: "review", source: "pubmed", publicationTypes: ["Review"], checkedAt: "2026-11-27T01:00:00.000Z" });
  assert.equal(after.meta.pmid, "999");
  delete after.classification;
  delete after.meta.pmid;
  assert.deepEqual(after, before);
  assert.ok(fs.readFileSync(file, "utf8").endsWith("}\n"));
  const smith = loadArticleSet("Smith2025");
  assert.equal(smith.articleType, "review");
  assert.equal(smith.pubmedCheckedAt, "2026-11-27T01:00:00.000Z");
});
