// アプリのシェル。ドキュメント選択画面（Documents）とRAG画面（RAG）を切り替える。
// データの読み込みはここに集約し、各画面は受け取った値の表示に専念する。
import { useEffect, useState } from "react";
import { api, errorMessage } from "./api.js";
import { matchingReferenceSet } from "./documents.js";
import { LibraryScreen } from "./LibraryScreen.js";
import { RagScreen } from "./RagScreen.js";
import type {
  ArticleSet,
  ArticleSetSummary,
  LibraryState,
  ReferenceSet,
  ReferenceSetSummary,
  Status,
} from "./types.js";

type Theme = "light" | "dark";
type Screen = "library" | "rag";

const LAST_DOCUMENT_KEY = "lastDocumentId";

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
  const [selectedDocumentId, setSelectedDocumentId] = useState("");
  const [currentArticle, setCurrentArticle] = useState<ArticleSet | null>(null);
  const [currentSet, setCurrentSet] = useState<ReferenceSet | null>(null);
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  async function refreshLists(): Promise<{ articles: ArticleSetSummary[]; references: ReferenceSetSummary[] }> {
    const [articles, references, nextLibrary] = await Promise.all([
      api.articleSets(),
      api.referenceSets(),
      api.library(),
    ]);
    setArticleSets(articles);
    setReferenceSets(references);
    setLibrary(nextLibrary);
    return { articles, references };
  }

  // ドキュメントを選び直す。主論文JSONと、対応する参照文献JSONをまとめて読み込む。
  async function loadDocument(id: string, summaries?: ReferenceSetSummary[]): Promise<void> {
    setError("");
    setLoading("Loading document...");
    try {
      const article = await api.articleSet(id);
      setCurrentArticle(article);
      setSelectedDocumentId(id);
      localStorage.setItem(LAST_DOCUMENT_KEY, id);

      const references = summaries ?? (referenceSets.length ? referenceSets : await api.referenceSets());
      const match = matchingReferenceSet(id, references);
      setCurrentSet(match ? await api.referenceSet(match.id) : null);
    } catch (e) {
      setError(errorMessage(e));
      throw e;
    } finally {
      setLoading("");
    }
  }

  function openDocument(id: string) {
    loadDocument(id)
      .then(() => setScreen("rag"))
      .catch(() => undefined);
  }

  useEffect(() => {
    api.status().then(setStatus).catch(() => setStatus(null));
    refreshLists()
      .then(({ articles, references }) => {
        // 前回開いていたドキュメントがまだあれば、画面は移さずに読み込んでおく。
        const last = localStorage.getItem(LAST_DOCUMENT_KEY) ?? "";
        if (last && articles.some((set) => set.id === last)) {
          return loadDocument(last, references).catch(() => undefined);
        }
        return undefined;
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  const hasDocument = Boolean(currentArticle || currentSet);

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
            disabled={!hasDocument}
            title={hasDocument ? undefined : "Select a document first"}
          >
            RAG
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
          {status?.hasApiKey ? (
            <span className="badge badge-ok">API ready</span>
          ) : (
            <span className="badge badge-warn">API key</span>
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
            selectedDocumentId={selectedDocumentId}
            loading={loading}
            onLibraryChange={setLibrary}
            onRefresh={async () => {
              await refreshLists();
            }}
            onOpenDocument={openDocument}
            onError={setError}
          />
        </div>

        <div className="screen" hidden={screen !== "rag"}>
          <RagScreen
            article={currentArticle}
            referenceSet={currentSet}
            loading={loading}
            onBackToLibrary={() => setScreen("library")}
          />
        </div>
      </main>
    </div>
  );
}
