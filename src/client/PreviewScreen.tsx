// 取り込み済み論文 1本の中身を読む画面。Abstract・図・本文（セクション単位）と、参照文献の一覧を出す。
// 参照文献は PubMed の Publication Type から Original / Review / Other に分けて絞り込める。
// Documents のカードか、RAG の段落・論文ラベルから開く。段落から来たときはその段落へ飛ぶ。
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "./api.js";
import {
  ARTICLE_TYPE_LABEL,
  ArticleContentBrowser,
  locateParagraph,
  ReferenceRow,
  referenceType,
  TARGET_PARAGRAPH_ID,
  type ArticleType,
} from "./ArticleBrowser.js";
import { documentLabel, matchingReferenceSet } from "./documents.js";
import { ReferenceMapContext } from "./markdown.js";
import type { ArticleSet, ArticleSetSummary, PreviewTarget, ReferenceRecord, ReferenceSet, ReferenceSetSummary } from "./types.js";

const ARTICLE_TYPES: ArticleType[] = ["original", "review", "other"];

interface PreviewScreenProps {
  articleSets: ArticleSetSummary[];
  referenceSets: ReferenceSetSummary[];
  target: PreviewTarget | null;
  // 最近開いた論文（新しい順）。切り替え用のチップに出す。
  recentIds: string[];
  active: boolean;
  onOpen: (articleId: string) => void;
  onBackToLibrary: () => void;
}

export function PreviewScreen({ articleSets, referenceSets, target, recentIds, active, onOpen, onBackToLibrary }: PreviewScreenProps) {
  const [article, setArticle] = useState<ArticleSet | null>(null);
  const [referenceSet, setReferenceSet] = useState<ReferenceSet | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refFilter, setRefFilter] = useState<ArticleType | "all">("all");
  const scrolledNonce = useRef(-1);

  const articleId = target?.articleId ?? "";
  const refSummary = articleId ? matchingReferenceSet(articleId, referenceSets) : undefined;

  useEffect(() => {
    if (!articleId) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setRefFilter("all");
    Promise.all([api.articleSet(articleId), refSummary ? api.referenceSet(refSummary.id) : Promise.resolve(null)])
      .then(([nextArticle, nextRefs]) => {
        if (cancelled) return;
        setArticle(nextArticle);
        setReferenceSet(nextRefs);
      })
      .catch((e) => {
        if (cancelled) return;
        setArticle(null);
        setReferenceSet(null);
        setError(errorMessage(e));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [articleId, refSummary?.id]);

  const shown = article?.id === articleId ? article : null;
  const location = useMemo(
    () => (shown && target?.passage ? locateParagraph(shown, target.passage) : null),
    [shown, target],
  );

  // 開くたびに、段落指定があればそこへ、なければ先頭へ。非表示の間はスクロールできないので表示されてから。
  useEffect(() => {
    if (!active || !shown || !target || scrolledNonce.current === target.nonce) return;
    scrolledNonce.current = target.nonce;
    requestAnimationFrame(() => {
      const el = location ? document.getElementById(TARGET_PARAGRAPH_ID) : null;
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      else window.scrollTo({ top: 0 });
    });
  }, [active, shown, target, location]);

  const refMap = useMemo(
    () => new Map<number, ReferenceRecord>(referenceSet?.records.map((r) => [r.index, r]) ?? []),
    [referenceSet],
  );
  const typeCounts = useMemo(() => {
    const counts: Record<ArticleType, number> = { original: 0, review: 0, other: 0 };
    for (const record of referenceSet?.records ?? []) {
      const type = referenceType(record);
      if (type) counts[type] += 1;
    }
    return counts;
  }, [referenceSet]);
  const records = (referenceSet?.records ?? []).filter(
    (record) => refFilter === "all" || referenceType(record) === refFilter,
  );

  const sortedSets = useMemo(
    () => [...articleSets].sort((a, b) => documentLabel(a).localeCompare(documentLabel(b))),
    [articleSets],
  );
  const recent = recentIds
    .filter((id) => id !== articleId)
    .flatMap((id) => articleSets.find((set) => set.id === id) ?? [])
    .slice(0, 6);

  if (!target) {
    return (
      <section className="main-panel">
        <div className="empty-state">
          <h2>No paper open</h2>
          <p>Press “Preview” on a document card, or open a paper from a RAG passage.</p>
          <button className="primary" onClick={onBackToLibrary}>
            Go to Documents
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="main-panel">
      <div className="rag-toolbar preview-toolbar">
        <button className="ghost" onClick={onBackToLibrary}>
          ← Documents
        </button>
        <select
          className="preview-picker"
          value={articleId}
          onChange={(e) => onOpen(e.target.value)}
          aria-label="Paper to preview"
        >
          {!articleSets.some((set) => set.id === articleId) && <option value={articleId}>{articleId}</option>}
          {sortedSets.map((set) => (
            <option key={set.id} value={set.id}>
              {documentLabel(set)}
            </option>
          ))}
        </select>
        {recent.length > 0 && (
          <div className="preview-recent">
            <span className="panel-note">Recent</span>
            {recent.map((set) => (
              <button key={set.id} className="fchip" onClick={() => onOpen(set.id)} title={documentLabel(set)}>
                {set.id}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <div className="error">{error}</div>}
      {loading && !shown && (
        <div className="loading inline-loading">
          <div className="spinner" />
          <span>Loading paper...</span>
        </div>
      )}

      {shown && (
        <ReferenceMapContext.Provider value={refMap}>
          <div className="dataset-summary">
            <div className="article-meta-header">
              {shown.year && <div className="article-year">{[shown.year, shown.journal].filter(Boolean).join(" · ")}</div>}
              <h2>{documentLabel(shown)}</h2>
              {shown.authors?.length > 0 && <div className="article-authors">{shown.authors.join(", ")}</div>}
              <p className="article-source-url">
                <span className="doc-id">{shown.id}</span>
                {shown.doi && (
                  <>
                    {" · "}
                    <a href={`https://doi.org/${shown.doi}`} target="_blank" rel="noreferrer">
                      doi:{shown.doi}
                    </a>
                  </>
                )}
                {shown.sourceUrl && (
                  <>
                    {" · "}
                    <a href={shown.sourceUrl} target="_blank" rel="noreferrer">
                      {shown.sourceUrl}
                    </a>
                  </>
                )}
              </p>
            </div>
            <div className="summary-grid">
              <div>
                <strong>{shown.sections.length}</strong>
                <span>sections</span>
              </div>
              <div>
                <strong>{shown.chunkCount}</strong>
                <span>paragraphs</span>
              </div>
              <div>
                <strong>{referenceSet?.records.length ?? 0}</strong>
                <span>references</span>
              </div>
            </div>
          </div>

          {target.passage && !location && (
            <div className="panel-note warn-text">Couldn't find the RAG passage in this paper's main text.</div>
          )}

          <ArticleContentBrowser key={`${shown.id}-${target.nonce}`} article={shown} target={location} />

          <div className="sources-head references-head">
            <h2>References ({referenceSet?.records.length ?? 0})</h2>
            {referenceSet && (
              <div className="section-filter">
                <button className={refFilter === "all" ? "fchip active" : "fchip"} onClick={() => setRefFilter("all")}>
                  All {referenceSet.records.length}
                </button>
                {ARTICLE_TYPES.map((type) => (
                  <button
                    key={type}
                    className={refFilter === type ? "fchip active" : "fchip"}
                    onClick={() => setRefFilter(type)}
                    disabled={!typeCounts[type]}
                  >
                    {ARTICLE_TYPE_LABEL[type]} {typeCounts[type]}
                  </button>
                ))}
              </div>
            )}
          </div>
          {referenceSet ? (
            <div className="ref-list">
              {records.map((record) => (
                <ReferenceRow key={`${record.index}-${record.pmid}-${record.href}`} record={record} />
              ))}
            </div>
          ) : (
            <p className="panel-note">No reference JSON for this paper.</p>
          )}
        </ReferenceMapContext.Provider>
      )}
    </section>
  );
}
