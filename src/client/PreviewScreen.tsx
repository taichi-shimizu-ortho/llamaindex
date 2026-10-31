// 取り込み済み論文 1本の中身を読む画面。Abstract・図・本文（セクション単位）と、参照文献の一覧を出す。
// Documents のカードか、RAG の段落・論文ラベルから開く。段落から来たときはその段落へ飛ぶ。
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "./api.js";
import { ArticleContentBrowser, locateParagraph, ReferenceRow, TARGET_PARAGRAPH_ID } from "./ArticleBrowser.js";
import { ArticleTypeBadge } from "./ArticleTypeBadge.js";
import { authorYearLabel, documentLabel, documentsInFolder, flattenFolders, matchingReferenceSet } from "./documents.js";
import { ReferenceMapContext } from "./markdown.js";
import type {
  ArticleSet,
  ArticleSetSummary,
  LibraryState,
  PreviewTarget,
  ReferenceRecord,
  ReferenceSet,
  ReferenceSetSummary,
} from "./types.js";

interface PreviewScreenProps {
  articleSets: ArticleSetSummary[];
  referenceSets: ReferenceSetSummary[];
  library: LibraryState;
  target: PreviewTarget | null;
  // 最近開いた論文（新しい順）。切り替え用のチップに出す。
  recentIds: string[];
  active: boolean;
  onOpen: (articleId: string) => void;
  onBackToLibrary: () => void;
}

export function PreviewScreen({
  articleSets,
  referenceSets,
  library,
  target,
  recentIds,
  active,
  onOpen,
  onBackToLibrary,
}: PreviewScreenProps) {
  // 論文選択の絞り込み。"all" / "unfiled" / フォルダID（サブフォルダの分も含める）
  const [folderView, setFolderView] = useState("all");
  const [article, setArticle] = useState<ArticleSet | null>(null);
  const [referenceSet, setReferenceSet] = useState<ReferenceSet | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const scrolledNonce = useRef(-1);

  const articleId = target?.articleId ?? "";
  const refSummary = articleId ? matchingReferenceSet(articleId, referenceSets) : undefined;

  useEffect(() => {
    if (!articleId) return;
    let cancelled = false;
    setLoading(true);
    setError("");
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

  // フォルダで絞ってから「著者, 年」順に並べる。同じ表記が重なるときは id を添えて見分ける。
  const folderSets = useMemo(() => {
    const base =
      folderView === "all"
        ? articleSets
        : folderView === "unfiled"
          ? articleSets.filter((set) => !library.assignments[set.id])
          : documentsInFolder(articleSets, library, folderView, true);
    const labelCounts = new Map<string, number>();
    for (const set of base) labelCounts.set(authorYearLabel(set), (labelCounts.get(authorYearLabel(set)) ?? 0) + 1);
    return base
      .map((set) => {
        const label = authorYearLabel(set);
        return { set, label: (labelCounts.get(label) ?? 0) > 1 ? `${label} (${set.id})` : label };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [articleSets, library, folderView]);
  const inFolder = folderSets.some(({ set }) => set.id === articleId);
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
          className="preview-folder-picker"
          value={folderView}
          onChange={(e) => setFolderView(e.target.value)}
          aria-label="Folder to pick a paper from"
        >
          <option value="all">All documents</option>
          <option value="unfiled">Unfiled</option>
          {flattenFolders(library.folders).map(({ folder, depth }) => (
            <option key={folder.id} value={folder.id}>
              {`${"\u00a0\u00a0".repeat(depth)}${folder.name}`}
            </option>
          ))}
        </select>
        <select
          className="preview-picker"
          value={inFolder ? articleId : ""}
          onChange={(e) => e.target.value && onOpen(e.target.value)}
          aria-label="Paper to preview"
        >
          {/* 開いている論文がこのフォルダに無いときは、未選択の見出しを出す */}
          {!inFolder && (
            <option value="" disabled>
              {folderSets.length ? `Select a paper (${folderSets.length})` : "No papers in this folder"}
            </option>
          )}
          {folderSets.map(({ set, label }) => (
            <option key={set.id} value={set.id} title={documentLabel(set)}>
              {label}
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
              <h2>
                <ArticleTypeBadge type={shown.articleType} /> {documentLabel(shown)}
              </h2>
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
          </div>
          {referenceSet ? (
            <div className="ref-list">
              {referenceSet.records.map((record) => (
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
