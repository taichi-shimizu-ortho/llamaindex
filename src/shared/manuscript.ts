export const REVIEW_MODES = ["intro_fact_check", "discussion_draft", "discussion_verify"] as const;
export type ReviewMode = typeof REVIEW_MODES[number];
export type ManuscriptSection = "intro" | "methods" | "results" | "discussion" | "tables" | "figures" | "conclusion";

export interface ManuscriptBlock {
  location: string;
  text: string;
}

export interface Manuscript {
  title: string;
  sections: Partial<Record<ManuscriptSection, ManuscriptBlock[]>>;
  references: Record<string, string>;
  notes: string[];
}

export type RetrievalMode = "verify_cited_sources" | "search_literature" | "both";

export interface CitationCheck {
  source_id: string;
  status: "resolved" | "abstract_only" | "not_indexed" | "ambiguous" | "unmapped" | "full_text_unavailable";
  article_id: string | null;
  title: string | null;
}

export interface Evidence {
  evidence_id: string;
  source_id: string;
  article_id: string;
  retrieval_origin: "cited_source" | "broader_search";
  title: string | null;
  authors: string[];
  year: string | null;
  doi_or_pmid: string | null;
  locator: {
    section: string;
    subsection: string | null;
    chunk_id: string;
    paragraph: number;
    page: null;
  };
  excerpt: string;
  evidence_type: "primary_result" | "methods" | "author_interpretation" | "secondary_summary" | "other";
  study_context: {
    design: string | null;
    population_or_model: string | null;
    comparison: string | null;
    outcome: string | null;
  };
  limitations: string[];
}

export interface RetrievalResult {
  request_id: string;
  claim_id: string | null;
  mode: RetrievalMode;
  search_status: "evidence_returned" | "no_relevant_evidence" | "retrieval_failed";
  source_checks: CitationCheck[];
  evidence: Evidence[];
  coverage_notes: string[];
}

export interface ReviewClaim {
  claim_id: string;
  location: string;
  original_text: string;
  assertion: string;
  kind: "external" | "present_study" | "comparison" | "interpretation";
  cited_source_ids: string[];
}

export interface ClaimReview extends ReviewClaim {
  verdict: "supported" | "partially_supported" | "contradicted" | "not_verifiable";
  rationale: string;
  evidence_ids: string[];
  internal_locators: string[];
  suggested_revision: string | null;
  candidate_evidence_ids: string[];
}

export interface DraftSupport {
  text: string;
  evidence_ids: string[];
  internal_locators: string[];
}

export interface ManuscriptReviewResult {
  mode: ReviewMode;
  title: string;
  model: string;
  ledger: ClaimReview[];
  draft: string | null;
  support_map: DraftSupport[];
  unresolved: string[];
  retrievals: RetrievalResult[];
}

export type ReviewScope = "cited_only" | "cited_and_related";
