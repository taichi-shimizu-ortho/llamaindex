import assert from "node:assert/strict";
import { test } from "node:test";
import { authorYearLabel } from "./documents.js";

test("uses family names in archived author-year labels", () => {
  assert.equal(authorYearLabel({
    id: "rxfp1.Soh2012", year: "2012",
    authors: ["Soh, Yu May", "Tiwari, Anjana", "Mahendroo, Mala"],
  }), "Soh et al., 2012");
  assert.equal(authorYearLabel({
    id: "Example2026", year: "2026",
    authors: ["de Charleroy, Charles", "Ayanoğlu, Semih"],
  }), "de Charleroy & Ayanoğlu, 2026");
});

test("keeps family names in given-name-first records and handles suffixes", () => {
  assert.equal(authorYearLabel({
    id: "Example2026", year: "2026", authors: ["Nir Altschuler", "Alex Smith, Jr."],
  }), "Altschuler & Smith, 2026");
  assert.equal(authorYearLabel({ id: "Example2026", authors: [""] }), "Example2026");
});
