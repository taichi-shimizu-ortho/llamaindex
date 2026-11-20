// CLI 取り込み（npm run ingest / ingest:offline）で共有するファイル操作と Zotero 登録。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchCollections, fetchItems, normalizeDoi } from "../../src/server/zotero.js";
import type { ZoteroItem } from "../../src/server/zotero.js";
import { itemFromDoi, listTargets, resolveTarget, saveItemToCollection } from "../../src/server/zoteroConnector.js";
import type { ConnectorTarget } from "../../src/server/zoteroConnector.js";

// MHTML を落とす場所。Dropbox の「デスクトップとダウンロード」同期を使っている Mac では
// ~/Library/CloudStorage/Dropbox/Mac (2)/Downloads が実体になる。INGEST_DOWNLOADS_DIR で差し替え可。
export function downloadsDir(): string {
  if (process.env.INGEST_DOWNLOADS_DIR) return process.env.INGEST_DOWNLOADS_DIR;
  const home = os.homedir();
  const candidates = [path.join(home, "Library", "CloudStorage", "Dropbox", "Mac (2)", "Downloads"), path.join(home, "Downloads")];
  return candidates.find((dir) => fs.existsSync(dir)) ?? candidates[candidates.length - 1];
}

// ~/Dropbox は ~/Library/CloudStorage/Dropbox へのシンボリックリンクなので、パス文字列ではなく実体で比べる
export function isSameFile(a: string, b: string): boolean {
  if (!fs.existsSync(b)) return false;
  return fs.realpathSync(a) === fs.realpathSync(b);
}

export function isInside(file: string, dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  const rel = path.relative(fs.realpathSync(dir), fs.realpathSync(file));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// 移動は rename、別ボリューム（Dropbox ↔ ローカル）なら copy + unlink にする。
export function moveFile(from: string, to: string) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (e: any) {
    if (e?.code !== "EXDEV") throw e;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

export interface ZoteroContext {
  target: ConnectorTarget;
  collectionKey: string;
  collectionNames: Map<string, string>;
  items: ZoteroItem[];
}

export async function zoteroContext(collection: string): Promise<ZoteroContext> {
  const target = resolveTarget(await listTargets(), collection);
  const collections = await fetchCollections();
  // コネクタの target（C3 など）と Web API のコレクション key は別物なので、名前で対応させる
  const match = collections.filter((c) => c.name === target.name);
  return {
    target,
    collectionKey: match.length === 1 ? match[0].key : "",
    collectionNames: new Map(collections.map((c) => [c.key, c.name])),
    items: await fetchItems(),
  };
}

function findByDoi(items: ZoteroItem[], doi: string): ZoteroItem | undefined {
  return items.find((item) => normalizeDoi(item.doi) === doi);
}

// 保存直後はローカルAPIに出てくるまで少し掛かることがある
async function waitForItem(doi: string): Promise<ZoteroItem | undefined> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const item = findByDoi(await fetchItems(), doi);
    if (item) return item;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return undefined;
}

// DOI で Zotero に登録して指定コレクションへ入れる。同じ DOI が既にあれば登録しない。
export async function addToZotero(doi: string, sourceUrl: string, ctx: ZoteroContext, dryRun: boolean) {
  doi = normalizeDoi(doi);
  const existing = findByDoi(ctx.items, doi);
  if (existing) {
    const names = existing.collections.map((key) => ctx.collectionNames.get(key) ?? key);
    console.log(`  Zotero: already in library (${existing.key}; ${names.join(", ") || "no collection"})`);
    if (ctx.collectionKey && !existing.collections.includes(ctx.collectionKey)) {
      console.log(`  Zotero: ⚠ not in "${ctx.target.name}". Add it to the collection in Zotero by hand (the connector cannot edit existing items).`);
    }
    return;
  }
  const item = await itemFromDoi(doi);
  if (dryRun) {
    console.log(`  Zotero: would add "${item.title}" to "${ctx.target.name}"`);
    return;
  }
  await saveItemToCollection(item, ctx.target, sourceUrl);
  const saved = await waitForItem(doi);
  if (!saved) {
    console.log("  Zotero: ⚠ saved, but the item is not visible in the local API yet. Check Zotero.");
    return;
  }
  ctx.items.push(saved);
  const inTarget = !ctx.collectionKey || saved.collections.includes(ctx.collectionKey);
  console.log(`  Zotero: added ${saved.key} to "${ctx.target.name}"${inTarget ? "" : " ⚠ but it is not in that collection — check Zotero"}`);
}
