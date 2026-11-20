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
import path from "node:path";
import { PATHS } from "../src/server/config.js";
import { readMhtml } from "../src/server/mhtml.js";
import { articleSetPath, harvestArticle, inferMeta, loadArticleSet } from "../src/server/articleHarvester.js";
import { harvestReferences } from "../src/server/referenceHarvester.js";
import { classifyArticle } from "../src/server/articleClassifier.js";
import { normalizeDoi, syncZotero } from "../src/server/zotero.js";
import { addToZotero, downloadsDir, isSameFile, moveFile, zoteroContext } from "./lib/ingest-common.js";
import type { ZoteroContext } from "./lib/ingest-common.js";

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
