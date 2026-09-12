// ドキュメント選択画面のフォルダ構成を JSON ファイルに永続化する。
// フォルダはネスト可能で、文献（article set）は最大1つのフォルダに所属する。
// 文献JSON本体には触れないため、フォルダを消しても文献は消えない。
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./config.js";

export interface LibraryFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  // Zoteroコレクション由来のフォルダは source="zotero"。手動作成分は undefined。
  source?: "zotero";
  zoteroKey?: string;
  zoteroVersion?: number;
}

export interface LibraryState {
  folders: LibraryFolder[];
  // documentId（article set の id） -> folderId
  assignments: Record<string, string>;
  // documentId -> Zoteroアイテムkey（同期で対応付いた文献の目印）
  zoteroLinks?: Record<string, string>;
  zoteroSyncedAt?: string;
}

const MAX_NAME_LENGTH = 80;

function emptyLibrary(): LibraryState {
  return { folders: [], assignments: {} };
}

function newFolderId(): string {
  return `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function folderName(value: unknown): string {
  const name = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  if (!name) throw new Error("Enter a folder name");
  return name;
}

function documentId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!id) throw new Error("Specify a document");
  return id;
}

// 壊れた JSON / 手編集にも耐えるように、読み込み時に構造を整える。
// 存在しない親や循環参照はルート直下に戻し、消えたフォルダへの振り分けは解除する。
export function normalizeLibrary(raw: unknown): LibraryState {
  const source = (raw ?? {}) as Partial<LibraryState>;
  const folders: LibraryFolder[] = [];
  const seen = new Set<string>();

  for (const entry of Array.isArray(source.folders) ? source.folders : []) {
    const id = String((entry as LibraryFolder)?.id ?? "").trim();
    const name = String((entry as LibraryFolder)?.name ?? "").trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const data = entry as LibraryFolder;
    const version = Number(data?.zoteroVersion);
    folders.push({
      id,
      name: name.slice(0, MAX_NAME_LENGTH),
      parentId: String(data?.parentId ?? "") || null,
      createdAt: String(data?.createdAt ?? "") || new Date().toISOString(),
      ...(data?.source === "zotero" ? { source: "zotero" as const } : {}),
      ...(data?.zoteroKey ? { zoteroKey: String(data.zoteroKey) } : {}),
      ...(Number.isFinite(version) ? { zoteroVersion: version } : {}),
    });
  }

  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  for (const folder of folders) {
    if (folder.parentId && !byId.has(folder.parentId)) folder.parentId = null;
  }
  for (const folder of folders) {
    // 親をたどって自分に戻ってきたら循環しているのでルート直下に戻す。
    const visited = new Set<string>([folder.id]);
    let parent = folder.parentId ? byId.get(folder.parentId) : undefined;
    while (parent) {
      if (visited.has(parent.id)) {
        folder.parentId = null;
        break;
      }
      visited.add(parent.id);
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
  }

  const assignments: Record<string, string> = {};
  const rawAssignments = (source.assignments ?? {}) as Record<string, unknown>;
  for (const [docId, folderId] of Object.entries(rawAssignments)) {
    const id = String(folderId ?? "");
    if (docId && byId.has(id)) assignments[docId] = id;
  }

  const zoteroLinks: Record<string, string> = {};
  const rawLinks = (source.zoteroLinks ?? {}) as Record<string, unknown>;
  for (const [docId, itemKey] of Object.entries(rawLinks)) {
    const key = String(itemKey ?? "").trim();
    if (docId && key) zoteroLinks[docId] = key;
  }

  const state: LibraryState = { folders, assignments };
  if (Object.keys(zoteroLinks).length) state.zoteroLinks = zoteroLinks;
  if (source.zoteroSyncedAt) state.zoteroSyncedAt = String(source.zoteroSyncedAt);
  return state;
}

export function readLibrary(): LibraryState {
  try {
    return normalizeLibrary(JSON.parse(fs.readFileSync(PATHS.libraryFile, "utf-8")));
  } catch {
    return emptyLibrary();
  }
}

export function writeLibrary(state: LibraryState): LibraryState {
  fs.mkdirSync(path.dirname(PATHS.libraryFile), { recursive: true });
  fs.writeFileSync(PATHS.libraryFile, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  return state;
}

function requireFolder(state: LibraryState, id: string): LibraryFolder {
  const folder = state.folders.find((f) => f.id === id);
  if (!folder) throw new Error("Folder not found");
  return folder;
}

// parentId として受け取った値を検証する。空文字 / null / undefined はルート直下。
function resolveParentId(state: LibraryState, value: unknown): string | null {
  const id = String(value ?? "").trim();
  if (!id) return null;
  requireFolder(state, id);
  return id;
}

function descendantIds(state: LibraryState, rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  let added = true;
  while (added) {
    added = false;
    for (const folder of state.folders) {
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id);
        added = true;
      }
    }
  }
  return ids;
}

export function createFolder(name: unknown, parentId: unknown): LibraryState {
  const state = readLibrary();
  const folder: LibraryFolder = {
    id: newFolderId(),
    name: folderName(name),
    parentId: resolveParentId(state, parentId),
    createdAt: new Date().toISOString(),
  };
  state.folders.push(folder);
  return writeLibrary(state);
}

export function renameFolder(id: unknown, name: unknown): LibraryState {
  const state = readLibrary();
  requireFolder(state, String(id ?? "")).name = folderName(name);
  return writeLibrary(state);
}

export function moveFolder(id: unknown, parentId: unknown): LibraryState {
  const state = readLibrary();
  const folder = requireFolder(state, String(id ?? ""));
  const nextParentId = resolveParentId(state, parentId);
  // 自分自身や子孫の下には入れられない（循環防止）。
  if (nextParentId && descendantIds(state, folder.id).has(nextParentId)) {
    throw new Error("Cannot move a folder into itself");
  }
  folder.parentId = nextParentId;
  return writeLibrary(state);
}

// フォルダとその子孫を削除する。中の文献は未分類に戻るだけで、JSON は消さない。
export function deleteFolder(id: unknown): LibraryState {
  const state = readLibrary();
  const target = requireFolder(state, String(id ?? ""));
  const removed = descendantIds(state, target.id);
  state.folders = state.folders.filter((folder) => !removed.has(folder.id));
  for (const [docId, folderId] of Object.entries(state.assignments)) {
    if (removed.has(folderId)) delete state.assignments[docId];
  }
  return writeLibrary(state);
}

// folderId が空なら未分類に戻す。
export function assignDocument(docId: unknown, folderId: unknown): LibraryState {
  const state = readLibrary();
  const id = documentId(docId);
  const target = resolveParentId(state, folderId);
  if (target) state.assignments[id] = target;
  else delete state.assignments[id];
  return writeLibrary(state);
}
