// 複数論文 RAG 画面。Documents で選んだ論文（10〜30本を想定）を段落単位で横断検索し、
// 回答中の [S3] から根拠の段落へ飛べるようにする。単一論文の読解は 50_article-json 側の全文検索に任せる。
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "./api.js";
import { documentLabel } from "./documents.js";
import { MarkdownText, PassageMapContext, type PassageMap } from "./markdown.js";
import { modelLabel } from "../shared/modelLabel.js";
import { CorpusSourceCard, SECTION_GROUP_LABEL } from "./Sources.js";
import type { ArticleSetSummary, CorpusPrepareResult, CorpusQueryResult, SectionGroup } from "./types.js";

const SECTION_GROUPS = Object.keys(SECTION_GROUP_LABEL) as SectionGroup[];

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
  // 選択中の論文（corpus）
  papers: ArticleSetSummary[];
  active: boolean;
  onRemove: (id: string) => void;
  onBackToLibrary: () => void;
}

export function RagScreen({ papers, active, onRemove, onBackToLibrary }: RagScreenProps) {
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState(10);
  const [perPaper, setPerPaper] = useState(3);
  const [translate, setTranslate] = useState(true);
  // 空 = すべての節
  const [groups, setGroups] = useState<SectionGroup[]>([]);
  const [prepared, setPrepared] = useState<CorpusPrepareResult | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [savedFile, setSavedFile] = useState("");
  const [sessionId] = useState(initialSessionId);
  const [result, setResult] = useState<CorpusQueryResult | null>(null);
  const [flash, setFlash] = useState(0);
  const flashTimer = useRef<number | undefined>(undefined);

  const ids = useMemo(() => papers.map((p) => p.id), [papers]);
  const idsKey = ids.join("|");

  // 画面を開いた時点で埋め込みを用意しておく（初回だけ時間がかかる）。
  useEffect(() => {
    if (!active || !ids.length) return;
    let cancelled = false;
    setPreparing(true);
    setError("");
    api
      .corpusPrepare(ids)
      .then((data) => !cancelled && setPrepared(data))
      .catch((e) => !cancelled && setError(errorMessage(e)))
      .finally(() => !cancelled && setPreparing(false));
    return () => {
      cancelled = true;
    };
  }, [active, idsKey]);

  const preparedById = useMemo(() => new Map(prepared?.papers.map((p) => [p.id, p]) ?? []), [prepared]);
  const hitsById = useMemo(() => new Map(result?.papers.map((p) => [p.id, p.hits]) ?? []), [result]);

  const passageMap = useMemo<PassageMap>(
    () => ({
      sources: new Map(result?.sources.map((s) => [s.n, s]) ?? []),
      onOpen: (n) => {
        document.getElementById(`passage-${n}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        setFlash(n);
        window.clearTimeout(flashTimer.current);
        flashTimer.current = window.setTimeout(() => setFlash(0), 1600);
      },
    }),
    [result],
  );

  function toggleGroup(group: SectionGroup) {
    setGroups((prev) => (prev.includes(group) ? prev.filter((g) => g !== group) : [...prev, group]));
  }

  async function search() {
    if (!query.trim() || busy || !ids.length) return;
    setBusy(translate ? "Translating & searching..." : "Searching...");
    setError("");
    try {
      const data = await api.corpusQuery({ articleIds: ids, query: query.trim(), topK, perPaper, sectionGroups: groups, translate });
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

  if (!papers.length) {
    return (
      <section className="main-panel">
        <div className="empty-state">
          <h2>No papers selected</h2>
          <p>Tick papers on the Documents screen (or select a whole folder), then ask across them.</p>
          <button className="primary" onClick={onBackToLibrary}>
            Go to Documents
          </button>
        </div>
      </section>
    );
  }

  const skipped = result?.skipped ?? prepared?.skipped ?? [];

  return (
    <section className="main-panel">
      <div className="rag-toolbar">
        <button className="ghost" onClick={onBackToLibrary}>
          ← Documents
        </button>
        <span className="panel-note">
          {papers.length} papers
          {prepared ? ` · ${prepared.totalParagraphs} paragraphs indexed` : ""}
        </span>
      </div>

      {preparing && (
        <div className="loading inline-loading">
          <div className="spinner" />
          <span>Embedding {papers.length} papers (cached papers are instant)...</span>
        </div>
      )}
      {busy && (
        <div className="loading inline-loading">
          <div className="spinner" />
          <span>{busy}</span>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {skipped.length > 0 && (
        <div className="error">
          Skipped: {skipped.map((s) => `${s.id} (${s.error})`).join(", ")}
        </div>
      )}

      <details className="corpus-papers" open={papers.length <= 12}>
        <summary>
          <h2>Papers ({papers.length})</h2>
          <span className="panel-note">Remove a paper to leave it out of the search</span>
        </summary>
        <ul className="paper-list">
          {papers.map((paper) => {
            const info = preparedById.get(paper.id);
            const hits = hitsById.get(paper.id) ?? 0;
            return (
              <li key={paper.id} className={hits ? "paper-row hit" : "paper-row"}>
                <span className="paper-label">{info?.label ?? paper.id}</span>
                <span className="paper-title" title={documentLabel(paper)}>
                  {documentLabel(paper)}
                </span>
                <span className="paper-meta">
                  {[info?.year, info ? `${info.paragraphs} ¶` : ""].filter(Boolean).join(" · ")}
                </span>
                {result && <span className={hits ? "pill ok" : "pill"}>{hits} hits</span>}
                <button className="link-btn" onClick={() => onRemove(paper.id)} aria-label={`Remove ${paper.id}`}>
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      </details>

      <section className="query-panel embedded-query">
        <textarea
          className="query-input"
          placeholder="Ask across the selected papers (Ctrl/⌘+Enter)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onQueryKey}
          rows={3}
        />
        <div className="controls">
          <label className="ctrl">
            <input type="checkbox" checked={translate} onChange={(e) => setTranslate(e.target.checked)} />
            JA→EN
          </label>
          <label className="ctrl" title="Paragraphs passed to the answer model">
            Top-K
            <input className="topk" type="number" min={1} max={40} value={topK} onChange={(e) => setTopK(Number(e.target.value))} />
          </label>
          <label className="ctrl" title="Most paragraphs taken from one paper (0 = no limit)">
            Per paper
            <input className="topk" type="number" min={0} max={40} value={perPaper} onChange={(e) => setPerPaper(Number(e.target.value))} />
          </label>
          <button className="primary" onClick={search} disabled={Boolean(busy) || !query.trim()}>
            Search
          </button>
        </div>
        <div className="section-filter">
          <span className="section-filter-label">Sections</span>
          <button className={groups.length ? "fchip" : "fchip active"} onClick={() => setGroups([])}>
            All
          </button>
          {SECTION_GROUPS.map((group) => (
            <button key={group} className={groups.includes(group) ? "fchip active" : "fchip"} onClick={() => toggleGroup(group)}>
              {SECTION_GROUP_LABEL[group]}
            </button>
          ))}
        </div>
      </section>

      {result && (
        <PassageMapContext.Provider value={passageMap}>
          <section className="result">
            <div className="answer-card">
              <div className="answer-head">
                <h2>Answer</h2>
                {result.model && (
                  <span className="trans" title={result.model}>
                    {result.model.split(/,\s*/).map(modelLabel).join(", ")}
                  </span>
                )}
                {result.enQuery !== result.originalQuery && <span className="trans">EN: {result.enQuery}</span>}
                {result.sectionGroups.length ? (
                  <span className="trans">Sections: {result.sectionGroups.map((g) => SECTION_GROUP_LABEL[g]).join(", ")}</span>
                ) : null}
              </div>
              <MarkdownText className="answer-text" text={result.answer} cite />
              {savedFile && <div className="saved-note">Saved: {savedFile}</div>}
            </div>
            <div className="sources-head">
              <h2>
                Passages ({result.sources.length}) · {result.sources.filter((s) => s.cited).length} cited
              </h2>
            </div>
            <div className="sources">
              {result.sources.map((source) => (
                <CorpusSourceCard key={source.n} source={source} flash={flash === source.n} />
              ))}
            </div>
          </section>
        </PassageMapContext.Provider>
      )}
    </section>
  );
}
