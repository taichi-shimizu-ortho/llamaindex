// 主論文JSON（ドキュメント）と参照文献JSONの対応付け、表示用の整形。
import type { ArticleSetSummary, LibraryFolder, ReferenceSetSummary } from "./types.js";

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

// 指定フォルダに属するドキュメント。includeSubfolders で子孫フォルダの分も含める。
export function documentsInFolder(
  sets: ArticleSetSummary[],
  assignments: Record<string, string>,
  folders: LibraryFolder[],
  folderId: string,
  includeSubfolders: boolean,
): ArticleSetSummary[] {
  const targets = includeSubfolders ? folderDescendants(folders, folderId) : new Set([folderId]);
  return sets.filter((set) => targets.has(assignments[set.id] ?? ""));
}
