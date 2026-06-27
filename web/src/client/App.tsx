import { Fragment, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type {
  ArticleQueryResult,
  ArticleSet,
  ArticleSetSummary,
  IntegratedQueryResult,
  ReferenceQueryResult,
  ReferenceRecord,
  ReferenceSet,
  ReferenceSetSummary,
  Status,
} from "./types.js";

type Theme = "light" | "dark";
type SearchMode = "integrated" | "article" | "reference";
type QueryResultUnion = ReferenceQueryResult | ArticleQueryResult | IntegratedQueryResult;

function renderInlineMarkdown(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, idx) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={idx}>{part.slice(2, -2)}</strong>;
    }
    return <Fragment key={idx}>{part}</Fragment>;
  });
}

function renderMarkdownLine(text: string): ReactNode[] {
  return text.split("\n").flatMap((line, idx) => {
    const nodes = renderInlineMarkdown(line);
    return idx === 0 ? nodes : [<br key={`br-${idx}`} />, ...nodes];
  });
}

function MarkdownText({ className, text }: { className?: string; text: string }) {
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    blocks.push(
      <p className="markdown-paragraph" key={`p-${blocks.length}`}>
        {renderMarkdownLine(paragraph.join("\n"))}
      </p>,
    );
    paragraph = [];
  }

  function flushList() {
    if (!listItems.length) return;
    blocks.push(
      <ul className="markdown-list" key={`ul-${blocks.length}`}>
        {listItems.map((item, idx) => (
          <li key={idx}>{renderInlineMarkdown(item)}</li>
        ))}
      </ul>,
    );
    listItems = [];
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const listMatch = line.match(/^\s*[-*]\s+(.+)$/);
    if (!line.trim()) {
      flushParagraph();
      flushList();
    } else if (listMatch) {
      flushParagraph();
      listItems.push(listMatch[1]);
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();

  return <div className={className}>{blocks}</div>;
}

function initialTheme(): Theme {
  const saved = localStorage.getItem("theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

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

function datasetBaseId(id: string): string {
  return id.replace(/-\d+$/, "");
}

function datasetLabel(id: string): string {
  return id;
}

function matchingReferenceSet(articleId: string, summaries: ReferenceSetSummary[]): ReferenceSetSummary | undefined {
  const baseId = datasetBaseId(articleId);
  return summaries
    .filter((set) => datasetBaseId(set.id) === baseId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function ScoreBar({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, score * 100));
  return (
    <div className="scorebar" title={`score: ${score.toFixed(4)}`}>
      <div className="scorebar-fill" style={{ width: `${pct}%` }} />
      <span className="scorebar-label">{score.toFixed(3)}</span>
    </div>
  );
}

function ReferenceRow({ record }: { record: ReferenceRecord }) {
  const abstract = record.pubmed?.abstract ?? "";
  return (
    <div className={abstract ? "ref-row" : "ref-row muted-row"}>
      <div className="ref-index">{record.index}</div>
      <div className="ref-main">
        <div className="ref-title">{record.pubmed?.title || record.text}</div>
        <div className="ref-meta">
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
  );
}

function ResultSource({ source, idx }: { source: ReferenceQueryResult["sources"][number]; idx: number }) {
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
          {open ? "閉じる" : "Abstractを表示"}
        </button>
      )}
    </div>
  );
}

function ArticleResultSource({ source, idx }: { source: ArticleQueryResult["sources"][number]; idx: number }) {
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
      <p className="source-text">{open ? source.text : preview}</p>
      {source.text.length > 360 && (
        <button className="link-btn" onClick={() => setOpen((v) => !v)}>
          {open ? "閉じる" : "段落を表示"}
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

      <p className="source-text">{open ? source.text : preview}</p>

      {source.text.length > 360 && (
        <button className="link-btn" onClick={() => setOpen((v) => !v)}>
          {open ? "閉じる" : "本文を表示"}
        </button>
      )}
    </div>
  );
}

function IntegratedSources({ sources }: { sources: IntegratedQueryResult["sources"] }) {
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

function AnswerBlock({ title, text }: { title: string; text: string }) {
  return (
    <div className="answer-block">
      <h3>{title}</h3>
      <MarkdownText className="answer-text" text={text} />
    </div>
  );
}

export function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [status, setStatus] = useState<Status | null>(null);
  const [sets, setSets] = useState<ReferenceSetSummary[]>([]);
  const [articleSets, setArticleSets] = useState<ArticleSetSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selectedArticleId, setSelectedArticleId] = useState("");
  const [currentSet, setCurrentSet] = useState<ReferenceSet | null>(null);
  const [currentArticle, setCurrentArticle] = useState<ArticleSet | null>(null);
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState(5);
  const [translate, setTranslate] = useState(true);
  const [searchMode, setSearchMode] = useState<SearchMode>("integrated");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [savedFile, setSavedFile] = useState("");
  const [sessionId] = useState(initialSessionId);
  const [result, setResult] = useState<QueryResultUnion | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  async function fetchReferenceSetSummaries(): Promise<ReferenceSetSummary[]> {
    const res = await fetch("/api/reference/sets");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "データセット一覧を取得できませんでした");
    const nextSets = data.sets ?? [];
    setSets(nextSets);
    return nextSets;
  }

  async function fetchArticleSetSummaries(): Promise<ArticleSetSummary[]> {
    const res = await fetch("/api/article/sets");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "主論文JSON一覧を取得できませんでした");
    const nextSets = data.sets ?? [];
    setArticleSets(nextSets);
    return nextSets;
  }

  async function loadMatchingReferenceSet(articleId: string, summaries?: ReferenceSetSummary[]) {
    const nextSets = summaries ?? (sets.length ? sets : await fetchReferenceSetSummaries());
    const match = matchingReferenceSet(articleId, nextSets);
    const id = match?.id ?? "";
    setSelectedId(id);
    if (id) {
      await loadSet(id);
    } else {
      setCurrentSet(null);
      setResult(null);
    }
  }

  async function loadArticleSets(nextId?: string) {
    const [nextSets, referenceSets] = await Promise.all([
      fetchArticleSetSummaries(),
      fetchReferenceSetSummaries(),
    ]);
    const id = nextId || selectedArticleId || nextSets[0]?.id || "";
    if (id) {
      setSelectedArticleId(id);
      await loadArticleSet(id);
      await loadMatchingReferenceSet(id, referenceSets);
    } else {
      setSelectedArticleId("");
      setSelectedId("");
      setCurrentArticle(null);
      setCurrentSet(null);
      setResult(null);
    }
  }

  async function loadSet(id: string) {
    const res = await fetch(`/api/reference/sets/${encodeURIComponent(id)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "JSONを読み込めませんでした");
    setCurrentSet(data);
    setResult(null);
  }

  async function loadArticleSet(id: string) {
    const res = await fetch(`/api/article/sets/${encodeURIComponent(id)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "主論文JSONを読み込めませんでした");
    setCurrentArticle(data);
    setResult(null);
  }

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus(null));
    loadArticleSets().catch(() => undefined);
  }, []);

  async function saveResult(nextResult: QueryResultUnion) {
    const res = await fetch("/api/session/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, result: nextResult }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Markdown保存に失敗しました");
    setSavedFile(data.file ?? "");
  }

  async function search() {
    if (!query.trim() || busy) return;
    if (searchMode === "reference" && !currentSet) return;
    if (searchMode === "article" && !currentArticle) return;
    if (searchMode === "integrated" && (!currentArticle || !currentSet)) return;
    setBusy(translate ? "翻訳してRAG検索中..." : "RAG検索中...");
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
          ? { articleId: currentArticle?.id, query: query.trim(), topK, translate }
          : searchMode === "integrated"
            ? { articleId: currentArticle?.id, referenceSetId: currentSet?.id, query: query.trim(), topK, translate }
            : { setId: currentSet?.id, query: query.trim(), topK, translate };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "検索に失敗しました");
      setResult(data);
      await saveResult(data);
    } catch (e: any) {
      setError(String(e?.message ?? e));
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

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo-mark">R</span>
          <div>
            <h1>Reference Abstract RAG</h1>
            <p className="subtitle">HTML references → PubMed abstracts → JSON search</p>
          </div>
        </div>
        <div className="status">
          <button
            className="theme-toggle"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            title={theme === "dark" ? "ライトテーマに切替" : "ダークテーマに切替"}
            aria-label="テーマ切替"
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          {status?.hasApiKey ? <span className="badge badge-ok">API ready</span> : <span className="badge badge-warn">API key</span>}
        </div>
      </header>

      <main className="workspace">
        <section className="tool-panel">
          <div className="panel-head">
            <h2>Datasets</h2>
            <span className="panel-note">Bookmarklet input</span>
          </div>

          <div className="dataset-picker">
            <label className="field">
              <span>主論文JSON</span>
              <select
                value={selectedArticleId}
                onChange={(e) => {
                  const id = e.target.value;
                  setSelectedArticleId(id);
                  if (id) {
                    loadArticleSet(id)
                      .then(() => loadMatchingReferenceSet(id))
                      .catch((err) => setError(String(err?.message ?? err)));
                  } else {
                    setCurrentArticle(null);
                    setSelectedId("");
                    setCurrentSet(null);
                    setResult(null);
                  }
                }}
              >
                <option value="">未選択</option>
                {articleSets.map((set) => (
                  <option key={set.id} value={set.id}>
                    {datasetLabel(set.id)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Reference JSON</span>
              <div className={selectedId ? "dataset-value" : "dataset-value muted-dataset-value"}>
                {selectedId ? datasetLabel(selectedId) : "対応するJSONなし"}
              </div>
            </label>
            <button className="ghost refresh-btn" onClick={() => { loadArticleSets().catch((err) => setError(String(err?.message ?? err))); }}>
              一覧を更新
            </button>
          </div>
        </section>

        <section className="main-panel">
          {busy && <div className="loading inline-loading"><div className="spinner" /><span>{busy}</span></div>}
          {error && <div className="error">{error}</div>}

          {currentSet || currentArticle ? (
            <>
              <div className="dataset-summary">
                <div>
                  <h2>{currentArticle?.title || currentSet?.title || currentSet?.id}</h2>
                  <p>{currentArticle?.sourceUrl || currentSet?.sourceUrl}</p>
                </div>
                <div className="summary-grid">
                  <div><strong>{currentArticle?.sections.length ?? 0}</strong><span>sections</span></div>
                  <div><strong>{currentArticle?.chunkCount ?? 0}</strong><span>paragraphs</span></div>
                  <div>
                    <strong>
                      {currentSet?.abstractFound ?? 0}
                      <span className="summary-subvalue">/{currentSet?.totalReferences ?? 0}</span>
                    </strong>
                    <span>abstract</span>
                  </div>
                </div>
              </div>

              <section className="query-panel embedded-query">
                <textarea
                  className="query-input"
                  placeholder="質問を入力"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onQueryKey}
                  rows={3}
                />
                <div className="controls">
                  <label className="ctrl">
                    対象
                    <select value={searchMode} onChange={(e) => setSearchMode(e.target.value as SearchMode)}>
                      <option value="integrated">統合</option>
                      <option value="article">主論文</option>
                      <option value="reference">Abstract</option>
                    </select>
                  </label>
                  <label className="ctrl">
                    <input type="checkbox" checked={translate} onChange={(e) => setTranslate(e.target.checked)} />
                    日本語→英語
                  </label>
                  <label className="ctrl">
                    Top-K
                    <input className="topk" type="number" min={1} max={20} value={topK} onChange={(e) => setTopK(Number(e.target.value))} />
                  </label>
                  <button
                    className="primary"
                    onClick={search}
                    disabled={
                      Boolean(busy) ||
                      !query.trim() ||
                      (searchMode === "article" && !currentArticle) ||
                      (searchMode === "reference" && !currentSet) ||
                      (searchMode === "integrated" && (!currentArticle || !currentSet))
                    }
                  >
                    検索
                  </button>
                </div>
              </section>

              {result && (
                <section className="result">
                  <div className="answer-card">
                    <div className="answer-head">
                      <h2>Answer</h2>
                      {result.enQuery !== result.originalQuery && <span className="trans">EN: {result.enQuery}</span>}
                    </div>
                    {"articleAnswer" in result ? (
                      <div className="answer-split">
                        <AnswerBlock title="Main Article" text={result.articleAnswer} />
                        <AnswerBlock title="Reference Abstracts" text={result.referenceAnswer} />
                      </div>
                    ) : (
                      <MarkdownText className="answer-text" text={result.answer} />
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
                              <ArticleResultSource key={`${source.section}-${source.subsection}-${source.paragraphIndex}-${idx}`} source={source} idx={idx} />
                            ))
                          : result.sources.map((source, idx) => (
                              <ResultSource key={`${source.pmid}-${idx}`} source={source} idx={idx} />
                            ))}
                      </div>
                    </>
                  )}
                </section>
              )}

              {currentArticle && (
                <>
                  <div className="sources-head">
                    <h2>Main Article ({currentArticle.chunkCount})</h2>
                  </div>
                  <div className="ref-list">
                    {currentArticle.sections.map((section) => (
                      <div key={`${section.type}-${section.title}`} className="ref-row">
                        <div className="ref-index">{section.paragraphs.length + section.subsections.reduce((n, sub) => n + sub.paragraphs.length, 0)}</div>
                        <div className="ref-main">
                          <div className="ref-title">{section.title}</div>
                          <div className="ref-meta">
                            <span>{section.type}</span>
                            {section.subsections.map((sub) => (
                              <span key={sub.title}>{sub.title}</span>
                            ))}
                          </div>
                        </div>
                        <span className="pill ok">JSON</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {currentSet && (
                <>
                  <div className="sources-head">
                    <h2>References ({currentSet.records.length})</h2>
                  </div>
                  <div className="ref-list">
                    {currentSet.records.map((record) => (
                      <ReferenceRow key={`${record.index}-${record.pmid}-${record.href}`} record={record} />
                    ))}
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="empty-state">
              <h2>JSON未選択</h2>
              <p>論文ページのURLを入力するか、保存済みJSONを選択してください。</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
