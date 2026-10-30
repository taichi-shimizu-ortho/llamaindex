// 検索結果のソースカードと、参照文献一覧の行。
import { useState } from "react";
import { CitedText, MarkdownText } from "./markdown.js";
import type {
  ArticleQueryResult,
  IntegratedQueryResult,
  ReferenceQueryResult,
  ReferenceRecord,
} from "./types.js";

function ScoreBar({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, score * 100));
  return (
    <div className="scorebar" title={`score: ${score.toFixed(4)}`}>
      <div className="scorebar-fill" style={{ width: `${pct}%` }} />
      <span className="scorebar-label">{score.toFixed(3)}</span>
    </div>
  );
}

const ARTICLE_TYPE_LABEL: Record<NonNullable<NonNullable<ReferenceRecord["pubmed"]>["articleType"]>, string> = {
  review: "Review",
  original: "Original",
  other: "Other",
};

export function ReferenceRow({ record }: { record: ReferenceRecord }) {
  const abstract = record.pubmed?.abstract ?? "";
  const articleType = record.pubmed?.articleType;
  const meshTerms = record.pubmed?.meshTerms ?? [];
  return (
    <details className={abstract ? "ref-details" : "ref-details muted-row"}>
      <summary>
        <div className="ref-row ref-row-summary">
          <div className="ref-index">{record.index}</div>
          <div className="ref-main">
            <div className="ref-title">{record.pubmed?.title || record.text}</div>
            <div className="ref-meta">
              {articleType && (
                <span className={`ref-type ref-type-${articleType}`}>{ARTICLE_TYPE_LABEL[articleType]}</span>
              )}
              {record.pubmed?.authors?.[0] && (
                <span>
                  {record.pubmed.authors[0]}
                  {record.pubmed.authors.length > 1 ? " et al." : ""}
                </span>
              )}
              {record.pubmed?.journal && <span>{record.pubmed.journal}</span>}
              {record.pubmed?.year && <span>{record.pubmed.year}</span>}
              {record.pmid && (
                <a href={`https://pubmed.ncbi.nlm.nih.gov/${record.pmid}`} target="_blank" rel="noreferrer">
                  PMID {record.pmid}
                </a>
              )}
              {record.doi && (
                <a href={`https://doi.org/${record.doi}`} target="_blank" rel="noreferrer">
                  DOI
                </a>
              )}
              {record.error && <span className="warn-text">{record.error}</span>}
            </div>
          </div>
          <span className={abstract ? "pill ok" : "pill warn"}>{abstract ? "Abstract" : "No abstract"}</span>
        </div>
      </summary>
      <div className="ref-abstract-body">
        {abstract ? (
          <p>{abstract}</p>
        ) : (
          <>
            <p className="muted-text">{record.text}</p>
            {record.error && <p className="warn-text">{record.error}</p>}
          </>
        )}
        {meshTerms.length > 0 && (
          <div className="ref-mesh">
            <span className="ref-mesh-label">MeSH</span>
            {meshTerms.map((term) => (
              <span key={term} className="mesh-tag">
                {term}
              </span>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

export function ResultSource({ source, idx }: { source: ReferenceQueryResult["sources"][number]; idx: number }) {
  const [open, setOpen] = useState(false);
  const preview = source.abstract.length > 360 ? `${source.abstract.slice(0, 360)}...` : source.abstract;
  return (
    <div className="source-card">
      <div className="source-head">
        <span className="source-idx">{idx + 1}</span>
        <div className="source-cite">
          <div className="source-citekey">
            Reference {source.refIndex}
            {source.citationLabel && ` · ${source.citationLabel}`}
          </div>
          <div className="source-title">{source.title || source.referenceText}</div>
          <div className="source-journal">
            {source.journal}
            {source.year && ` · ${source.year}`}
          </div>
        </div>
        <ScoreBar score={source.score} />
      </div>
      <div className="source-meta">
        {source.pmid && (
          <a className="meta-doi" href={`https://pubmed.ncbi.nlm.nih.gov/${source.pmid}`} target="_blank" rel="noreferrer">
            PubMed
          </a>
        )}
        {source.doi && (
          <a className="meta-doi" href={`https://doi.org/${source.doi}`} target="_blank" rel="noreferrer">
            DOI
          </a>
        )}
        {source.authors && <span>{source.authors}</span>}
      </div>
      <p className="source-text">{open ? source.abstract : preview}</p>
      {source.abstract.length > 360 && (
        <button className="link-btn" onClick={() => setOpen((v) => !v)}>
          {open ? "Close" : "Show abstract"}
        </button>
      )}
    </div>
  );
}

export function ArticleResultSource({ source, idx }: { source: ArticleQueryResult["sources"][number]; idx: number }) {
  const [open, setOpen] = useState(false);
  const preview = source.text.length > 360 ? `${source.text.slice(0, 360)}...` : source.text;
  const section = source.subsection ? `${source.section} > ${source.subsection}` : source.section;
  return (
    <div className="source-card">
      <div className="source-head">
        <span className="source-idx">{idx + 1}</span>
        <div className="source-cite">
          <div className="source-citekey">Main article</div>
          <div className="source-title">{section}</div>
          <div className="source-journal">
            {source.journal}
            {source.year && ` · ${source.year}`}
            {` · paragraph ${source.paragraphIndex}/${source.totalParagraphs}`}
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
        {source.authors && <span>{source.authors}</span>}
      </div>
      <CitedText className="source-text" text={open ? source.text : preview} />
      {source.text.length > 360 && (
        <button className="link-btn" onClick={() => setOpen((v) => !v)}>
          {open ? "Close" : "Show paragraph"}
        </button>
      )}
    </div>
  );
}

function IntegratedResultSource({ source, idx }: { source: IntegratedQueryResult["sources"][number]; idx: number }) {
  const [open, setOpen] = useState(false);
  const preview = source.text.length > 360 ? `${source.text.slice(0, 360)}...` : source.text;
  const isMainArticle = source.scope === "main_article";

  return (
    <div className="source-card">
      <div className="source-head">
        <span className="source-idx">{idx + 1}</span>
        <div className="source-cite">
          <div className="source-citekey">
            {isMainArticle ? "Main article" : source.label}
            {!isMainArticle && source.citationLabel && ` · ${source.citationLabel}`}
          </div>
          <div className="source-title">{isMainArticle ? source.label : source.title}</div>
          {isMainArticle ? (
            <div className="source-journal">
              {source.paragraphIndex && source.totalParagraphs
                ? `${source.paragraphIndex}/${source.totalParagraphs} paragraph`
                : "paragraph"}
            </div>
          ) : (
            <div className="source-journal">
              {source.journal}
              {source.year && ` · ${source.year}`}
            </div>
          )}
        </div>
        <ScoreBar score={source.score} />
      </div>

      {!isMainArticle && (
        <div className="source-meta">
          {source.pmid && (
            <a
              className="meta-doi"
              href={`https://pubmed.ncbi.nlm.nih.gov/${source.pmid}`}
              target="_blank"
              rel="noreferrer"
            >
              PubMed
            </a>
          )}
          {source.doi && (
            <a
              className="meta-doi"
              href={`https://doi.org/${source.doi}`}
              target="_blank"
              rel="noreferrer"
            >
              DOI
            </a>
          )}
          {source.authors && <span>{source.authors}</span>}
        </div>
      )}

      {isMainArticle ? (
        <CitedText className="source-text" text={open ? source.text : preview} />
      ) : (
        <p className="source-text">{open ? source.text : preview}</p>
      )}

      {source.text.length > 360 && (
        <button className="link-btn" onClick={() => setOpen((v) => !v)}>
          {open ? "Close" : "Show text"}
        </button>
      )}
    </div>
  );
}

export function IntegratedSources({ sources }: { sources: IntegratedQueryResult["sources"] }) {
  const mainSources = sources.filter((source) => source.scope === "main_article");
  const abstractSources = sources.filter((source) => source.scope === "reference_abstract");

  return (
    <>
      <div className="source-group">
        <div className="sources-head">
          <h2>Main Article ({mainSources.length})</h2>
        </div>
        <div className="sources">
          {mainSources.map((source, idx) => (
            <IntegratedResultSource key={`${source.scope}-${source.section}-${source.subsection}-${idx}`} source={source} idx={idx} />
          ))}
        </div>
      </div>

      <div className="source-group">
        <div className="sources-head">
          <h2>Abstract ({abstractSources.length})</h2>
        </div>
        <div className="sources">
          {abstractSources.map((source, idx) => (
            <IntegratedResultSource key={`${source.scope}-${source.doi}-${source.pmid}-${idx}`} source={source} idx={idx} />
          ))}
        </div>
      </div>
    </>
  );
}

export function AnswerBlock({ title, text, cite = false }: { title: string; text: string; cite?: boolean }) {
  return (
    <div className="answer-block">
      <h3>{title}</h3>
      <MarkdownText className="answer-text" text={text} cite={cite} />
    </div>
  );
}
