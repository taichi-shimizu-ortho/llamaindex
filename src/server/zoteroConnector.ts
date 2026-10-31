// Zotero への書き込み（CLI の取り込み用）。Zotero 7 のコネクタサーバ（ブラウザ拡張と同じ口）を使う。
// Web アプリ側のコレクション同期（zotero.ts）は読み取り専用のまま。ここだけが Zotero に書く。
//
// 流れ: DOI を doi.org で引いて（CSL JSON）Zotero のアイテムに直す → /connector/saveItems で保存
// （Zotero で今選んでいるコレクションに入る）→ /connector/updateSession で指定コレクションへ移す。
// 前提は zotero.ts と同じ（Zotero 7 起動中・「他のアプリケーションと通信を許可」が有効）。
import crypto from "node:crypto";

const DEFAULT_CONNECTOR = "http://127.0.0.1:23119/connector";
const REQUEST_TIMEOUT_MS = 20000;

export interface ConnectorTarget {
  // "L1"（ライブラリ）や "C3"（コレクション）
  id: string;
  name: string;
  level: number;
}

function connectorBase(): string {
  return (process.env.ZOTERO_CONNECTOR_BASE || DEFAULT_CONNECTOR).replace(/\/+$/, "");
}

async function connectorPost(endpoint: string, body: unknown): Promise<Response> {
  const res = await fetch(`${connectorBase()}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Zotero connector ${endpoint}: ${res.status} ${await res.text()}`);
  return res;
}

// 保存先に選べるライブラリとコレクションの一覧（Zotero のサイドバー順）。
export async function listTargets(): Promise<ConnectorTarget[]> {
  const data = (await (await connectorPost("getSelectedCollection", {})).json()) as { targets?: any[] };
  return (data.targets ?? []).map((t) => ({ id: String(t.id), name: String(t.name), level: Number(t.level) || 0 }));
}

// コレクション名（大文字小文字は無視）から保存先を決める。同名が複数あれば "親/子" で指定させる。
export function resolveTarget(targets: ConnectorTarget[], wanted: string): ConnectorTarget {
  const pathOf = new Map<string, string>();
  const stack: string[] = [];
  for (const t of targets) {
    if (t.level === 0) continue;
    stack.length = t.level - 1;
    stack.push(t.name);
    pathOf.set(t.id, stack.join("/"));
  }
  const key = wanted.trim().toLowerCase();
  const hits = targets.filter(
    (t) => t.level > 0 && (t.name.toLowerCase() === key || pathOf.get(t.id)?.toLowerCase() === key),
  );
  if (hits.length === 1) return hits[0];
  const names = targets.filter((t) => t.level > 0).map((t) => pathOf.get(t.id));
  if (!hits.length) throw new Error(`Zotero collection "${wanted}" not found. Available: ${names.join(", ")}`);
  throw new Error(`Zotero collection "${wanted}" is ambiguous: ${hits.map((t) => pathOf.get(t.id)).join(", ")}`);
}

// Crossref の abstract は JATS（<jats:title>Background:</jats:title><jats:p>…）なので平文に戻す。
function plainAbstract(value: string): string {
  return value
    .replace(/<\/jats:title>\s*/g, " ")
    .replace(/<\/jats:(p|sec)>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function first(value: unknown): string {
  return String((Array.isArray(value) ? value[0] : value) ?? "").trim();
}

function cslDate(csl: any): string {
  const parts: number[] = (csl.issued ?? csl["published-online"] ?? csl["published-print"])?.["date-parts"]?.[0] ?? [];
  return parts.map((n, i) => (i === 0 ? String(n) : String(n).padStart(2, "0"))).join("-");
}

const ITEM_TYPES: Record<string, string> = {
  "journal-article": "journalArticle",
  "book-chapter": "bookSection",
  "proceedings-article": "conferencePaper",
  "posted-content": "preprint",
  book: "book",
};

// doi.org の CSL JSON を Zotero のアイテム（コネクタの saveItems 形式）にする。
export async function itemFromDoi(doi: string): Promise<Record<string, unknown>> {
  const res = await fetch(`https://doi.org/${encodeURI(doi)}`, {
    headers: { Accept: "application/vnd.citationstyles.csl+json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`doi.org ${res.status} for ${doi}`);
  const csl = (await res.json()) as any;
  const creators = (csl.author ?? []).map((a: any) =>
    a.family ? { firstName: a.given ?? "", lastName: a.family, creatorType: "author" } : { name: a.literal ?? a.name ?? "", creatorType: "author" },
  );
  return {
    itemType: ITEM_TYPES[csl.type] ?? "journalArticle",
    title: first(csl.title),
    creators,
    date: cslDate(csl),
    publicationTitle: first(csl["container-title"]),
    journalAbbreviation: first(csl["container-title-short"]),
    volume: String(csl.volume ?? ""),
    issue: String(csl.issue ?? ""),
    pages: String(csl.page ?? ""),
    DOI: csl.DOI ?? doi,
    ISSN: (csl.ISSN ?? []).join(", "),
    url: csl.resource?.primary?.URL ?? `https://doi.org/${doi}`,
    abstractNote: csl.abstract ? plainAbstract(csl.abstract) : "",
    language: csl.language ?? "",
    libraryCatalog: "DOI.org (Crossref)",
    accessDate: new Date().toISOString().replace("T", " ").slice(0, 19),
    attachments: [],
  };
}

// アイテムを保存して target（"C3" など）へ移す。
export async function saveItemToCollection(item: Record<string, unknown>, target: ConnectorTarget, uri: string) {
  const sessionID = crypto.randomUUID();
  await connectorPost("saveItems", { sessionID, uri, items: [{ ...item, id: sessionID }] });
  await connectorPost("updateSession", { sessionID, target: target.id });
}
