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

// fetch を呼んだら記録する。JATS があるときは元URLを取りに行かないことを確かめる。
async function withFetchSpy<T>(run: (calls: string[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    calls.push(String(input));
    return new Response("<html><head><title>Checking your browser - reCAPTCHA</title></head><body></body></html>");
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const otherJats = jats
  .replace("10.1177/test.2026", "10.1177/other.2026")
  .replace("Sacroiliac Joint Stress Test Article", "Second Article From PMC")
  .replace("Nagashima</surname><given-names initials=\"R\">Ryo", "Tanaka</surname><given-names>Ken");

test("harvestArticle with JATS does not fetch the source URL and keeps the JATS title", async () => {
  await withFetchSpy(async (calls) => {
    const set = await harvestArticle({ sourceUrl: "https://pmc.example/PMC2/", jatsXml: otherJats });
    assert.deepEqual(calls, []);
    assert.equal(set.id, "Tanaka2026");
    assert.equal(set.title, "Second Article From PMC");
  });
});

test("harvestReferences with JATS does not fetch the source URL", async () => {
  const { harvestReferences } = await import("./referenceHarvester.js");
  const withRefs = otherJats.replace(
    "</body>",
    '</body><back><ref-list><ref id="r1"><mixed-citation>Smith J. A cited study. J Test. 2020.</mixed-citation></ref></ref-list></back>',
  );
  await withFetchSpy(async (calls) => {
    const refs = await harvestReferences({ sourceUrl: "https://pmc.example/PMC2/", jatsXml: withRefs, articleId: "Tanaka2026", limit: 1 });
    assert.ok(!calls.some((url) => url.includes("pmc.example")), `fetched ${calls.join(", ")}`);
    assert.equal(refs.id, "Tanaka2026");
  });
});


test("table cells, table footnotes, figure captions and abbreviation lists are not body paragraphs", () => {
  const input = jats.replace(
    "<body><sec><title>Introduction</title><p>Intro paragraph.</p></sec></body>",
    `<body><def-list list-content="abbreviations"><title>Abbreviations</title>
<def-item><term>ACL</term><def><p>anterior cruciate ligament</p></def></def-item>
<def-item><term>CI</term><def><p>confidence interval</p></def></def-item></def-list>
<sec><title>Introduction</title><p>Intro paragraph.</p></sec>
<sec><title>Discussion</title><p>Discussion paragraph.</p>
<sec><title>Injury Types</title><p>Muscle injuries were most common.</p>
<table-wrap id="Tab1"><label>Table 1</label><caption><p>Injury types</p></caption>
<table><tr><th>Study</th><th>League</th></tr><tr><td><p>Ekstrand</p></td><td><p>1st French</p></td></tr></table>
<table-wrap-foot><fn><p>IR injury incidence rate</p></fn></table-wrap-foot></table-wrap>
<fig id="F1"><label>Fig. 1</label><caption><p>Time trends of injuries.</p></caption><graphic xlink:href="f1.jpg"/></fig>
</sec></sec></body>`,
  );
  const sections = parseJatsArticle(input, { id: "x", sourceUrl: "" })?.sections ?? [];
  const body = sections.filter((s) => s.type === "body");
  assert.deepEqual(body.map((s) => s.title), ["Introduction", "Discussion", "Abbreviations"]);
  const discussion = body.find((s) => s.title === "Discussion")!;
  assert.deepEqual(discussion.paragraphs, ["Discussion paragraph."]);
  assert.deepEqual(discussion.subsections[0].paragraphs, ["Muscle injuries were most common."]);
  assert.deepEqual(body.find((s) => s.title === "Abbreviations")!.paragraphs, ["ACL: anterior cruciate ligament; CI: confidence interval"]);
  // 表と図は従来どおり別の節として残る
  assert.ok(sections.some((s) => s.type === "table" && s.content.includes("1st French")));
  // 表の脚注は本文ではなく表の節に付く
  assert.ok(sections.some((s) => s.type === "table" && s.content.endsWith("IR injury incidence rate")));
  assert.ok(sections.some((s) => s.type === "figure" && s.content.includes("Time trends of injuries.")));
});

test("an unlabeled table-wrap (Springer Key Points box) stays as body text", () => {
  const input = jats.replace(
    "<body><sec><title>Introduction</title><p>Intro paragraph.</p></sec></body>",
    `<body><sec><title>Key Points</title><p>
<table-wrap id="Taba"><table><tbody><tr><td>First key point.</td></tr><tr><td>Second key point.</td></tr></tbody></table></table-wrap></p></sec>
<sec><title>Introduction</title><p>Intro paragraph.</p></sec></body>`,
  );
  const sections = parseJatsArticle(input, { id: "x", sourceUrl: "" })?.sections ?? [];
  const keyPoints = sections.find((s) => s.title === "Key Points")!;
  assert.deepEqual(keyPoints.paragraphs, ["First key point.", "Second key point."]);
  assert.ok(!sections.some((s) => s.type === "table"));
});

test("<fig-count/> in the front matter does not start a figure that swallows the tables before it", () => {
  const input = jats
    .replace("<abstract>", '<counts><fig-count count="1"/><table-count count="1"/></counts><abstract>')
    .replace(
      "<body><sec><title>Introduction</title><p>Intro paragraph.</p></sec></body>",
      `<body><sec><title>Results</title><p>Results text.</p>
<table-wrap id="T1"><label>Table 1</label><caption><p>Baseline characteristics.</p></caption><table><tr><th>A</th></tr><tr><td>1</td></tr></table></table-wrap>
<fig id="F1"><label>Figure 1</label><caption><p>Market value over time.</p></caption><graphic xlink:href="g001.jpg"/></fig></sec></body>`,
    );
  const figures = (parseJatsArticle(input, { id: "x", sourceUrl: "" })?.sections ?? []).filter((s) => s.type === "figure");
  assert.deepEqual(figures.map((s) => s.paragraphs[0]), ["Figure 1. Market value over time."]);
});
