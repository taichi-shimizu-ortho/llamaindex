// アプリのシェル。ドキュメント選択画面（Documents）と複数論文RAG画面（RAG）を切り替える。
// データの読み込みと、RAG の対象にする論文の選択（corpus）はここに集約する。
import { useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "./api.js";
import { LibraryScreen } from "./LibraryScreen.js";
import { RagScreen } from "./RagScreen.js";
import type { ArticleSetSummary, LibraryState, ReferenceSetSummary, Status } from "./types.js";

type Theme = "light" | "dark";
type Screen = "library" | "rag";

const CORPUS_KEY = "corpusIds";

function initialCorpus(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(CORPUS_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function initialTheme(): Theme {
  const saved = localStorage.getItem("theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

const EMPTY_LIBRARY: LibraryState = { folders: [], assignments: {} };

export function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [status, setStatus] = useState<Status | null>(null);
  const [screen, setScreen] = useState<Screen>("library");
  const [articleSets, setArticleSets] = useState<ArticleSetSummary[]>([]);
  const [referenceSets, setReferenceSets] = useState<ReferenceSetSummary[]>([]);
  const [library, setLibrary] = useState<LibraryState>(EMPTY_LIBRARY);
  const [corpusIds, setCorpusIds] = useState<string[]>(initialCorpus);
  const [loading, setLoading] = useState("Loading documents...");
  const [error, setError] = useState("");

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(CORPUS_KEY, JSON.stringify(corpusIds));
  }, [corpusIds]);

  async function refreshLists(): Promise<void> {
    const [articles, references, nextLibrary] = await Promise.all([
      api.articleSets(),
      api.referenceSets(),
      api.library(),
    ]);
    setArticleSets(articles);
    setReferenceSets(references);
    setLibrary(nextLibrary);
  }

  useEffect(() => {
    api.status().then(setStatus).catch(() => setStatus(null));
    refreshLists()
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(""));
  }, []);

  // 消えた論文（再取り込みで ID が変わった等）は選択から外す。選択順は保つ。
  const corpusPapers = useMemo(() => {
    const byId = new Map(articleSets.map((set) => [set.id, set]));
    return corpusIds.flatMap((id) => byId.get(id) ?? []);
  }, [articleSets, corpusIds]);

  function setSelected(ids: string[], selected: boolean) {
    setCorpusIds((prev) => {
      if (!selected) return prev.filter((id) => !ids.includes(id));
      const next = [...prev];
      for (const id of ids) if (!next.includes(id)) next.push(id);
      return next;
    });
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo-mark">R</span>
          <div>
            <h1>Corpus RAG</h1>
            <p className="subtitle">Ask across 10–30 papers · paragraph search with paper metadata</p>
          </div>
        </div>

        <nav className="screen-nav" aria-label="Screens">
          <button
            className={screen === "library" ? "nav-btn active" : "nav-btn"}
            onClick={() => setScreen("library")}
          >
            Documents
          </button>
          <button
            className={screen === "rag" ? "nav-btn active" : "nav-btn"}
            onClick={() => setScreen("rag")}
            disabled={!corpusPapers.length}
            title={corpusPapers.length ? undefined : "Select papers first"}
          >
            RAG{corpusPapers.length ? ` (${corpusPapers.length})` : ""}
          </button>
        </nav>

        <div className="status">
          <button
            className="theme-toggle"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            aria-label="Toggle theme"
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          {status?.llmModel && (
            <span className="badge badge-model" title={`Answer model: ${status.llmModel}`}>
              {status.llmLabel}
            </span>
          )}
          {status?.hasApiKey ? (
            <span className="badge badge-ok">API ready</span>
          ) : (
            <span className="badge badge-warn" title={status?.missingKeys?.length ? `Missing: ${status.missingKeys.join(", ")}` : undefined}>
              API key
            </span>
          )}
        </div>
      </header>

      <main className="workspace">
        {error && <div className="error">{error}</div>}

        {/* 両方マウントしたまま表示だけ切り替え、検索結果や入力を画面移動で失わないようにする。 */}
        <div className="screen" hidden={screen !== "library"}>
          <LibraryScreen
            articleSets={articleSets}
            referenceSets={referenceSets}
            library={library}
            selectedIds={corpusIds}
            loading={loading}
            onLibraryChange={setLibrary}
            onRefresh={refreshLists}
            onSelect={setSelected}
            onClearSelection={() => setCorpusIds([])}
            onAsk={() => setScreen("rag")}
            onError={setError}
          />
        </div>

        <div className="screen" hidden={screen !== "rag"}>
          <RagScreen
            papers={corpusPapers}
            active={screen === "rag"}
            onRemove={(id) => setSelected([id], false)}
            onBackToLibrary={() => setScreen("library")}
          />
        </div>
      </main>
    </div>
  );
}
