// アプリのシェル。ドキュメント選択画面（Documents）、複数論文RAG画面（RAG）、論文1本を読む画面（Preview）を切り替える。
// データの読み込みと、RAG の対象にする論文の選択（corpus）はここに集約する。
// 対象は「フォルダ（Zotero コレクション）単位のスコープ」か「手動で選んだ論文」のどちらか。
// フォルダスコープ中は中身を毎回フォルダから引き直すので、Zotero を同期し直しても対象が追従する。
import { useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "./api.js";
import { documentsInFolder, scopeLabel } from "./documents.js";
import { LibraryScreen } from "./LibraryScreen.js";
import { ManuscriptScreen } from "./ManuscriptScreen.js";
import { PreviewScreen } from "./PreviewScreen.js";
import { RagScreen } from "./RagScreen.js";
import type { ArticleSetSummary, CorpusScope, LibraryState, PreviewTarget, ReferenceSetSummary, Rxfp1ArticleSummary, Status } from "./types.js";

type Theme = "light" | "dark";
type Screen = "library" | "rag" | "preview" | "manuscript";

const CORPUS_KEY = "corpusIds";
const SCOPE_KEY = "corpusScope";
const PREVIEW_KEY = "previewIds";
const RECENT_LIMIT = 8;

function initialCorpus(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(CORPUS_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function initialScope(): CorpusScope | null {
  try {
    const saved = JSON.parse(localStorage.getItem(SCOPE_KEY) ?? "null");
    return typeof saved?.folderId === "string" && saved.folderId
      ? { folderId: saved.folderId, includeSubfolders: saved.includeSubfolders !== false }
      : null;
  } catch {
    return null;
  }
}

// 最近 Preview で開いた論文（新しい順）。先頭を次回起動時に開いておく。
function initialRecent(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(PREVIEW_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string").slice(0, RECENT_LIMIT) : [];
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
  const [rxfp1Articles, setRxfp1Articles] = useState<Rxfp1ArticleSummary[]>([]);
  const [referenceSets, setReferenceSets] = useState<ReferenceSetSummary[]>([]);
  const [library, setLibrary] = useState<LibraryState>(EMPTY_LIBRARY);
  const [corpusIds, setCorpusIds] = useState<string[]>(initialCorpus);
  const [corpusScope, setCorpusScope] = useState<CorpusScope | null>(initialScope);
  const [recentIds, setRecentIds] = useState<string[]>(initialRecent);
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(() =>
    recentIds[0] ? { articleId: recentIds[0], nonce: 0 } : null,
  );
  const [loading, setLoading] = useState("Loading documents...");
  const [error, setError] = useState("");

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(CORPUS_KEY, JSON.stringify(corpusIds));
  }, [corpusIds]);

  useEffect(() => {
    localStorage.setItem(SCOPE_KEY, JSON.stringify(corpusScope));
  }, [corpusScope]);

  useEffect(() => {
    localStorage.setItem(PREVIEW_KEY, JSON.stringify(recentIds));
  }, [recentIds]);

  async function refreshLists(): Promise<void> {
    const [articles, references, nextLibrary, archive] = await Promise.all([
      api.articleSets(),
      api.referenceSets(),
      api.library(),
      api.rxfp1Articles(),
    ]);
    setArticleSets(articles);
    setRxfp1Articles(archive);
    setReferenceSets(references);
    setLibrary(nextLibrary);
  }

  useEffect(() => {
    api.status().then(setStatus).catch(() => setStatus(null));
    refreshLists()
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(""));
  }, []);

  const byId = useMemo(() => {
    const lookup = new Map(articleSets.map((set) => [set.id, set]));
    for (const set of articleSets) {
      for (const alias of set.legacyRxfp1Ids ?? []) if (!lookup.has(alias)) lookup.set(alias, set);
    }
    return lookup;
  }, [articleSets]);

  // Canonical IDs keep selections and Preview history valid after the RXFP1 migration.
  useEffect(() => {
    if (loading) return;
    const canonical = (ids: string[]) => [...new Set(ids.flatMap((id) => byId.get(id)?.id ?? []))];
    setRecentIds(canonical);
    setCorpusIds(canonical);
    setPreviewTarget((prev) => {
      const id = prev && byId.get(prev.articleId)?.id;
      return id && prev ? { ...prev, articleId: id } : null;
    });
  }, [loading, byId]);

  // Zotero 同期などでスコープのフォルダが消えたら、フォルダスコープを外す（手動選択に戻る）。
  useEffect(() => {
    if (loading || !corpusScope) return;
    if (!library.folders.some((folder) => folder.id === corpusScope.folderId)) setCorpusScope(null);
  }, [loading, library, corpusScope]);

  // フォルダスコープならフォルダの現在の中身、そうでなければ手動選択。
  // 消えた論文（再取り込みで ID が変わった等）は選択から外す。選択順は保つ。
  const corpusPapers = useMemo(() => {
    if (corpusScope) {
      return documentsInFolder(articleSets, library, corpusScope.folderId, corpusScope.includeSubfolders);
    }
    return corpusIds.flatMap((id) => byId.get(id) ?? []);
  }, [articleSets, library, corpusIds, corpusScope, byId]);

  const rxfp1Searchable = rxfp1Articles.filter((set) => set.searchable);
  const rxfp1Ids = new Set(rxfp1Articles.map((set) => set.id));
  const isRxfp1Scope = corpusPapers.length > 0 && corpusPapers.every((paper) => rxfp1Ids.has(paper.id));
  const corpusLabel = corpusScope
    ? scopeLabel(library.folders, corpusScope.folderId, corpusScope.includeSubfolders)
    : isRxfp1Scope ? "RXFP1 folder" : "Custom selection";

  // 手動でチェックを付け外ししたら、その時点のフォルダの中身を起点にした手動選択へ切り替える。
  function setSelected(ids: string[], selected: boolean) {
    const base = corpusScope ? corpusPapers.map((set) => set.id) : corpusIds;
    const next = selected ? [...new Set([...base, ...ids])]
      : base.filter((id) => !ids.includes(id));
    setCorpusScope(null);
    setCorpusIds(next);
  }

  function askFolder(scope: CorpusScope) {
    setCorpusScope(scope);
    setScreen("rag");
  }

  function askRxfp1() {
    setCorpusScope(null);
    setCorpusIds(rxfp1Searchable.map((set) => set.id));
    setScreen("rag");
  }

  function openPreview(articleId: string, passage?: PreviewTarget["passage"]) {
    setPreviewTarget((prev) => ({ articleId, passage, nonce: (prev?.nonce ?? 0) + 1 }));
    setRecentIds((prev) => [articleId, ...prev.filter((id) => id !== articleId)].slice(0, RECENT_LIMIT));
    setScreen("preview");
  }

  function clearSelection() {
    setCorpusScope(null);
    setCorpusIds([]);
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo-mark">R</span>
          <div>
            <h1>Corpus RAG</h1>
            <p className="subtitle">Ask across a Zotero folder (10–30 papers) · paragraph search with paper metadata</p>
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
          <button
            className={screen === "preview" ? "nav-btn active" : "nav-btn"}
            onClick={() => setScreen("preview")}
            title={previewTarget ? previewTarget.articleId : "Open a paper to read its main text and references"}
          >
            Preview
          </button>
          <button
            className={screen === "manuscript" ? "nav-btn active" : "nav-btn"}
            onClick={() => setScreen("manuscript")}
          >
            Manuscript
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

        {/* すべてマウントしたまま表示だけ切り替え、検索結果や入力を画面移動で失わないようにする。 */}
        <div className="screen" hidden={screen !== "library"}>
          <LibraryScreen
            articleSets={articleSets}
            referenceSets={referenceSets}
            library={library}
            selectedIds={corpusPapers.map((set) => set.id)}
            scope={corpusScope}
            scopeLabel={corpusLabel}
            loading={loading}
            onLibraryChange={setLibrary}
            onRefresh={refreshLists}
            onSelect={setSelected}
            onClearSelection={clearSelection}
            onAsk={() => setScreen("rag")}
            onAskFolder={askFolder}
            rxfp1Count={rxfp1Searchable.length}
            onAskRxfp1={askRxfp1}
            onPreview={(id) => openPreview(id)}
            onError={setError}
          />
        </div>

        <div className="screen" hidden={screen !== "rag"}>
          <RagScreen
            key={isRxfp1Scope ? "rxfp1" : "current"}
            rxfp1={isRxfp1Scope}
            papers={corpusPapers}
            scopeLabel={corpusLabel}
            active={screen === "rag"}
            onRemove={(id) => setSelected([id], false)}
            onPreview={openPreview}
            onBackToLibrary={() => setScreen("library")}
          />
        </div>

        <div className="screen" hidden={screen !== "preview"}>
          <PreviewScreen
            articleSets={articleSets}
            referenceSets={referenceSets}
            library={library}
            target={previewTarget}
            recentIds={recentIds}
            active={screen === "preview"}
            onOpen={(id) => openPreview(id)}
            onBackToLibrary={() => setScreen("library")}
          />
        </div>
        <div className="screen" hidden={screen !== "manuscript"}>
          <ManuscriptScreen rxfp1Available={rxfp1Articles.length > 0} />
        </div>
      </main>
    </div>
  );
}
