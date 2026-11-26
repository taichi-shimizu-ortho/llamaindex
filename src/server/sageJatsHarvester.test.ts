import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jats-harvester-test-"));
process.env.OBSIDIAN_DIR = root;
after(() => fs.rmSync(root, { recursive: true, force: true }));

const { jatsCitationBaseId, parseJatsArticle, parseJatsAuthors } = await import("./sageJatsHarvester.js");
const { harvestArticle } = await import("./articleHarvester.js");

// PMC の JATS と同じ形: contrib-id を持つ著者、別グループの編集者、節見出しの <title>。
const jats = `<?xml version="1.0"?>
<article article-type="research-article">
<front>
<journal-meta><journal-title-group><journal-title>Orthopaedic Journal of Sports Medicine</journal-title></journal-title-group></journal-meta>
<article-meta>
<article-id pub-id-type="doi">10.1177/test.2026</article-id>
<title-group><article-title>Sacroiliac Joint Stress Test Article</article-title></title-group>
<contrib-group>
<contrib contrib-type="author"><contrib-id contrib-id-type="orcid">https://orcid.org/0000-0000-0000-0000</contrib-id><name name-style="western"><surname>Nagashima</surname><given-names initials="R">Ryo</given-names></name><degrees>PT</degrees><xref rid="aff1" ref-type="aff">*</xref></contrib>
<contrib contrib-type="author"><name><surname>Yukizawa</surname><given-names>Yohei</given-names></name></contrib>
<contrib contrib-type="author"><collab>Hip Study Group</collab></contrib>
</contrib-group>
<contrib-group><contrib contrib-type="editor"><name><surname>Editor</surname><given-names>Ed</given-names></name></contrib></contrib-group>
<pub-date pub-type="epub"><day>26</day><month>3</month><year>2026</year></pub-date>
<abstract><sec><title>Background:</title><p>Background text from 2025 cohort.</p></sec></abstract>
</article-meta>
</front>
<body><sec><title>Introduction</title><p>Intro paragraph.</p></sec></body>
</article>`;

test("JATS authors are read from the contrib start tag, skipping contrib-id and editors", () => {
  const meta = jats.match(/<article-meta>([\s\S]*?)<\/article-meta>/)![1];
  assert.deepEqual(parseJatsAuthors(meta), ["Ryo Nagashima", "Yohei Yukizawa", "Hip Study Group"]);
});

test("parsed JATS article carries authors and journal", () => {
  const set = parseJatsArticle(jats, { id: "x", sourceUrl: "" })!;
  assert.deepEqual(set.authors, ["Ryo Nagashima", "Yohei Yukizawa", "Hip Study Group"]);
  assert.equal(set.journal, "Orthopaedic Journal of Sports Medicine");
});

test("JATS-only citation ID uses the first author's surname and publication year", () => {
  assert.equal(jatsCitationBaseId(jats, "fallback"), "Nagashima2026");
});

test("JATS-only citation ID preserves a surname-only first author", () => {
  const input = jats.replace("Nagashima</surname><given-names initials=\"R\">Ryo</given-names>", "McGuane</surname>");
  assert.equal(jatsCitationBaseId(input, "fallback"), "McGuane2026");
});

test("JATS citation ID and metadata use the same publication date", () => {
  const input = jats.replace('<pub-date pub-type="epub">', '<pub-date><month>12</month></pub-date><pub-date pub-type="epub">');
  assert.equal(jatsCitationBaseId(input, "fallback"), "Nagashima2026");
  assert.equal(parseJatsArticle(input, { id: "x", sourceUrl: "" })?.year, "2026-03-26");
});

test("harvestArticle names a JATS-only import after the first author", async () => {
  const set = await harvestArticle({ sourceUrl: "https://pmc.example/PMC1/", html: "", jatsXml: jats });
  assert.equal(set.id, "Nagashima2026");
  assert.equal(set.authors.length, 3);
  assert.ok(fs.existsSync(path.join(root, "50_coding", "llamaindex", "article_sets", "Nagashima2026.json")));
});
