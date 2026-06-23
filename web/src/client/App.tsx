import { useEffect, useMemo, useState } from "react";
import type { QueryResult, SourceNode, Status } from "./types.js";

const SECTION_LABELS: Record<string, string> = {
  intro: "Intro",
  "materials|methods": "Methods",
  results: "Results",
  discussion: "Discussion",
  conclusion: "Conclusion",
  review: "Review",
  abstract: "Abstract",
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

function SourceCard({ s, idx }: { s: SourceNode; idx: number }) {
  const [open, setOpen] = useState(false);
  const sec = s.subsection ? `${s.section} › ${s.subsection}` : s.section;
  const preview = s.text.length > 240 ? s.text.slice(0, 240) + "…" : s.text;
  return (
    <div className="source-card">
      <div className="source-head">
        <span className="source-idx">{idx + 1}</span>
        <div className="source-cite">
          <div className="source-citekey">{s.citekey}</div>
          {s.title && <div className="source-title">{s.title}</div>}
          {s.journal && (
            <div className="source-journal">
              <em>{s.journal}</em>
              {s.published && ` · ${s.published}`}
              {s.volume && ` · ${s.volume}${s.issue ? `(${s.issue})` : ""}`}
            </div>
          )}
        </div>
        <ScoreBar score={s.score} />
      </div>
      <div className="source-meta">
        {s.section_type && (
          <span className={`chip chip-${s.section_type.replace(/[^a-z]/gi, "")}`}>
            {SECTION_LABELS[s.section_type] ?? s.section_type}
          </span>
        )}
        {sec && <span className="meta-sec">{sec}</span>}
        {s.paragraph_index ? (
          <span className="meta-para">¶ {s.paragraph_index}/{s.total_paragraphs}</span>
        ) : null}
        {s.doi && (
          <a className="meta-doi" href={`https://doi.org/${s.doi}`} target="_blank" rel="noreferrer">
            DOI
          </a>
        )}
        {s.pmid && (
          <a className="meta-doi" href={`https://pubmed.ncbi.nlm.nih.gov/${s.pmid}`} target="_blank" rel="noreferrer">
            PubMed
          </a>
        )}
      </div>
      <p className="source-text">{open ? s.text : preview}</p>
      {s.text.length > 240 && (
        <button className="link-btn" onClick={() => setOpen((v) => !v)}>
          {open ? "閉じる" : "全文を表示"}
        </button>
      )}
      {open && s.mesh_terms && <div className="source-mesh">MeSH: {s.mesh_terms}</div>}
    </div>
  );
}

type Theme = "light" | "dark";

function initialTheme(): Theme {
  const saved = localStorage.getItem("theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [status, setStatus] = useState<Status | null>(null);
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState(5);
  const [translate, setTranslate] = useState(true);
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [saved, setSaved] = useState("");

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  const sectionTypes = useMemo(() => {
    if (!result) return [];
    return Array.from(new Set(result.sources.map((s) => s.section_type).filter(Boolean)));
  }, [result]);

  const shownSources = useMemo(() => {
    if (!result) return [];
    if (filter === "all") return result.sources;
    return result.sources.filter((s) => s.section_type === filter);
  }, [result, filter]);

  async function send() {
    if (!query.trim() || loading) return;
    setLoading(true);
    setError("");
    setResult(null);
    setSaved("");
    setStage(translate ? "翻訳して検索中…" : "検索中…");
    try {
      const res = await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, topK, translate }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "検索に失敗しました");
      setResult(data);
      setFilter("all");
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
      setStage("");
    }
  }

  async function save() {
    if (!result) return;
    const res = await fetch("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
    });
    const data = await res.json();
    if (res.ok) setSaved(`保存しました: ${data.file.split("/").pop()}`);
  }

  function onKey(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send();
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">🧬</span>
          <div>
            <h1>RXFP1 文献検索</h1>
            <p className="subtitle">構造化JSON × ベクトル検索（LlamaIndex.TS）</p>
          </div>
        </div>
        <div className="status">
          <button
            className="theme-toggle"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            title={theme === "dark" ? "ライトテーマに切替" : "ダークテーマに切替"}
            aria-label="テーマ切替"
          >
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
          {status === null ? (
            <span className="dot dot-gray" />
          ) : status.indexReady && status.hasApiKey ? (
            <span className="badge badge-ok">準備完了</span>
          ) : (
            <span className="badge badge-warn">
              {!status.hasApiKey ? "APIキー未設定" : "インデックス未構築"}
            </span>
          )}
        </div>
      </header>

      <section className="query-panel">
        <textarea
          className="query-input"
          placeholder="質問を入力（日本語可）… 例: リラキシンはMMP-9をどの経路で誘導する？"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          rows={3}
        />
        <div className="controls">
          <label className="ctrl">
            <input type="checkbox" checked={translate} onChange={(e) => setTranslate(e.target.checked)} />
            日本語→英語に翻訳
          </label>
          <label className="ctrl">
            Top-K
            <input
              type="number"
              min={1}
              max={20}
              value={topK}
              onChange={(e) => setTopK(Number(e.target.value))}
              className="topk"
            />
          </label>
          <button className="primary" onClick={send} disabled={loading || !query.trim()}>
            {loading ? "検索中…" : "検索 (⌘/Ctrl+Enter)"}
          </button>
        </div>
      </section>

      {loading && (
        <div className="loading">
          <div className="spinner" />
          <span>{stage}</span>
        </div>
      )}
      {error && <div className="error">⚠ {error}</div>}

      {result && (
        <section className="result">
          <div className="answer-card">
            <div className="answer-head">
              <h2>回答</h2>
              <button className="ghost" onClick={save}>
                Markdownに保存
              </button>
            </div>
            {result.en_query !== result.original_query && (
              <div className="trans">EN: {result.en_query}</div>
            )}
            <p className="answer-text">{result.answer}</p>
            {saved && <div className="saved-note">✓ {saved}</div>}
          </div>

          <div className="sources-head">
            <h2>引用元 ({shownSources.length})</h2>
            <div className="filters">
              <button className={filter === "all" ? "fchip active" : "fchip"} onClick={() => setFilter("all")}>
                すべて
              </button>
              {sectionTypes.map((t) => (
                <button
                  key={t}
                  className={filter === t ? "fchip active" : "fchip"}
                  onClick={() => setFilter(t)}
                >
                  {SECTION_LABELS[t] ?? t}
                </button>
              ))}
            </div>
          </div>
          <div className="sources">
            {shownSources.map((s, i) => (
              <SourceCard key={i} s={s} idx={i} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
