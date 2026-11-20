import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "manuscript-review-test-"));
process.env.OBSIDIAN_DIR = testDirectory;
process.env.MANUSCRIPT_LITERATURE_FILE = "";
after(() => fs.rmSync(testDirectory, { recursive: true, force: true }));

const { citationNumbers, parseReviewRequest, runManuscriptReview } = await import("./manuscriptReview.js");

const original = "The sample claim uses the intended citation [4].";
const manuscript = {
  title: "Fixture",
  sections: { intro: [{ location: "P1", text: original }] },
  references: {},
  notes: [],
};

test("expands numeric citation groups and ranges", () => {
  assert.deepEqual(citationNumbers("group [1, 3–5]; repeat [5, 9]"), ["1", "3", "4", "5", "9"]);
});

test("anchors source text and excludes invented citations and locators from a verdict", async () => {
  const request = parseReviewRequest({ manuscript, mode: "intro_fact_check", scope: "cited_only" });
  const result = await runManuscriptReview(request, async (_system, input) => {
    const planning = Boolean(JSON.parse(input).sentences);
    return {
      model: "fixture",
      text: JSON.stringify(planning ? {
        claims: [{
          location: "P1.S1", assertion: "A restatement", cited_source_ids: ["[4]", "99"],
          kind: "external", scope: "", query: "sample claim",
        }],
        excluded_locations: ["P999.S1"],
      } : {
        ledger: [{
          claim_id: "C1", verdict: "supported", rationale: "Invalid evidence references.",
          evidence_ids: ["E9999"], internal_locators: ["P9"], suggested_revision: null, candidate_evidence_ids: [],
        }],
        unresolved: [],
      }),
    };
  });

  const [claim] = result.ledger;
  assert.equal(claim.original_text, original);
  assert.equal(claim.assertion, "A restatement");
  assert.equal(claim.verdict, "not_verifiable");
  assert.deepEqual(claim.cited_source_ids, ["4"]);
  assert.deepEqual(claim.evidence_ids, []);
  assert.deepEqual(claim.internal_locators, []);
  assert.equal(result.retrievals[0].source_checks[0].status, "unmapped");
});

test("returns a discussion outline when there is no Results section", async () => {
  const request = parseReviewRequest({ manuscript, mode: "discussion_draft", scope: "cited_and_related" });
  const result = await runManuscriptReview(request, async () => {
    throw new Error("Unexpected model call");
  });
  assert.match(result.draft ?? "", /Discussion outline/);
  assert.deepEqual(result.support_map, []);
});
