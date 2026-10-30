// ドキュメント選択・取り込み画面。
// 取り込んだ主論文JSONをフォルダに整理し、複数論文RAGの対象を決める。
// 基本はフォルダ（Zotero コレクション）単位で「Ask this folder」、細かく足し引きしたいときはチェックで選ぶ。
import { useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "./api.js";
import type { ImportRequest } from "./api.js";
import {
  childFolders,
  documentFolderIds,
  documentLabel,
  documentsInFolder,
  flattenFolders,
  folderDescendants,
  folderPath,
  formatDate,
  matchingReferenceSet,
} from "./documents.js";
import type {
  ArticleSetSummary,
  CorpusScope,
  ImportReport,
  LibraryFolder,
  LibraryState,
  ReferenceSetSummary,
} from "./types.js";
import { ZoteroPanel } from "./ZoteroPanel.js";

// corpus RAG が想定する本数の上限。超えても検索はできるが、ボタンで注意を出す。
const CORPUS_SOFT_LIMIT = 30;

// 左ペインで選択中の絞り込み。フォルダIDそのものも入る。
type FolderView = "all" | "unfiled" | string;

type DragItem = { kind: "document" | "folder"; id: string };

type EditState = { mode: "create"; parentId: string | null } | { mode: "rename"; id: string };

interface LibraryScreenProps {
  articleSets: ArticleSetSummary[];
  referenceSets: ReferenceSetSummary[];
  library: LibraryState;
  // RAG の対象（corpus）に入っている論文
  selectedIds: string[];
  // フォルダ単位で対象にしているときのスコープ（手動選択なら null）
  scope: CorpusScope | null;
  scopeLabel: string;
  loading: string;
  onLibraryChange: (next: LibraryState) => void;
  onRefresh: () => Promise<void>;
  onSelect: (ids: string[], selected: boolean) => void;
  onClearSelection: () => void;
  onAsk: () => void;
  onAskFolder: (scope: CorpusScope) => void;
  onError: (message: string) => void;
}

function FolderSelect({
  folders,
  value,
  onChange,
  ariaLabel,
}: {
  folders: LibraryFolder[];
  value: string;
  onChange: (folderId: string) => void;
  ariaLabel?: string;
}) {
  return (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Unfiled</option>
      {flattenFolders(folders).map(({ folder, depth }) => (
        <option key={folder.id} value={folder.id}>
          {`${"  ".repeat(depth)}${folder.name}`}
        </option>
      ))}
    </select>
  );
}

function ImportPanel({
  folders,
  onImported,
  onError,
}: {
  folders: LibraryFolder[];
  onImported: (report: ImportReport, folderId: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [mode, setMode] = useState<"url" | "html">("url");
  const [sourceUrl, setSourceUrl] = useState("");
  const [html, setHtml] = useState("");
  const [title, setTitle] = useState("");
  const [limit, setLimit] = useState("");
  const [folderId, setFolderId] = useState("");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);

  const canSubmit = mode === "url" ? Boolean(sourceUrl.trim()) : Boolean(html.trim());

  async function submit() {
    if (busy || !canSubmit) return;
    const body: ImportRequest = {};
    if (sourceUrl.trim()) body.sourceUrl = sourceUrl.trim();
    if (mode === "html") body.html = html;
    if (title.trim()) body.title = title.trim();
    const parsedLimit = Number(limit);
    if (limit.trim() && Number.isFinite(parsedLimit) && parsedLimit > 0) body.limit = parsedLimit;

    setBusy(true);
    setReport(null);
    try {
      const result = await api.importDocument(body);
      setReport(result);
      await onImported(result, folderId);
      if (mode === "html") setHtml("");
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="tool-panel import-panel">
      <div className="panel-head">
        <h2>Import</h2>
        <span className="panel-note">Article JSON + reference JSON are created together</span>
      </div>

      <div className="import-modes">
        <button className={mode === "url" ? "fchip active" : "fchip"} onClick={() => setMode("url")}>
          From URL
        </button>
        <button className={mode === "html" ? "fchip active" : "fchip"} onClick={() => setMode("html")}>
          From HTML
        </button>
      </div>

      <div className="import-grid">
        <label className="field">
          <span>{mode === "url" ? "Article URL" : "Source URL (optional)"}</span>
          <input
            value={sourceUrl}
            placeholder="https://..."
            onChange={(e) => setSourceUrl(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Title (optional)</span>
          <input value={title} placeholder="Auto-detected" onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          <span>Folder</span>
          <FolderSelect folders={folders} value={folderId} onChange={setFolderId} ariaLabel="Import into folder" />
        </label>
        <label className="field">
          <span>Reference limit (optional)</span>
          <input
            type="number"
            min={1}
            value={limit}
            placeholder="All"
            onChange={(e) => setLimit(e.target.value)}
          />
        </label>
      </div>

      {mode === "html" && (
        <label className="field">
          <span>Article HTML</span>
          <textarea
            value={html}
            placeholder="Paste the page source of a logged-in article page"
            onChange={(e) => setHtml(e.target.value)}
          />
        </label>
      )}

      <div className="controls compact-controls">
        <span className="panel-note">
          The ORS bookmarklet posts to <code>/api/import/ors</code> and shows up here after a refresh.
        </span>
        <button className="primary" onClick={submit} disabled={busy || !canSubmit}>
          {busy ? "Importing..." : "Import"}
        </button>
      </div>

      {busy && (
        <div className="loading inline-loading">
          <div className="spinner" />
          <span>Fetching references and PubMed abstracts...</span>
        </div>
      )}

      {report && (
        <div className="import-report">
          {report.article && (
            <div className="import-report-row">
              <span className="pill ok">Article</span>
              <span>{documentLabel(report.article)}</span>
              <span className="panel-note">{report.article.chunkCount} paragraphs</span>
            </div>
          )}
          {report.reference && (
            <div className="import-report-row">
              <span className="pill ok">References</span>
              <span>
                {report.reference.abstractFound}/{report.reference.totalReferences} abstracts
              </span>
            </div>
          )}
          {report.articleError && <div className="warn-text">Article: {report.articleError}</div>}
          {report.referenceError && <div className="warn-text">References: {report.referenceError}</div>}
        </div>
      )}
    </section>
  );
}

function FolderNode({
  folder,
  folders,
  depth,
  counts,
  view,
  expanded,
  edit,
  draft,
  dragItem,
  dropTarget,
  onToggle,
  onSelect,
  onEdit,
  onDraft,
  onSubmitEdit,
  onDelete,
  onDragItem,
  onDropTarget,
  onDrop,
}: {
  folder: LibraryFolder;
  folders: LibraryFolder[];
  depth: number;
  counts: Map<string, number>;
  view: FolderView;
  expanded: Set<string>;
  edit: EditState | null;
  draft: string;
  dragItem: DragItem | null;
  dropTarget: string | null;
  onToggle: (id: string) => void;
  onSelect: (view: FolderView) => void;
  onEdit: (edit: EditState | null) => void;
  onDraft: (value: string) => void;
  onSubmitEdit: () => void;
  onDelete: (folder: LibraryFolder) => void;
  onDragItem: (item: DragItem | null) => void;
  onDropTarget: (id: string | null) => void;
  onDrop: (target: string | null) => void;
}) {
  const children = childFolders(folders, folder.id);
  const isOpen = expanded.has(folder.id);
  // Zoteroコレクション由来のフォルダは名前・階層がZotero側で決まる。
  // ここで編集しても次の同期で戻るだけなので、変更操作は無効にしておく。
  const fromZotero = folder.source === "zotero";
  const zoteroHint = "This folder comes from a Zotero collection. Rename or delete it in Zotero.";
  const isRenaming = edit?.mode === "rename" && edit.id === folder.id;
  const isCreatingHere = edit?.mode === "create" && edit.parentId === folder.id;
  // 自分自身や子孫の上にはドロップさせない（サーバ側でも弾くが、UI上も無効化する）。
  const canDrop =
    dragItem !== null && !(dragItem.kind === "folder" && dragItem.id === folder.id);

  return (
    <li className="folder-item">
      <div
        className={[
          "folder-row",
          view === folder.id ? "active" : "",
          dropTarget === folder.id ? "drop-target" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={{ paddingLeft: `${6 + depth * 14}px` }}
        draggable={!isRenaming && !fromZotero}
        onDragStart={() => onDragItem({ kind: "folder", id: folder.id })}
        onDragEnd={() => {
          onDragItem(null);
          onDropTarget(null);
        }}
        onDragOver={(e) => {
          if (!canDrop) return;
          e.preventDefault();
          onDropTarget(folder.id);
        }}
        onDragLeave={() => onDropTarget(null)}
        onDrop={(e) => {
          if (!canDrop) return;
          e.preventDefault();
          onDrop(folder.id);
        }}
      >
        <button
          className="folder-twisty"
          onClick={() => onToggle(folder.id)}
          disabled={!children.length}
          aria-label={isOpen ? "Collapse" : "Expand"}
        >
          {children.length ? (isOpen ? "▾" : "▸") : "·"}
        </button>

        {isRenaming ? (
          <input
            className="folder-input"
            autoFocus
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSubmitEdit();
              if (e.key === "Escape") onEdit(null);
            }}
            onBlur={onSubmitEdit}
          />
        ) : (
          <button className="folder-open" onClick={() => onSelect(folder.id)} title={folderPath(folders, folder.id)}>
            <span className="folder-name">{folder.name}</span>
            {fromZotero && (
              <span className="folder-badge" title={zoteroHint}>
                Z
              </span>
            )}
            <span className="folder-count">{counts.get(folder.id) ?? 0}</span>
          </button>
        )}

        <span className="folder-actions">
          <button
            className="icon-btn"
            title="New subfolder"
            onClick={() => {
              onDraft("");
              onEdit({ mode: "create", parentId: folder.id });
              if (!isOpen) onToggle(folder.id);
            }}
          >
            +
          </button>
          <button
            className="icon-btn"
            title={fromZotero ? zoteroHint : "Rename folder"}
            disabled={fromZotero}
            onClick={() => {
              onDraft(folder.name);
              onEdit({ mode: "rename", id: folder.id });
            }}
          >
            ✎
          </button>
          <button
            className="icon-btn"
            title={fromZotero ? zoteroHint : "Delete folder"}
            disabled={fromZotero}
            onClick={() => onDelete(folder)}
          >
            ×
          </button>
        </span>
      </div>

      {isCreatingHere && (
        <div className="folder-row" style={{ paddingLeft: `${20 + depth * 14}px` }}>
          <input
            className="folder-input"
            autoFocus
            placeholder="New folder name"
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSubmitEdit();
              if (e.key === "Escape") onEdit(null);
            }}
            onBlur={onSubmitEdit}
          />
        </div>
      )}

      {isOpen && children.length > 0 && (
        <ul className="folder-list">
          {children.map((child) => (
            <FolderNode
              key={child.id}
              folder={child}
              folders={folders}
              depth={depth + 1}
              counts={counts}
              view={view}
              expanded={expanded}
              edit={edit}
              draft={draft}
              dragItem={dragItem}
              dropTarget={dropTarget}
              onToggle={onToggle}
              onSelect={onSelect}
              onEdit={onEdit}
              onDraft={onDraft}
              onSubmitEdit={onSubmitEdit}
              onDelete={onDelete}
              onDragItem={onDragItem}
              onDropTarget={onDropTarget}
              onDrop={onDrop}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function DocumentCard({
  set,
  folders,
  folderId,
  referenceSet,
  selected,
  zoteroKey,
  zoteroAdded,
  otherFolderIds,
  onToggle,
  onAssign,
  onDragItem,
}: {
  set: ArticleSetSummary;
  folders: LibraryFolder[];
  folderId: string;
  // 置き場所以外に入っている Zotero コレクション（フォルダ単位の RAG ではそちらにも含まれる）
  otherFolderIds: string[];
  referenceSet?: ReferenceSetSummary;
  selected: boolean;
  zoteroKey?: string;
  zoteroAdded?: string;
  onToggle: () => void;
  onAssign: (folderId: string) => void;
  onDragItem: (item: DragItem | null) => void;
}) {
  return (
    <article
      className={selected ? "doc-card selected" : "doc-card"}
      draggable
      onDragStart={() => onDragItem({ kind: "document", id: set.id })}
      onDragEnd={() => onDragItem(null)}
    >
      <div className="doc-card-head">
        <input
          className="doc-select"
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`Include ${set.id} in the RAG corpus`}
        />
        <h3 className="doc-title">{documentLabel(set)}</h3>
        {zoteroKey && (
          <span className="pill zotero-pill" title={`Linked to Zotero item ${zoteroKey}`}>
            Zotero
          </span>
        )}
        {selected && <span className="pill ok">In corpus</span>}
      </div>

      <div className="doc-meta">
        <span className="doc-id">{set.id}</span>
        <span>{set.chunkCount} paragraphs</span>
        <span className={referenceSet ? "" : "warn-text"}>
          {referenceSet
            ? `${referenceSet.abstractFound}/${referenceSet.totalReferences} abstracts`
            : "No reference JSON"}
        </span>
        {zoteroAdded && <span title="Date added in Zotero">Added {formatDate(zoteroAdded)}</span>}
        {otherFolderIds.length > 0 && (
          <span title="Also in these Zotero collections; folder-scoped RAG includes it there too">
            Also in {otherFolderIds.map((id) => folderPath(folders, id)).join(", ")}
          </span>
        )}
      </div>

      {set.sourceUrl && (
        <a className="meta-doi doc-source" href={set.sourceUrl} target="_blank" rel="noreferrer">
          {set.sourceUrl}
        </a>
      )}

      <div className="doc-actions">
        <label className="ctrl">
          Folder
          <FolderSelect folders={folders} value={folderId} onChange={onAssign} ariaLabel="Move document to folder" />
        </label>
      </div>
    </article>
  );
}

export function LibraryScreen({
  articleSets,
  referenceSets,
  library,
  selectedIds,
  scope,
  scopeLabel,
  loading,
  onLibraryChange,
  onRefresh,
  onSelect,
  onClearSelection,
  onAsk,
  onAskFolder,
  onError,
}: LibraryScreenProps) {
  const [view, setView] = useState<FolderView>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [includeSubfolders, setIncludeSubfolders] = useState(true);
  const [filter, setFilter] = useState("");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [edit, setEdit] = useState<EditState | null>(null);
  const [draft, setDraft] = useState("");
  const [dragItem, setDragItem] = useState<DragItem | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const { folders, assignments } = library;
  const zoteroDates = library.zoteroDates ?? {};

  const referenceByDocument = useMemo(() => {
    const map = new Map<string, ReferenceSetSummary>();
    for (const set of articleSets) {
      const match = matchingReferenceSet(set.id, referenceSets);
      if (match) map.set(set.id, match);
    }
    return map;
  }, [articleSets, referenceSets]);

  // 各フォルダの件数は子孫を含めた合計で出す（畳んでいても中身の量が分かる）。
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const folder of folders) {
      map.set(folder.id, documentsInFolder(articleSets, library, folder.id, true).length);
    }
    return map;
  }, [articleSets, library, folders]);

  const unfiledCount = articleSets.filter((set) => !assignments[set.id]).length;

  const visibleDocuments = useMemo(() => {
    const base =
      view === "all"
        ? articleSets
        : view === "unfiled"
          ? articleSets.filter((set) => !assignments[set.id])
          : documentsInFolder(articleSets, library, view, includeSubfolders);
    const needle = filter.trim().toLowerCase();
    const filtered = needle
      ? base.filter((set) =>
          `${set.title ?? ""} ${set.id} ${set.sourceUrl ?? ""}`.toLowerCase().includes(needle),
        )
      : base;

    // Zoteroへの登録日で並べる。文字列比較だと "…+00:00" と "…Z" の混在で
    // 順序が崩れるため、必ずタイムスタンプに変換して比較する。
    const added = (id: string) => {
      const value = Date.parse(zoteroDates[id] ?? "");
      return Number.isNaN(value) ? null : value;
    };
    return [...filtered].sort((a, b) => {
      const va = added(a.id);
      const vb = added(b.id);
      // Zotero未リンクなど日付が無いものは、昇順・降順どちらでも末尾に置く。
      if (va === null && vb === null) return documentLabel(a).localeCompare(documentLabel(b));
      if (va === null) return 1;
      if (vb === null) return -1;
      if (va === vb) return documentLabel(a).localeCompare(documentLabel(b));
      return sortDir === "desc" ? vb - va : va - vb;
    });
  }, [articleSets, library, assignments, view, includeSubfolders, filter, sortDir, zoteroDates]);

  // 「Ask this folder」の対象。タイトル絞り込みは表示用なので、フォルダの中身全体を数える。
  const folderView = view !== "all" && view !== "unfiled" ? view : null;
  const folderDocuments = useMemo(
    () => (folderView ? documentsInFolder(articleSets, library, folderView, includeSubfolders) : []),
    [articleSets, library, folderView, includeSubfolders],
  );
  const isCurrentScope =
    folderView !== null && scope?.folderId === folderView && scope.includeSubfolders === includeSubfolders;

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const visibleSelected = visibleDocuments.filter((set) => selected.has(set.id)).length;
  const allVisibleSelected = visibleDocuments.length > 0 && visibleSelected === visibleDocuments.length;

  const viewTitle =
    view === "all" ? "All documents" : view === "unfiled" ? "Unfiled" : folderPath(folders, view) || "Folder";

  // Zotero同期などで表示中のフォルダが消えたら全件表示に戻す。
  useEffect(() => {
    if (view !== "all" && view !== "unfiled" && !folders.some((folder) => folder.id === view)) {
      setView("all");
    }
  }, [folders, view]);

  async function run(action: () => Promise<LibraryState>) {
    try {
      onLibraryChange(await action());
    } catch (e) {
      onError(errorMessage(e));
    }
  }

  function toggleFolder(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submitEdit() {
    const current = edit;
    const name = draft.trim();
    setEdit(null);
    setDraft("");
    if (!current || !name) return;
    if (current.mode === "create") await run(() => api.createFolder(name, current.parentId));
    else await run(() => api.renameFolder(current.id, name));
  }

  async function deleteFolder(folder: LibraryFolder) {
    const confirmed = window.confirm(
      `Delete the folder "${folder.name}"?\nSubfolders are deleted too. The documents themselves are kept and become unfiled.`,
    );
    if (!confirmed) return;
    // 消えるフォルダ（子孫を含む）を表示中なら、選択を全件に戻す。
    if (folderDescendants(folders, folder.id).has(view)) setView("all");
    await run(() => api.deleteFolder(folder.id));
  }

  // フォルダ行 / Unfiled 行へのドロップ。target が null ならルート（未分類）。
  async function handleDrop(target: string | null) {
    const item = dragItem;
    setDragItem(null);
    setDropTarget(null);
    if (!item) return;
    if (item.kind === "document") await run(() => api.assignDocument(item.id, target));
    else if (item.id !== target) await run(() => api.moveFolder(item.id, target));
  }

  async function handleImported(report: ImportReport, folderId: string) {
    await onRefresh();
    const importedId = report.article?.id;
    if (importedId && folderId) await run(() => api.assignDocument(importedId, folderId));
    if (importedId) setView(folderId || "unfiled");
  }

  return (
    <div className="library-screen">
      <div className="library-top">
        <ImportPanel folders={folders} onImported={handleImported} onError={onError} />
        <ZoteroPanel library={library} onLibraryChange={onLibraryChange} onError={onError} />
      </div>

      <div className="library-body">
        <aside className="tool-panel folder-pane">
          <div className="panel-head">
            <h2>Folders</h2>
            <button
              className="ghost"
              onClick={() => {
                setDraft("");
                setEdit({ mode: "create", parentId: null });
              }}
            >
              + Folder
            </button>
          </div>

          <ul className="folder-list">
            <li className="folder-item">
              <div className={view === "all" ? "folder-row active" : "folder-row"}>
                <span className="folder-twisty" aria-hidden="true">
                  ·
                </span>
                <button className="folder-open" onClick={() => setView("all")}>
                  <span className="folder-name">All documents</span>
                  <span className="folder-count">{articleSets.length}</span>
                </button>
              </div>
            </li>

            <li className="folder-item">
              <div
                className={[
                  "folder-row",
                  view === "unfiled" ? "active" : "",
                  dropTarget === "__root__" ? "drop-target" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                title="Drop here to remove a document from its folder, or to move a folder to the top level"
                onDragOver={(e) => {
                  if (!dragItem) return;
                  e.preventDefault();
                  setDropTarget("__root__");
                }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(e) => {
                  if (!dragItem) return;
                  e.preventDefault();
                  handleDrop(null);
                }}
              >
                <span className="folder-twisty" aria-hidden="true">
                  ·
                </span>
                <button className="folder-open" onClick={() => setView("unfiled")}>
                  <span className="folder-name">Unfiled</span>
                  <span className="folder-count">{unfiledCount}</span>
                </button>
              </div>
            </li>

            {childFolders(folders, null).map((folder) => (
              <FolderNode
                key={folder.id}
                folder={folder}
                folders={folders}
                depth={0}
                counts={counts}
                view={view}
                expanded={expanded}
                edit={edit}
                draft={draft}
                dragItem={dragItem}
                dropTarget={dropTarget}
                onToggle={toggleFolder}
                onSelect={setView}
                onEdit={setEdit}
                onDraft={setDraft}
                onSubmitEdit={submitEdit}
                onDelete={deleteFolder}
                onDragItem={setDragItem}
                onDropTarget={setDropTarget}
                onDrop={handleDrop}
              />
            ))}

            {edit?.mode === "create" && edit.parentId === null && (
              <li className="folder-item">
                <div className="folder-row" style={{ paddingLeft: "20px" }}>
                  <input
                    className="folder-input"
                    autoFocus
                    placeholder="New folder name"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitEdit();
                      if (e.key === "Escape") setEdit(null);
                    }}
                    onBlur={submitEdit}
                  />
                </div>
              </li>
            )}
          </ul>

          {!folders.length && (
            <p className="panel-note folder-hint">
              Create a folder, then drag documents onto it — or pick a folder from a card.
            </p>
          )}
        </aside>

        <section className="main-panel doc-pane">
          <div className="panel-head doc-pane-head">
            <div>
              <h2>{viewTitle}</h2>
              <span className="panel-note">{visibleDocuments.length} documents</span>
            </div>
            <div className="doc-pane-tools">
              <input
                className="doc-filter"
                value={filter}
                placeholder="Filter by title or ID"
                onChange={(e) => setFilter(e.target.value)}
              />
              {view !== "all" && view !== "unfiled" && (
                <label className="ctrl">
                  <input
                    type="checkbox"
                    checked={includeSubfolders}
                    onChange={(e) => setIncludeSubfolders(e.target.checked)}
                  />
                  Subfolders
                </label>
              )}
              <label className="ctrl">
                Zotero added
                <select
                  value={sortDir}
                  onChange={(e) => setSortDir(e.target.value as "desc" | "asc")}
                  aria-label="Sort by date added in Zotero"
                >
                  <option value="desc">Newest first</option>
                  <option value="asc">Oldest first</option>
                </select>
              </label>
              <button className="ghost" onClick={() => onRefresh().catch((e) => onError(errorMessage(e)))}>
                Refresh
              </button>
            </div>
          </div>

          <div className="corpus-bar">
            {folderView && (
              <button
                className="primary"
                onClick={() => onAskFolder({ folderId: folderView, includeSubfolders })}
                disabled={!folderDocuments.length}
                title={
                  folderDocuments.length > CORPUS_SOFT_LIMIT
                    ? `${folderDocuments.length} papers — corpus RAG is tuned for 10–${CORPUS_SOFT_LIMIT}. A subfolder may answer better.`
                    : "Search every paper in this folder; the scope follows the folder when Zotero is re-synced"
                }
              >
                Ask this folder ({folderDocuments.length}) →
              </button>
            )}
            <label className="ctrl">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                disabled={!visibleDocuments.length}
                onChange={(e) => onSelect(visibleDocuments.map((set) => set.id), e.target.checked)}
              />
              Select all {visibleDocuments.length} here
            </label>
            <span className="panel-note" title={scopeLabel}>
              {selectedIds.length
                ? `RAG: ${scope ? scopeLabel : `${selectedIds.length} selected`}${isCurrentScope ? " (this folder)" : ""}`
                : "Nothing selected for RAG"}
              {selectedIds.length > visibleSelected ? ` · ${selectedIds.length - visibleSelected} outside this view` : ""}
            </span>
            {selectedIds.length > 0 && (
              <button className="ghost" onClick={onClearSelection}>
                Clear
              </button>
            )}
            <button className={folderView ? "ghost" : "primary"} onClick={onAsk} disabled={!selectedIds.length}>
              Ask {selectedIds.length || ""} {scope ? "papers" : "selected"} →
            </button>
          </div>

          {loading && (
            <div className="loading inline-loading">
              <div className="spinner" />
              <span>{loading}</span>
            </div>
          )}

          {visibleDocuments.length ? (
            <div className="doc-grid">
              {visibleDocuments.map((set) => (
                <DocumentCard
                  key={set.id}
                  set={set}
                  folders={folders}
                  folderId={assignments[set.id] ?? ""}
                  referenceSet={referenceByDocument.get(set.id)}
                  selected={selected.has(set.id)}
                  zoteroKey={library.zoteroLinks?.[set.id]}
                  zoteroAdded={zoteroDates[set.id]}
                  otherFolderIds={documentFolderIds(library, set.id).filter((id) => id !== assignments[set.id])}
                  onToggle={() => onSelect([set.id], !selected.has(set.id))}
                  onAssign={(folderId) => run(() => api.assignDocument(set.id, folderId || null))}
                  onDragItem={setDragItem}
                />
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <h2>No documents here</h2>
              <p>
                {articleSets.length
                  ? "Nothing matches this folder or filter."
                  : "Import an article above, or run the ORS bookmarklet and refresh."}
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
