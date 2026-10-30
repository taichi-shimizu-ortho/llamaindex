// 検索結果のソースカード（複数論文 RAG の 1段落）。
import { useState } from "react";
import { CitedText } from "./markdown.js";
import type { CorpusSource, SectionGroup } from "./types.js";

export const SECTION_GROUP_LABEL: Record<SectionGroup, string> = {
  intro: "Intro",
  methods: "Methods",
  results: "Results",
  discussion: "Discussion",
  conclusion: "Conclusion",
  figure: "Figures",
  table: "Tables",
  other: "Other",
};

function ScoreBar({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, score * 100));
  return (
    <div className="scorebar" title={`score: ${score.toFixed(4)}`}>
      <div className="scorebar-fill" style={{ width: `${pct}%` }} />
      <span className="scorebar-label">{score.toFixed(3)}</span>
    </div>
  );
}

export function CorpusSourceCard({ source, flash }: { source: CorpusSource; flash: boolean }) {
  const [open, setOpen] = useState(false);
  const preview = source.text.length > 420 ? `${source.text.slice(0, 420)}...` : source.text;
  const section = source.subsection ? `${source.section} > ${source.subsection}` : source.section;
  const classes = ["source-card", source.cited ? "cited" : "", flash ? "flash" : ""].filter(Boolean).join(" ");
  return (
    <div className={classes} id={`passage-${source.n}`}>
      <div className="source-head">
        <span className="source-idx">S{source.n}</span>
        <div className="source-cite">
          <div className="source-citekey">
            {source.label}
            <span className="pill group-pill">{SECTION_GROUP_LABEL[source.sectionGroup]}</span>
            {source.cited && <span className="pill ok">Cited</span>}
          </div>
          <div className="source-title">{source.title}</div>
          <div className="source-journal">
            {section} · ¶{source.paragraphIndex}/{source.totalParagraphs}
          </div>
        </div>
        <ScoreBar score={source.score} />
      </div>
      <div className="source-meta">
        {source.doi && (
          <a className="meta-doi" href={`https://doi.org/${source.doi}`} target="_blank" rel="noreferrer">
            DOI
          </a>
        )}
        {[source.journal, source.year].filter(Boolean).join(" · ") && (
          <span>{[source.journal, source.year].filter(Boolean).join(" · ")}</span>
        )}
      </div>
      <CitedText className="source-text" text={open ? source.text : preview} />
      {source.text.length > 420 && (
        <button className="link-btn" onClick={() => setOpen((v) => !v)}>
          {open ? "Close" : "Show paragraph"}
        </button>
      )}
    </div>
  );
}
