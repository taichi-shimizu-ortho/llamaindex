// ドキュメント選択・取り込み画面。
// 取り込んだ主論文JSONをフォルダに整理し、RAG画面へ渡す文献を選ぶ。
import { useMemo, useState } from "react";
import { api, errorMessage } from "./api.js";
import type { ImportRequest } from "./api.js";
import {
  childFolders,
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
  ImportReport,
  LibraryFolder,
  LibraryState,
  ReferenceSetSummary,
} from "./types.js";

// 左ペインで選択中の絞り込み。フォルダIDそのものも入る。
type FolderView = "all" | "unfiled" | string;

type DragItem = { kind: "document" | "folder"; id: string };

type EditState = { mode: "create"; parentId: string | null } | { mode: "rename"; id: string };

interface LibraryScreenProps {
  articleSets: ArticleSetSummary[];
  referenceSets: ReferenceSetSummary[];
  library: LibraryState;
  selectedDocumentId: string;
  loading: string;
  onLibraryChange: (next: LibraryState) => void;
  onRefresh: () => Promise<void>;
  onOpenDocument: (id: string) => void;
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
        draggable={!isRenaming}
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
            title="Rename folder"
            onClick={() => {
              onDraft(folder.name);
              onEdit({ mode: "rename", id: folder.id });
            }}
          >
            ✎
          </button>
          <button className="icon-btn" title="Delete folder" onClick={() => onDelete(folder)}>
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
  onOpen,
  onAssign,
  onDragItem,
}: {
  set: ArticleSetSummary;
  folders: LibraryFolder[];
  folderId: string;
  referenceSet?: ReferenceSetSummary;
  selected: boolean;
  onOpen: () => void;
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
        <h3 className="doc-title">{documentLabel(set)}</h3>
        {selected && <span className="pill ok">In RAG</span>}
      </div>

      <div className="doc-meta">
        <span className="doc-id">{set.id}</span>
        <span>{set.chunkCount} paragraphs</span>
        <span className={referenceSet ? "" : "warn-text"}>
          {referenceSet
            ? `${referenceSet.abstractFound}/${referenceSet.totalReferences} abstracts`
            : "No reference JSON"}
        </span>
        <span>{formatDate(set.createdAt)}</span>
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
        <button className="primary" onClick={onOpen}>
          Open in RAG
        </button>
      </div>
    </article>
  );
}

export function LibraryScreen({
  articleSets,
  referenceSets,
  library,
  selectedDocumentId,
  loading,
  onLibraryChange,
  onRefresh,
  onOpenDocument,
  onError,
}: LibraryScreenProps) {
  const [view, setView] = useState<FolderView>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [includeSubfolders, setIncludeSubfolders] = useState(true);
  const [filter, setFilter] = useState("");
  const [edit, setEdit] = useState<EditState | null>(null);
  const [draft, setDraft] = useState("");
  const [dragItem, setDragItem] = useState<DragItem | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const { folders, assignments } = library;

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
      map.set(folder.id, documentsInFolder(articleSets, assignments, folders, folder.id, true).length);
    }
    return map;
  }, [articleSets, assignments, folders]);

  const unfiledCount = articleSets.filter((set) => !assignments[set.id]).length;

  const visibleDocuments = useMemo(() => {
    const base =
      view === "all"
        ? articleSets
        : view === "unfiled"
          ? articleSets.filter((set) => !assignments[set.id])
          : documentsInFolder(articleSets, assignments, folders, view, includeSubfolders);
    const needle = filter.trim().toLowerCase();
    if (!needle) return base;
    return base.filter((set) =>
      `${set.title ?? ""} ${set.id} ${set.sourceUrl ?? ""}`.toLowerCase().includes(needle),
    );
  }, [articleSets, assignments, folders, view, includeSubfolders, filter]);

  const viewTitle =
    view === "all" ? "All documents" : view === "unfiled" ? "Unfiled" : folderPath(folders, view) || "Folder";

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
      <ImportPanel folders={folders} onImported={handleImported} onError={onError} />

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
              <button className="ghost" onClick={() => onRefresh().catch((e) => onError(errorMessage(e)))}>
                Refresh
              </button>
            </div>
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
                  selected={set.id === selectedDocumentId}
                  onOpen={() => onOpenDocument(set.id)}
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
