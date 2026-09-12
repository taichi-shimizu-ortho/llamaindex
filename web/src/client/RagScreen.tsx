// ドキュメントRAG画面。選択済みの主論文JSON／参照文献JSONに対して検索する。
import { useEffect, useMemo, useState } from "react";
import { api, errorMessage, safeJson } from "./api.js";
import { ArticleContentBrowser } from "./ArticleBrowser.js";
import { MarkdownText, ReferenceMapContext } from "./markdown.js";
import {
  AnswerBlock,
  ArticleResultSource,
  IntegratedSources,
  ReferenceRow,
  ResultSource,
} from "./Sources.js";
import type {
  ArticleQueryResult,
  ArticleSet,
  IntegratedQueryResult,
  ReferenceQueryResult,
  ReferenceRecord,
  ReferenceSet,
} from "./types.js";

type SearchMode = "integrated" | "article" | "reference";
type QueryResultUnion = ReferenceQueryResult | ArticleQueryResult | IntegratedQueryResult;

function sessionStamp(): string {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yy}${mm}${dd}_${hh}${mi}${ss}`;
}

function initialSessionId(): string {
  const saved = sessionStorage.getItem("ragSessionId");
  if (saved) return saved;
  const next = sessionStamp();
  sessionStorage.setItem("ragSessionId", next);
  return next;
}

interface RagScreenProps {
  article: ArticleSet | null;
  referenceSet: ReferenceSet | null;
  loading: string;
  onBackToLibrary: () => void;
}

export function RagScreen({ article, referenceSet, loading, onBackToLibrary }: RagScreenProps) {
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState(5);
  const [translate, setTranslate] = useState(true);
  const [searchMode, setSearchMode] = useState<SearchMode>("integrated");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [savedFile, setSavedFile] = useState("");
  const [sessionId] = useState(initialSessionId);
  const [result, setResult] = useState<QueryResultUnion | null>(null);

  const referenceMap = useMemo(() => {
    const map = new Map<number, ReferenceRecord>();
    referenceSet?.records.forEach((record) => map.set(record.index, record));
    return map;
  }, [referenceSet]);

  // 対象ドキュメントが変わったら前の検索結果は破棄する。
  useEffect(() => {
    setResult(null);
    setSavedFile("");
    setError("");
  }, [article?.id, referenceSet?.id]);

  async function search() {
    if (!query.trim() || busy) return;
    if (searchMode === "reference" && !referenceSet) return;
    if (searchMode === "article" && !article) return;
    if (searchMode === "integrated" && (!article || !referenceSet)) return;
    setBusy(translate ? "Translating & searching..." : "Searching...");
    setError("");
    try {
      const endpoint =
        searchMode === "article"
          ? "/api/article/query"
          : searchMode === "integrated"
            ? "/api/integrated/query"
            : "/api/reference/query";
      const payload =
        searchMode === "article"
          ? { articleId: article?.id, query: query.trim(), topK, translate }
          : searchMode === "integrated"
            ? { articleId: article?.id, referenceSetId: referenceSet?.id, query: query.trim(), topK, translate }
            : { setId: referenceSet?.id, query: query.trim(), topK, translate };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data: any = await safeJson(res);
      if (!res.ok) throw new Error(data.error ?? "Search failed");
      setResult(data);
      const saved = await api.saveSession(sessionId, data);
      setSavedFile(saved.file ?? "");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  function onQueryKey(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      search();
    }
  }

  if (!article && !referenceSet) {
    return (
      <section className="main-panel">
        {loading ? (
          <div className="loading inline-loading">
            <div className="spinner" />
            <span>{loading}</span>
          </div>
        ) : (
          <div className="empty-state">
            <h2>No document selected</h2>
            <p>Pick a document on the Documents screen to start searching.</p>
            <button className="primary" onClick={onBackToLibrary}>
              Go to Documents
            </button>
          </div>
        )}
      </section>
    );
  }

  return (
    <ReferenceMapContext.Provider value={referenceMap}>
      <section className="main-panel">
        <div className="rag-toolbar">
          <button className="ghost" onClick={onBackToLibrary}>
            ← Documents
          </button>
          <span className="panel-note">
            {article?.id ?? "No article JSON"}
            {referenceSet ? ` · ${referenceSet.id}` : " · no reference JSON"}
          </span>
        </div>

        {loading && (
          <div className="loading inline-loading">
            <div className="spinner" />
            <span>{loading}</span>
          </div>
        )}
        {busy && (
          <div className="loading inline-loading">
            <div className="spinner" />
            <span>{busy}</span>
          </div>
        )}
        {error && <div className="error">{error}</div>}

        <div className="dataset-summary">
          <div className="article-meta-header">
            {article && article.year && <div className="article-year">{article.year}</div>}
            <h2>{article?.title || referenceSet?.title || referenceSet?.id}</h2>
            {article && article.authors && article.authors.length > 0 && (
              <div className="article-authors">{article.authors.join(", ")}</div>
            )}
            <p className="article-source-url">
              <a href={article?.sourceUrl || referenceSet?.sourceUrl} target="_blank" rel="noreferrer">
                {article?.sourceUrl || referenceSet?.sourceUrl}
              </a>
            </p>
          </div>
          <div className="summary-grid">
            <div>
              <strong>{article?.sections.length ?? 0}</strong>
              <span>sections</span>
            </div>
            <div>
              <strong>{article?.chunkCount ?? 0}</strong>
              <span>paragraphs</span>
            </div>
            <div>
              <strong>
                {referenceSet?.abstractFound ?? 0}
                <span className="summary-subvalue">/{referenceSet?.totalReferences ?? 0}</span>
              </strong>
              <span>abstract</span>
            </div>
          </div>
        </div>

        <section className="query-panel embedded-query">
          <textarea
            className="query-input"
            placeholder="Enter your question"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onQueryKey}
            rows={3}
          />
          <div className="controls">
            <label className="ctrl">
              Scope
              <select value={searchMode} onChange={(e) => setSearchMode(e.target.value as SearchMode)}>
                <option value="integrated">Integrated</option>
                <option value="article">Article</option>
                <option value="reference">Abstract</option>
              </select>
            </label>
            <label className="ctrl">
              <input type="checkbox" checked={translate} onChange={(e) => setTranslate(e.target.checked)} />
              JA→EN
            </label>
            <label className="ctrl">
              Top-K
              <input
                className="topk"
                type="number"
                min={1}
                max={20}
                value={topK}
                onChange={(e) => setTopK(Number(e.target.value))}
              />
            </label>
            <button
              className="primary"
              onClick={search}
              disabled={
                Boolean(busy) ||
                !query.trim() ||
                (searchMode === "article" && !article) ||
                (searchMode === "reference" && !referenceSet) ||
                (searchMode === "integrated" && (!article || !referenceSet))
              }
            >
              Search
            </button>
          </div>
        </section>

        {article && <ArticleContentBrowser article={article} />}

        {result && (
          <section className="result">
            <div className="answer-card">
              <div className="answer-head">
                <h2>Answer</h2>
                {result.enQuery !== result.originalQuery && <span className="trans">EN: {result.enQuery}</span>}
              </div>
              {"articleAnswer" in result ? (
                <div className="answer-split">
                  <AnswerBlock title="Main Article" text={result.articleAnswer} cite />
                  <AnswerBlock title="Reference Abstracts" text={result.referenceAnswer} cite />
                </div>
              ) : (
                <MarkdownText className="answer-text" text={result.answer} cite />
              )}
              {savedFile && <div className="saved-note">Saved: {savedFile}</div>}
            </div>
            {"articleAnswer" in result ? (
              <IntegratedSources sources={result.sources} />
            ) : (
              <>
                <div className="sources-head">
                  <h2>Sources ({result.sources.length})</h2>
                </div>
                <div className="sources">
                  {"articleId" in result
                    ? result.sources.map((source, idx) => (
                        <ArticleResultSource
                          key={`${source.section}-${source.subsection}-${source.paragraphIndex}-${idx}`}
                          source={source}
                          idx={idx}
                        />
                      ))
                    : result.sources.map((source, idx) => (
                        <ResultSource key={`${source.pmid}-${idx}`} source={source} idx={idx} />
                      ))}
                </div>
              </>
            )}
          </section>
        )}

        {referenceSet && (
          <>
            <div className="sources-head">
              <h2>References ({referenceSet.records.length})</h2>
            </div>
            <div className="ref-list">
              {referenceSet.records.map((record) => (
                <ReferenceRow key={`${record.index}-${record.pmid}-${record.href}`} record={record} />
              ))}
            </div>
          </>
        )}
      </section>
    </ReferenceMapContext.Provider>
  );
}
