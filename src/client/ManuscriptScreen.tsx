import { useState } from "react";
import type { FormEvent } from "react";
import { api, errorMessage } from "./api.js";
import { manuscriptMarkdown } from "../shared/manuscriptMarkdown.js";
import { REVIEW_MODES, type LiteratureCollection, type Manuscript, type ManuscriptReviewResult, type ReviewMode, type ReviewScope } from "../shared/manuscript.js";

const MODE_LABEL: Record<ReviewMode, string> = {
  intro_fact_check: "Introduction fact check",
  discussion_draft: "Draft Discussion",
  discussion_verify: "Verify Discussion",
};

function EvidenceLinks({ ids }: { ids: string[] }) {
  return <>{ids.map((id, i) => (
    <span key={id}>{i > 0 && ", "}<a href={`#${id}`} onClick={() => {
      const passage = document.getElementById(id);
      if (passage instanceof HTMLDetailsElement) passage.open = true;
    }}>{id}</a></span>
  ))}</>;
}

function ReviewResult({ result }: { result: ManuscriptReviewResult }) {
  return (
    <section className="manuscript-result" aria-label="Review results">
      {result.ledger.length > 0 && <h3>Claim ledger</h3>}
      {result.ledger.map((row) => (
        <article className="answer-card manuscript-claim" key={row.claim_id}>
          <strong>{row.claim_id} · {row.location} · {row.kind.replaceAll("_", " ")} · {row.verdict.replaceAll("_", " ")}</strong>
          <blockquote>{row.original_text}</blockquote>
          {row.assertion !== row.original_text && <p><strong>Claim</strong> {row.assertion}</p>}
          <p>{row.rationale}</p>
          {row.cited_source_ids.length > 0 && <p>Citations {row.cited_source_ids.map((id) => `[${id}]`).join(" ")}</p>}
          {row.evidence_ids.length > 0 && <p>Evidence <EvidenceLinks ids={row.evidence_ids} /></p>}
          {row.internal_locators.length > 0 && <p>Study locations {row.internal_locators.join(", ")}</p>}
          {row.candidate_evidence_ids.length > 0 && <p>Candidate evidence <EvidenceLinks ids={row.candidate_evidence_ids} /></p>}
          {row.suggested_revision && <p><strong>Suggested revision</strong> {row.suggested_revision}</p>}
        </article>
      ))}
      {result.draft && (
        <div className="answer-card">
          <h3>Discussion draft</h3>
          <div className="manuscript-text">{result.draft}</div>
          {result.support_map.length > 0 && <h4>Support map</h4>}
          <ul>
            {result.support_map.map((row, i) => (
              <li key={i}>{row.text} <EvidenceLinks ids={row.evidence_ids} /> {row.internal_locators.join(", ")}</li>
            ))}
          </ul>
        </div>
      )}
      {result.unresolved.length > 0 && (
        <div>
          <h3>Unresolved items</h3>
          <ul>{[...new Set(result.unresolved)].map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      )}
      {result.retrievals.length > 0 && <h3>Literature evidence</h3>}
      {result.retrievals.map((retrieval) => (
        <section className="answer-card manuscript-claim" key={retrieval.request_id}>
          <h4>{retrieval.claim_id} · {retrieval.search_status.replaceAll("_", " ")}</h4>
          {retrieval.source_checks.map((check) => (
            <div key={check.source_id}>[{check.source_id}] {check.title} · {check.status.replaceAll("_", " ")}</div>
          ))}
          {retrieval.coverage_notes.map((note, i) => <p className="panel-note" key={i}>{note}</p>)}
          {retrieval.evidence.map((record) => (
            <details id={record.evidence_id} className="manuscript-evidence" key={record.evidence_id}>
              <summary>{record.evidence_id} · {record.retrieval_origin.replaceAll("_", " ")} · {record.title ?? record.article_id}</summary>
              <p className="panel-note">
                {[record.authors.join(", "), record.year, record.doi_or_pmid, record.locator.section, record.locator.subsection,
                  `chunk ${record.locator.chunk_id}`, record.evidence_type.replaceAll("_", " ")].filter(Boolean).join(" · ")}
              </p>
              <blockquote className="manuscript-text">{record.excerpt}</blockquote>
              {record.limitations.map((note) => <p key={note} className="panel-note">{note}</p>)}
            </details>
          ))}
        </section>
      ))}
    </section>
  );
}

export function ManuscriptScreen({ rxfp1Available }: { rxfp1Available: boolean }) {
  const [manuscript, setManuscript] = useState<Manuscript | null>(null);
  const [mode, setMode] = useState<ReviewMode>("intro_fact_check");
  const [scope, setScope] = useState<ReviewScope>("cited_only");
  const [collection, setCollection] = useState<LiteratureCollection>("current");
  const [location, setLocation] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [savedFile, setSavedFile] = useState("");
  const [result, setResult] = useState<ManuscriptReviewResult | null>(null);
  const target = mode === "intro_fact_check" ? "intro" : mode === "discussion_verify" ? "discussion" : "results";
  const paragraphs = manuscript?.sections[target] ?? [];
  const selected = paragraphs.find((block) => block.location === location);

  async function load(file: File | undefined) {
    setManuscript(null);
    setResult(null);
    setLocation("");
    setError("");
    setSavedFile("");
    if (!file) return;
    setBusy("Reading Word document…");
    try {
      setManuscript(await api.readManuscript(file));
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function review(event: FormEvent) {
    event.preventDefault();
    if (!manuscript || busy) return;
    setBusy("Reviewing manuscript…");
    setError("");
    setResult(null);
    setSavedFile("");
    try {
      setResult(await api.reviewManuscript(manuscript, mode, scope, location ? [location] : [], collection));
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function save() {
    if (!result || busy) return;
    setBusy("Saving Markdown…");
    setError("");
    try {
      setSavedFile((await api.saveManuscriptReview(manuscriptMarkdown(result))).file);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="main-panel manuscript-panel">
      <div className="panel-head"><h2>Manuscript review</h2></div>
      <form onSubmit={review}>
        <label className="field">
          Word manuscript
          <input type="file" accept=".docx" disabled={Boolean(busy)} onChange={(event) => void load(event.target.files?.[0])} />
        </label>
        {manuscript && (
          <>
            <p><strong>{manuscript.title}</strong></p>
            <div className="manuscript-controls">
              <label className="field">
                Review mode
                <select value={mode} disabled={Boolean(busy)} onChange={(event) => {
                  setMode(event.target.value as ReviewMode);
                  setLocation("");
                  setResult(null);
                  setSavedFile("");
                }}>
                  {REVIEW_MODES.map((item) => <option value={item} key={item}>{MODE_LABEL[item]}</option>)}
                </select>
              </label>
              <label className="field">
                Literature
                <select value={mode === "discussion_draft" ? "cited_and_related" : scope}
                  disabled={Boolean(busy) || mode === "discussion_draft"} onChange={(event) => {
                    setScope(event.target.value as ReviewScope);
                    setResult(null);
                    setSavedFile("");
                  }}>
                  <option value="cited_only">Intended citations only</option>
                  <option value="cited_and_related">Include related local literature</option>
                </select>
              </label>
              {rxfp1Available && (
                <label className="field">
                  Literature collection
                  <select value={collection} disabled={Boolean(busy)} onChange={(event) => {
                    setCollection(event.target.value as LiteratureCollection);
                    setResult(null);
                    setSavedFile("");
                  }}>
                    <option value="current">Current library</option>
                    <option value="rxfp1">RXFP1 archive</option>
                  </select>
                </label>
              )}
              <label className="field">
                Word paragraphs
                <select value={location} disabled={Boolean(busy) || !paragraphs.length} onChange={(event) => {
                  setLocation(event.target.value);
                  setResult(null);
                  setSavedFile("");
                }}>
                  <option value="">{paragraphs.length ? `Entire section (${paragraphs.length})` : "No section text detected"}</option>
                  {paragraphs.map(({ location, text }) => <option value={location} key={location}>{location} · {text.slice(0, 75)}</option>)}
                </select>
              </label>
            </div>
            {selected && <blockquote>{selected.text}</blockquote>}
            <p className="panel-note">
              {Object.keys(manuscript.references).length} numbered references. Review sends selected manuscript text
              {mode !== "intro_fact_check" ? ", study materials," : ""} and local evidence passages to the configured Claude API.
              {collection === "rxfp1" && (scope === "cited_and_related" || mode === "discussion_draft")
                && " RXFP1 related search sends focused search terms to the configured OpenAI embeddings API."}
            </p>
            <button className="primary" disabled={Boolean(busy) || (!paragraphs.length && mode !== "discussion_draft")}>
              Run review
            </button>
          </>
        )}
      </form>
      {busy && <p role="status">{busy}</p>}
      {error && <div className="error" role="alert">{error}</div>}
      {result && (
        <>
          <ReviewResult result={result} />
          <button className="ghost" onClick={() => void save()} disabled={Boolean(busy)}>Save Markdown</button>
          {savedFile && <div className="saved-note" role="status">Saved to {savedFile}</div>}
        </>
      )}
    </section>
  );
}
