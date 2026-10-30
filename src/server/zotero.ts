// Zotero ローカルAPI（Zotero 7）からコレクションとアイテムを読み、
// ドキュメント選択画面のフォルダ構成（library.json）へ取り込む。
//
// 前提: Zotero 7 が起動していて、設定 > 詳細 > 「他のアプリケーションがこのコンピュータ上の
// Zotero と通信することを許可」が有効になっていること。読み取り専用で、Zotero側には一切書き込まない。
// 接続先は ZOTERO_API_BASE で差し替えられる（グループライブラリや別ポート用）。
import { listArticleSets } from "./articleHarvester.js";
import { normalizeLibrary, readLibrary, writeLibrary } from "./library.js";
import type { LibraryFolder, LibraryState } from "./library.js";

const DEFAULT_BASE = "http://127.0.0.1:23119/api/users/0";
const PAGE_SIZE = 100;
const MAX_UNMATCHED_REPORTED = 50;
const PING_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 20000;
// Zoteroのコレクション由来フォルダは常にこのIDになる。再同期しても同じフォルダを指す。
const FOLDER_PREFIX = "z_";

export interface ZoteroCollection {
  key: string;
  version: number;
  name: string;
  parentKey: string | null;
}

export interface ZoteroItem {
  key: string;
  version: number;
  itemType: string;
  title: string;
  doi: string;
  pmid: string;
  citekey: string;
  year: string;
  // Zoteroにアイテムを登録した日時（ISO8601）。取り込み日でのソートに使う。
  dateAdded: string;
  collections: string[];
}

export interface ZoteroStatus {
  available: boolean;
  base: string;
  error?: string;
  collections?: number;
  items?: number;
  syncedAt?: string;
}

export interface ZoteroSyncReport {
  dryRun: boolean;
  collections: number;
  items: number;
  foldersCreated: string[];
  foldersRenamed: { from: string; to: string }[];
  foldersRemoved: string[];
  moved: { documentId: string; from: string; to: string }[];
  matched: { documentId: string; itemKey: string; via: MatchVia; folder: string }[];
  multiCollection: { documentId: string; chosen: string; others: string[] }[];
  // Zoteroにあってアプリ未取り込みの文献。実ライブラリでは数千件になりうるので先頭だけ返す。
  unmatched: { key: string; title: string; doi: string; pmid: string; year: string }[];
  unmatchedTotal: number;
  unfiledInZotero: string[];
  syncedAt: string;
}

type MatchVia = "doi" | "citekey" | "title";

function apiBase(): string {
  return (process.env.ZOTERO_API_BASE || DEFAULT_BASE).replace(/\/+$/, "");
}

function zoteroError(e: unknown): Error {
  const message = String((e as { message?: string })?.message ?? e);
  // 未起動・通信許可オフのどちらも接続拒否として出るので、UIで次の手が分かる文面にする。
  if (/ECONNREFUSED|fetch failed|AbortError|aborted|timeout/i.test(message)) {
    return new Error(
      `Zotero に接続できません（${apiBase()}）。Zotero 7 を起動し、設定 > 詳細 で ` +
        "「他のアプリケーションがこのコンピュータ上の Zotero と通信することを許可」を有効にしてください。",
    );
  }
  return new Error(message);
}

async function zoteroFetch(path: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const res = await fetch(`${apiBase()}${path}`, {
    headers: { "Zotero-API-Version": "3", Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Zotero API ${res.status} ${res.statusText} (${path})`);
  return res;
}

// limit/start でページングし、Total-Results 件そろうまで読む。
async function fetchAll(path: string): Promise<any[]> {
  const out: any[] = [];
  let start = 0;
  for (;;) {
    const separator = path.includes("?") ? "&" : "?";
    const res = await zoteroFetch(`${path}${separator}limit=${PAGE_SIZE}&start=${start}`);
    const page = (await res.json()) as any[];
    if (!Array.isArray(page)) throw new Error("Unexpected response from the Zotero API");
    out.push(...page);
    const total = Number(res.headers.get("Total-Results") ?? out.length);
    start += page.length;
    if (!page.length || out.length >= total || start >= total) break;
  }
  return out;
}

function collectionFrom(entry: any): ZoteroCollection {
  const data = entry?.data ?? entry ?? {};
  const parent = data.parentCollection;
  return {
    key: String(data.key ?? entry?.key ?? ""),
    version: Number(data.version ?? entry?.version ?? 0) || 0,
    name: String(data.name ?? "").trim(),
    // 親なしは false で返ってくる。
    parentKey: typeof parent === "string" && parent ? parent : null,
  };
}

function extraField(extra: string, label: string): string {
  const m = new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, "im").exec(extra || "");
  return m ? m[1].trim() : "";
}

function itemFrom(entry: any): ZoteroItem {
  const data = entry?.data ?? entry ?? {};
  const extra = String(data.extra ?? "");
  return {
    key: String(data.key ?? entry?.key ?? ""),
    version: Number(data.version ?? entry?.version ?? 0) || 0,
    itemType: String(data.itemType ?? ""),
    title: String(data.title ?? "").trim(),
    // DOI欄を持たないアイテムタイプでは Extra の "DOI: ..." に入る慣習。
    doi: String(data.DOI ?? "").trim() || extraField(extra, "DOI"),
    pmid: extraField(extra, "PMID"),
    // Better BibTeX が Extra に書く "Citation Key: xxx"。
    citekey: extraField(extra, "Citation Key"),
    year: String(data.date ?? "").match(/\d{4}/)?.[0] ?? "",
    dateAdded: String(data.dateAdded ?? "").trim(),
    collections: Array.isArray(data.collections) ? data.collections.map((k: unknown) => String(k)) : [],
  };
}

export async function fetchCollections(): Promise<ZoteroCollection[]> {
  const raw = await fetchAll("/collections");
  return raw.map(collectionFrom).filter((c) => c.key && c.name);
}

// トップレベルのアイテムのみ。添付ファイルとノートは文献ではないので落とす。
export async function fetchItems(): Promise<ZoteroItem[]> {
  const raw = await fetchAll("/items/top");
  return raw
    .map(itemFrom)
    .filter((item) => item.key && item.itemType !== "attachment" && item.itemType !== "note");
}

export async function zoteroStatus(): Promise<ZoteroStatus> {
  const base = apiBase();
  const syncedAt = readLibrary().zoteroSyncedAt;
  try {
    const res = await zoteroFetch("/collections?limit=1", PING_TIMEOUT_MS);
    const collections = Number(res.headers.get("Total-Results") ?? 0);
    const itemsRes = await zoteroFetch("/items/top?limit=1", PING_TIMEOUT_MS);
    const items = Number(itemsRes.headers.get("Total-Results") ?? 0);
    return { available: true, base, collections, items, syncedAt };
  } catch (e) {
    return { available: false, base, error: zoteroError(e).message, syncedAt };
  }
}

// ---- 突き合わせ ----

function normalizeDoi(value: string): string {
  return (value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
}

function normalizeTitle(value: string): string {
  return (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// 取り込み時の連番サフィックス（-2 など）を落とした基本ID。citekey との比較に使う。
function baseId(id: string): string {
  return id.replace(/-\d+$/, "");
}

interface DocumentKey {
  id: string;
  title: string;
  doi: string;
}

function matchDocument(
  item: ZoteroItem,
  byDoi: Map<string, DocumentKey>,
  byId: Map<string, DocumentKey>,
  byTitle: Map<string, DocumentKey>,
): { doc: DocumentKey; via: MatchVia } | null {
  const doi = normalizeDoi(item.doi);
  const byDoiHit = doi ? byDoi.get(doi) : undefined;
  if (byDoiHit) return { doc: byDoiHit, via: "doi" };

  // Better BibTeX の citekey は本アプリの AuthorYear 形式IDと同じ規則になりやすい。
  const citekey = item.citekey.toLowerCase();
  const byIdHit = citekey ? byId.get(citekey) : undefined;
  if (byIdHit) return { doc: byIdHit, via: "citekey" };

  const title = normalizeTitle(item.title);
  const byTitleHit = title ? byTitle.get(title) : undefined;
  if (byTitleHit) return { doc: byTitleHit, via: "title" };

  return null;
}

// コレクションツリーを「Zoteroのサイドバーに並ぶ順」（各階層を名前順にした深さ優先）で辿り、
// 1アイテムが複数コレクションに属するときは、この順で最初＝一番上のものを採用する。
// 配列の並び順に依存しないので、同期のたびに所属が揺れることがない。
function treeOrder(collections: ZoteroCollection[]): Map<string, number> {
  const children = new Map<string | null, ZoteroCollection[]>();
  for (const collection of collections) {
    const parent = collection.parentKey && collections.some((c) => c.key === collection.parentKey)
      ? collection.parentKey
      : null;
    const list = children.get(parent) ?? [];
    list.push({ ...collection, parentKey: parent });
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.name.localeCompare(b.name));

  const order = new Map<string, number>();
  let index = 0;
  const walk = (parent: string | null) => {
    for (const collection of children.get(parent) ?? []) {
      if (order.has(collection.key)) continue;
      order.set(collection.key, index++);
      walk(collection.key);
    }
  };
  walk(null);
  // 親が辿れず孤立したものも末尾で拾う。
  for (const collection of collections) if (!order.has(collection.key)) order.set(collection.key, index++);
  return order;
}

function folderIdFor(key: string): string {
  return `${FOLDER_PREFIX}${key}`;
}

// ---- 同期本体 ----

export function planSync(
  current: LibraryState,
  collections: ZoteroCollection[],
  items: ZoteroItem[],
  documents: DocumentKey[],
): { next: LibraryState; report: ZoteroSyncReport } {
  const syncedAt = new Date().toISOString();
  const report: ZoteroSyncReport = {
    dryRun: false,
    collections: collections.length,
    items: items.length,
    foldersCreated: [],
    foldersRenamed: [],
    foldersRemoved: [],
    moved: [],
    matched: [],
    multiCollection: [],
    unmatched: [],
    unmatchedTotal: 0,
    unfiledInZotero: [],
    syncedAt,
  };

  // --- フォルダ: Zotero由来だけ作り直し、手動フォルダはそのまま残す ---
  const previousById = new Map(current.folders.map((folder) => [folder.id, folder]));
  const manualFolders = current.folders.filter((folder) => folder.source !== "zotero");
  const keptKeys = new Set(collections.map((c) => c.key));

  const zoteroFolders: LibraryFolder[] = collections.map((collection) => {
    const id = folderIdFor(collection.key);
    const previous = previousById.get(id);
    if (!previous) report.foldersCreated.push(collection.name);
    else if (previous.name !== collection.name) {
      report.foldersRenamed.push({ from: previous.name, to: collection.name });
    }
    return {
      id,
      name: collection.name,
      parentId: collection.parentKey && keptKeys.has(collection.parentKey) ? folderIdFor(collection.parentKey) : null,
      createdAt: previous?.createdAt ?? syncedAt,
      source: "zotero",
      zoteroKey: collection.key,
      zoteroVersion: collection.version,
    };
  });

  for (const folder of current.folders) {
    if (folder.source === "zotero" && !zoteroFolders.some((f) => f.id === folder.id)) {
      report.foldersRemoved.push(folder.name);
    }
  }

  const nextFolders = [...manualFolders, ...zoteroFolders];
  const folderNames = new Map(nextFolders.map((folder) => [folder.id, folder.name]));
  const liveFolderIds = new Set(nextFolders.map((folder) => folder.id));
  // 移動前の所属は同期前の状態で表示する（同じ同期で消えたフォルダ名もそのまま出す）。
  const previousAssignments = { ...current.assignments };
  const previousNames = new Map(current.folders.map((folder) => [folder.id, folder.name]));
  const previousFolderLabel = (docId: string): string => {
    const folderId = previousAssignments[docId];
    return folderId ? previousNames.get(folderId) ?? folderId : "Unfiled";
  };

  // --- 振り分け ---
  const assignments: Record<string, string> = {};
  // 消えたZoteroフォルダを指していた振り分けは落ちる（＝その文献は未分類に戻る）。
  for (const [docId, folderId] of Object.entries(current.assignments)) {
    if (liveFolderIds.has(folderId)) assignments[docId] = folderId;
  }

  const byDoi = new Map<string, DocumentKey>();
  const byId = new Map<string, DocumentKey>();
  const byTitle = new Map<string, DocumentKey>();
  for (const doc of documents) {
    const doi = normalizeDoi(doc.doi);
    if (doi && !byDoi.has(doi)) byDoi.set(doi, doc);
    byId.set(doc.id.toLowerCase(), doc);
    const base = baseId(doc.id).toLowerCase();
    if (!byId.has(base)) byId.set(base, doc);
    const title = normalizeTitle(doc.title);
    if (title && !byTitle.has(title)) byTitle.set(title, doc);
  }

  const order = treeOrder(collections);
  const zoteroLinks: Record<string, string> = {};
  const zoteroDates: Record<string, string> = {};

  for (const item of items) {
    const match = matchDocument(item, byDoi, byId, byTitle);
    if (!match) {
      report.unmatchedTotal += 1;
      if (report.unmatched.length < MAX_UNMATCHED_REPORTED) {
        report.unmatched.push({
          key: item.key,
          title: item.title,
          doi: item.doi,
          pmid: item.pmid,
          year: item.year,
        });
      }
      continue;
    }

    zoteroLinks[match.doc.id] = item.key;
    if (item.dateAdded) zoteroDates[match.doc.id] = item.dateAdded;

    const known = item.collections.filter((key) => keptKeys.has(key));
    if (!known.length) {
      // Zotero側で未分類のアイテムは、こちらの振り分けを壊さずそのまま残す。
      report.unfiledInZotero.push(match.doc.id);
      continue;
    }

    const chosen = known.slice().sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))[0];
    const targetId = folderIdFor(chosen);
    if (previousAssignments[match.doc.id] !== targetId) {
      report.moved.push({
        documentId: match.doc.id,
        from: previousFolderLabel(match.doc.id),
        to: folderNames.get(targetId) ?? targetId,
      });
    }
    assignments[match.doc.id] = targetId;
    report.matched.push({
      documentId: match.doc.id,
      itemKey: item.key,
      via: match.via,
      folder: folderNames.get(targetId) ?? targetId,
    });

    if (known.length > 1) {
      report.multiCollection.push({
        documentId: match.doc.id,
        chosen: folderNames.get(targetId) ?? targetId,
        others: known
          .filter((key) => key !== chosen)
          .map((key) => folderNames.get(folderIdFor(key)) ?? key),
      });
    }
  }

  const next = normalizeLibrary({
    folders: nextFolders,
    assignments,
    // Zoteroから消えたアイテムの目印は残さない。
    zoteroLinks,
    zoteroDates,
    zoteroSyncedAt: syncedAt,
  });

  return { next, report };
}

export async function syncZotero(options?: { dryRun?: boolean }): Promise<{
  library: LibraryState;
  report: ZoteroSyncReport;
}> {
  const dryRun = Boolean(options?.dryRun);
  let collections: ZoteroCollection[];
  let items: ZoteroItem[];
  try {
    collections = await fetchCollections();
    items = await fetchItems();
  } catch (e) {
    throw zoteroError(e);
  }

  const documents: DocumentKey[] = listArticleSets().map((set) => ({
    id: set.id,
    title: set.title ?? "",
    doi: set.doi ?? "",
  }));

  const current = readLibrary();
  const { next, report } = planSync(current, collections, items, documents);
  report.dryRun = dryRun;

  // dryRun のときは書かずに「こうなる」という結果だけ返す。
  return { library: dryRun ? current : writeLibrary(next), report };
}
