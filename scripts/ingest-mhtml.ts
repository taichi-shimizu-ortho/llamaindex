// 出版社サイトから保存した MHTML を1本ずつ取り込む CLI。
//
//   npm run ingest -- -c general                     # Downloads の最新 MHTML を general へ
//   npm run ingest -- -c general --doi 10.1177/...   # DOI を明示（MHTML 内の DOI と照合する）
//   npm run ingest -- -c general --all               # Downloads の MHTML をすべて
//   npm run ingest -- -c general path/to/a.mhtml     # ファイルを指定
//   npm run ingest -- -c general --dry-run           # 何も書かずに内容と行き先だけ確認
//
// 1本ごとに:
//   1. MHTML を読み、DOI と元URLを取る（--doi があれば照合）
//   2. Downloads から <データ>/mhtml/<DOI>.mhtml へ移す（原本として保持）
//   3. Zotero に DOI で登録して指定コレクションへ入れる（既にあれば登録しない）
//   4. 主論文JSON・参考文献JSONを作り、PubMed で Original / Review に分類する
// 最後に Zotero のコレクション構成をフォルダへ同期する（Web UI の Sync collections → Apply と同じ）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PATHS } from "../src/server/config.js";
import { readMhtml } from "../src/server/mhtml.js";
import { articleSetPath, harvestArticle, inferMeta, loadArticleSet } from "../src/server/articleHarvester.js";
import { harvestReferences } from "../src/server/referenceHarvester.js";
import { classifyArticle } from "../src/server/articleClassifier.js";
import { fetchCollections, fetchItems, normalizeDoi, syncZotero } from "../src/server/zotero.js";
import type { ZoteroItem } from "../src/server/zotero.js";
import { itemFromDoi, listTargets, resolveTarget, saveItemToCollection } from "../src/server/zoteroConnector.js";
import type { ConnectorTarget } from "../src/server/zoteroConnector.js";

interface Options {
  collection: string;
  doi: string;
  all: boolean;
  dryRun: boolean;
  zotero: boolean;
  files: string[];
}

const USAGE = "Usage: npm run ingest -- -c <Zotero collection> [--doi <DOI>] [--all] [--dry-run] [--no-zotero] [file.mhtml ...]";

function parseArgs(argv: string[]): Options {
  const options: Options = { collection: "", doi: "", all: false, dryRun: false, zotero: true, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next) throw new Error(`${arg} needs a value\n${USAGE}`);
      return next;
    };
    if (arg === "-c" || arg === "--collection") options.collection = value();
    else if (arg === "--doi") options.doi = normalizeDoi(value());
    else if (arg === "--all") options.all = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--no-zotero") options.zotero = false;
    else if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}\n${USAGE}`);
    else options.files.push(path.resolve(arg));
  }
  if (options.zotero && !options.collection) throw new Error(`Specify the Zotero collection with -c\n${USAGE}`);
  return options;
}

// MHTML を落とす場所。Dropbox の「デスクトップとダウンロード」同期を使っている Mac では
// ~/Library/CloudStorage/Dropbox/Mac (2)/Downloads が実体になる。INGEST_DOWNLOADS_DIR で差し替え可。
function downloadsDir(): string {
  if (process.env.INGEST_DOWNLOADS_DIR) return process.env.INGEST_DOWNLOADS_DIR;
  const home = os.homedir();
  const candidates = [path.join(home, "Library", "CloudStorage", "Dropbox", "Mac (2)", "Downloads"), path.join(home, "Downloads")];
  return candidates.find((dir) => fs.existsSync(dir)) ?? candidates[candidates.length - 1];
}

function inputFiles(options: Options): string[] {
  if (options.files.length) return options.files;
  const dir = downloadsDir();
  const found = fs
    .readdirSync(dir)
    .filter((name) => /\.mhtml?$/i.test(name))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!found.length) throw new Error(`No .mhtml files in ${dir}`);
  return options.all ? found : found.slice(0, 1);
}

function mhtmlFileName(doi: string): string {
  return `${doi.replace(/[^a-zA-Z0-9._-]+/g, "_")}.mhtml`;
}

// ~/Dropbox は ~/Library/CloudStorage/Dropbox へのシンボリックリンクなので、パス文字列ではなく実体で比べる
function isSameFile(a: string, b: string): boolean {
  if (!fs.existsSync(b)) return false;
  return fs.realpathSync(a) === fs.realpathSync(b);
}

// 移動は rename、別ボリューム（Dropbox ↔ ローカル）なら copy + unlink にする。
function moveFile(from: string, to: string) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (e: any) {
    if (e?.code !== "EXDEV") throw e;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

interface ZoteroContext {
  target: ConnectorTarget;
  collectionKey: string;
  collectionNames: Map<string, string>;
  items: ZoteroItem[];
}

async function zoteroContext(collection: string): Promise<ZoteroContext> {
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

async function addToZotero(doi: string, sourceUrl: string, ctx: ZoteroContext, dryRun: boolean) {
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

async function ingest(file: string, options: Options, ctx: ZoteroContext | null) {
  console.log(`\n▶ ${path.basename(file)}`);
  const page = readMhtml(file);
  const meta = inferMeta(page.html, page.sourceUrl);
  const pageDoi = normalizeDoi(meta.doi);
  if (options.doi && pageDoi && options.doi !== pageDoi) {
    throw new Error(`--doi ${options.doi} does not match the DOI in the page (${pageDoi})`);
  }
  const doi = options.doi || pageDoi;
  if (!doi) throw new Error("No DOI found in the page. Pass it with --doi.");
  console.log(`  DOI: ${doi}${options.doi ? "" : " (from page)"}  ${meta.journal} ${meta.year}`);
  console.log(`  URL: ${page.sourceUrl}`);

  const stored = path.join(PATHS.mhtmlDir, mhtmlFileName(doi));
  if (options.dryRun) {
    console.log(`  MHTML: would move to ${stored}`);
  } else if (!isSameFile(file, stored)) {
    if (fs.existsSync(stored)) console.log("  MHTML: replacing the earlier copy");
    moveFile(file, stored);
    console.log(`  MHTML: ${stored}`);
  }

  if (ctx) await addToZotero(doi, page.sourceUrl, ctx, options.dryRun);
  if (options.dryRun) return;

  const article = await harvestArticle({ html: page.html, sourceUrl: page.sourceUrl });
  const reference = await harvestReferences({ html: page.html, sourceUrl: page.sourceUrl });
  const set = loadArticleSet(article.id);
  set.sourceMhtml = path.relative(PATHS.outputDir, stored);
  fs.writeFileSync(articleSetPath(set.id), JSON.stringify(set, null, 2), "utf-8");
  let type = "";
  try {
    const classified = await classifyArticle(set.id);
    type = classified.articleType ?? "not in PubMed";
  } catch (e: any) {
    type = `classification failed (${String(e?.message ?? e)}; retried on next server start)`;
  }
  console.log(`  JSON: ${article.id} — ${article.sections.length} sections, ${article.chunkCount} paragraphs, ${reference.totalReferences} references, ${type}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = inputFiles(options);
  const ctx = options.zotero ? await zoteroContext(options.collection) : null;
  if (ctx) console.log(`Zotero collection: ${ctx.target.name}${options.dryRun ? "  (dry run: nothing is written)" : ""}`);

  let failed = 0;
  for (const file of files) {
    try {
      await ingest(file, options, ctx);
    } catch (e: any) {
      failed += 1;
      console.error(`  ✗ ${String(e?.message ?? e)}`);
    }
  }

  if (ctx && !options.dryRun && failed < files.length) {
    const { report } = await syncZotero();
    console.log(`\nFolders synced from Zotero: ${report.matched.length} matched, ${report.moved.length} moved, ${report.foldersCreated.length} folders created`);
  }
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
