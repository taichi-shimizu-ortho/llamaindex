// 主論文JSON（ドキュメント）と参照文献JSONの対応付け、表示用の整形。
import type { ArticleSetSummary, LibraryFolder, LibraryState, ReferenceSetSummary } from "./types.js";

// 取り込み時に付く連番サフィックス（-2 など）を落として同一論文を突き合わせる。
export function datasetBaseId(id: string): string {
  return id.replace(/-\d+$/, "");
}

export function matchingReferenceSet(
  articleId: string,
  summaries: ReferenceSetSummary[],
): ReferenceSetSummary | undefined {
  const baseId = datasetBaseId(articleId);
  return summaries
    .filter((set) => datasetBaseId(set.id) === baseId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export function documentLabel(set: { title?: string; id: string }): string {
  return set.title?.trim() || set.id;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
}

// ---- フォルダツリー ----

export function childFolders(folders: LibraryFolder[], parentId: string | null): LibraryFolder[] {
  return folders
    .filter((folder) => (folder.parentId ?? null) === parentId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function folderDescendants(folders: LibraryFolder[], rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  let added = true;
  while (added) {
    added = false;
    for (const folder of folders) {
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id);
        added = true;
      }
    }
  }
  return ids;
}

export function folderPath(folders: LibraryFolder[], id: string): string {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const names: string[] = [];
  let current = byId.get(id);
  const guard = new Set<string>();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    names.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return names.join(" / ");
}

// フォルダ選択セレクト用に、ツリーを深さ付きの一次元配列へ展開する。
export function flattenFolders(
  folders: LibraryFolder[],
  parentId: string | null = null,
  depth = 0,
): { folder: LibraryFolder; depth: number }[] {
  return childFolders(folders, parentId).flatMap((folder) => [
    { folder, depth },
    ...flattenFolders(folders, folder.id, depth + 1),
  ]);
}

// 文献が入っているフォルダすべて。置き場所（assignments）に加え、Zotero で複数コレクションに
// 入っている文献はそのすべてに属するものとして扱う（Zotero のサイドバーと同じ見え方にする）。
export function documentFolderIds(library: LibraryState, documentId: string): string[] {
  const ids = new Set(library.zoteroFolders?.[documentId] ?? []);
  const primary = library.assignments[documentId];
  if (primary) ids.add(primary);
  return [...ids];
}

// 指定フォルダに属するドキュメント。includeSubfolders で子孫フォルダの分も含める。
export function documentsInFolder(
  sets: ArticleSetSummary[],
  library: LibraryState,
  folderId: string,
  includeSubfolders: boolean,
): ArticleSetSummary[] {
  const targets = includeSubfolders ? folderDescendants(library.folders, folderId) : new Set([folderId]);
  return sets.filter((set) => documentFolderIds(library, set.id).some((id) => targets.has(id)));
}

// RAG 画面・保存する md に出すスコープ名。
export function scopeLabel(folders: LibraryFolder[], folderId: string, includeSubfolders: boolean): string {
  const path = folderPath(folders, folderId) || folderId;
  const hasChildren = folders.some((folder) => folder.parentId === folderId);
  return `Folder: ${path}${includeSubfolders && hasChildren ? " (with subfolders)" : ""}`;
}
