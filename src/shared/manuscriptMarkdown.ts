import type { ManuscriptReviewResult } from "./manuscript.js";

export function manuscriptMarkdown(result: ManuscriptReviewResult): string {
  const parts = ["# Manuscript review", "", result.title, "", `Mode: ${result.mode}`, `Model: ${result.model || "—"}`];
  if (result.collection) parts.push(`Literature collection: ${result.collection}`);
  if (result.ledger.length) {
    parts.push("", "## Claim ledger");
    for (const claim of result.ledger) {
      parts.push("", `### ${claim.claim_id} · ${claim.location} · ${claim.kind} · ${claim.verdict}`, "",
        claim.original_text);
      if (claim.assertion !== claim.original_text) parts.push("", `Claim: ${claim.assertion}`);
      parts.push("", claim.rationale);
      if (claim.cited_source_ids.length) parts.push("", `Intended citations: ${claim.cited_source_ids.join(", ")}`);
      if (claim.evidence_ids.length) parts.push("", `Evidence: ${claim.evidence_ids.join(", ")}`);
      if (claim.internal_locators.length) parts.push("", `Study locations: ${claim.internal_locators.join(", ")}`);
      if (claim.candidate_evidence_ids.length) parts.push("", `Candidate evidence: ${claim.candidate_evidence_ids.join(", ")}`);
      if (claim.suggested_revision) parts.push("", `Suggested revision: ${claim.suggested_revision}`);
    }
  }
  if (result.draft) parts.push("", "## Discussion draft", "", result.draft);
  if (result.support_map.length) {
    parts.push("", "## Support map", "");
    for (const row of result.support_map) {
      const sources = [...row.evidence_ids, ...row.internal_locators].join(", ");
      parts.push(`- ${row.text}${sources ? ` — ${sources}` : ""}`);
    }
  }
  if (result.unresolved.length) parts.push("", "## Unresolved items", "", ...result.unresolved.map((item) => `- ${item}`));
  if (result.retrievals.length) {
    parts.push("", "## Literature evidence");
    for (const retrieval of result.retrievals) {
      parts.push("", `### ${retrieval.claim_id} · ${retrieval.mode}`, "", retrieval.search_status);
      for (const entry of retrieval.source_checks) {
        parts.push(`- [${entry.source_id}] ${entry.title ?? ""} · ${entry.status}`);
      }
      for (const note of retrieval.coverage_notes) parts.push(`- ${note}`);
      for (const record of retrieval.evidence) {
        const { locator } = record;
        const location = [locator.section, locator.subsection, `chunk ${locator.chunk_id}`].filter(Boolean).join(" / ");
        parts.push("", `#### ${record.evidence_id} · ${record.retrieval_origin}`, "",
          [record.title, record.authors.join(", "), record.year, record.doi_or_pmid].filter(Boolean).join(" · "),
          "", `${location} · ${record.evidence_type}`, "",
          ...record.excerpt.split(/\r?\n/).map((line) => `> ${line}`));
        if (record.limitations.length) parts.push("", ...record.limitations.map((note) => `- ${note}`));
      }
    }
  }
  return parts.join("\n") + "\n";
}
