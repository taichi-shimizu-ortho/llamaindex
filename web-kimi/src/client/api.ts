// サーバAPIの薄いラッパ。エラーはすべて Error として投げ直す。
import type {
  ArticleSet,
  ArticleSetSummary,
  ImportReport,
  LibraryState,
  ReferenceSet,
  ReferenceSetSummary,
  Status,
  ZoteroStatus,
  ZoteroSyncReport,
} from "./types.js";

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed: ${url}`);
  return data as T;
}

function postJson<T>(url: string, body: unknown): Promise<T> {
  return requestJson<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export interface ImportRequest {
  sourceUrl?: string;
  html?: string;
  title?: string;
  limit?: number;
}

export const api = {
  status: () => requestJson<Status>("/api/status"),

  articleSets: () => requestJson<{ sets: ArticleSetSummary[] }>("/api/article/sets").then((d) => d.sets ?? []),
  articleSet: (id: string) => requestJson<ArticleSet>(`/api/article/sets/${encodeURIComponent(id)}`),

  referenceSets: () => requestJson<{ sets: ReferenceSetSummary[] }>("/api/reference/sets").then((d) => d.sets ?? []),
  referenceSet: (id: string) => requestJson<ReferenceSet>(`/api/reference/sets/${encodeURIComponent(id)}`),

  importDocument: (body: ImportRequest) => postJson<ImportReport>("/api/import/ors", body),

  library: () => requestJson<{ library: LibraryState }>("/api/library").then((d) => d.library),
  createFolder: (name: string, parentId: string | null) =>
    postJson<{ library: LibraryState }>("/api/library/folders/create", { name, parentId }).then((d) => d.library),
  renameFolder: (id: string, name: string) =>
    postJson<{ library: LibraryState }>("/api/library/folders/rename", { id, name }).then((d) => d.library),
  moveFolder: (id: string, parentId: string | null) =>
    postJson<{ library: LibraryState }>("/api/library/folders/move", { id, parentId }).then((d) => d.library),
  deleteFolder: (id: string) =>
    postJson<{ library: LibraryState }>("/api/library/folders/delete", { id }).then((d) => d.library),
  assignDocument: (documentId: string, folderId: string | null) =>
    postJson<{ library: LibraryState }>("/api/library/assign", { documentId, folderId }).then((d) => d.library),

  zoteroStatus: () => requestJson<ZoteroStatus>("/api/zotero/status"),
  // dryRun=true なら library.json は書かれず、同期結果の見込みだけ返る。
  zoteroSync: (dryRun: boolean) =>
    postJson<{ library: LibraryState; report: ZoteroSyncReport }>("/api/zotero/sync", { dryRun }),

  saveSession: (sessionId: string, result: unknown) =>
    postJson<{ file?: string }>("/api/session/save", { sessionId, result }),
};

export function errorMessage(e: unknown): string {
  return String((e as { message?: string })?.message ?? e);
}
