// 保存済み MHTML を出版社別のオフライン変換（scripts/convert-local-mhtml.py）で取り込む CLI。
// npm run ingest（TS パーサ）より表・図・節の構造が正確な出版社（Wiley / SAGE / ScienceDirect など）向け。
//
//   npm run ingest:offline -- -c "postless traction" mhtml/postless/wiley/Habib2018.mhtml
//   npm run ingest:offline -- -c "postless traction" mhtml/postless/wiley/      # フォルダ内の .mhtml をすべて
//   npm run ingest:offline -- -c general --dry-run ~/Downloads/Smith2026.mhtml   # 何も書かずに変換結果と行き先を確認
//
// ファイル名（拡張子を除く）がそのまま論文ID（例: Habib2018）になる。出版社は MHTML の保存元URLから自動判定し、
// DOI・タイトル・著者はページのメタタグから読む。
//
// 1本ごとに:
//   1. 一時フォルダへ変換し、段落・図・表・参考文献の数と警告を表示する
//   2. MHTML が <データ>/mhtml/ の外にあれば mhtml/<出版社>/<ID>.mhtml へ移す（中にあればそのまま）
//   3. article_sets / reference_sets / raw_html（本文HTML・図）へ書き込み、PubMed で Original / Review に分類する
//   4. Zotero に DOI で登録して -c のコレクションへ入れる（既に同じ DOI があれば登録しない）
// 最後に Zotero のコレクション構成をフォルダへ同期する。
//
// MHTML に埋め込まれていない図は、ブラウザで開いて <ID>_fig<N>.jpg の名前で Downloads（または --figure-dir）に保存し、
// --replace を付けて取り込み直すと反映される。既存の raw_html/<ID>_figures/Figure_<N>.* も再利用する。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PATHS } from "../src/server/config.js";
import { classifyArticle } from "../src/server/articleClassifier.js";
import { normalizeDoi, syncZotero } from "../src/server/zotero.js";
import { addToZotero, downloadsDir, isInside, isSameFile, moveFile, zoteroContext } from "./lib/ingest-common.js";
import type { ZoteroContext } from "./lib/ingest-common.js";

const USAGE =
  'Usage: npm run ingest:offline -- -c <Zotero collection> [--dry-run] [--replace] [--no-zotero] [--figure-dir <dir>] <file.mhtml | folder> ...';

interface Options {
  collection: string;
  dryRun: boolean;
  replace: boolean;
  zotero: boolean;
  figureDirs: string[];
  inputs: string[];
}

function parseArgs(argv: string[]): Options {
  const options: Options = { collection: "", dryRun: false, replace: false, zotero: true, figureDirs: [], inputs: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith("--")) throw new Error(`${arg} needs a value\n${USAGE}`);
      return next;
    };
    if (arg === "-c" || arg === "--collection") options.collection = value();
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--replace") options.replace = true;
    else if (arg === "--no-zotero") options.zotero = false;
    else if (arg === "--figure-dir") options.figureDirs.push(path.resolve(value()));
    else if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}\n${USAGE}`);
    else options.inputs.push(path.resolve(arg));
  }
  if (!options.inputs.length) throw new Error(`Give at least one .mhtml file or folder\n${USAGE}`);
  if (options.zotero && !options.collection) throw new Error(`Specify the Zotero collection with -c (or --no-zotero)\n${USAGE}`);
  return options;
}

function inputFiles(inputs: string[]): string[] {
  const files: string[] = [];
  for (const input of inputs) {
    if (!fs.existsSync(input)) throw new Error(`Not found: ${input}`);
    if (fs.statSync(input).isDirectory()) {
      const found = fs.readdirSync(input).filter((n) => /\.mhtml?$/i.test(n)).sort();
      if (!found.length) throw new Error(`No .mhtml files in ${input}`);
      files.push(...found.map((n) => path.join(input, n)));
    } else files.push(input);
  }
  return [...new Set(files)];
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const python =
  process.env.OFFLINE_PYTHON || path.join(root, ".venv", ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));
// データ直下からの相対パス。~/Dropbox はシンボリックリンクなので、外に出るなら実体どうしで取り直す。
function relData(p: string): string {
  let rel = path.relative(PATHS.outputDir, p);
  if (rel.startsWith("..") && fs.existsSync(PATHS.outputDir)) {
    const real = fs.existsSync(p) ? fs.realpathSync(p) : path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
    rel = path.relative(fs.realpathSync(PATHS.outputDir), real);
  }
  return rel.split(path.sep).join("/");
}

interface Staged {
  article: any;
  reference: any;
  audit: any;
  dir: string;
}

function convert(file: string, id: string, figureDirs: string[], stage: string): Staged {
  const figures = [...figureDirs, path.join(PATHS.rawHtmlDir, `${id}_figures`)].filter((d) => fs.existsSync(d));
  const args = ["-I", path.join(root, "scripts", "convert-local-mhtml.py"), id, "--input-dir", path.dirname(file), "--output-dir", stage];
  for (const dir of figures) args.push("--figure-dir", dir);
  const result = spawnSync(python, args, { encoding: "utf-8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const lines = (result.stderr || result.stdout || "").trim().split("\n");
    throw new Error(`conversion failed: ${lines[lines.length - 1]}`);
  }
  const dir = path.join(stage, id);
  const read = (name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8"));
  return { article: read("article.json"), reference: read("reference.json"), audit: read("audit.json"), dir };
}

// 既存の主論文JSONを走査し、同じ DOI が別IDで入っていないか確かめる
function idForDoi(doi: string): string | undefined {
  if (!fs.existsSync(PATHS.articleOutputDir)) return undefined;
  for (const name of fs.readdirSync(PATHS.articleOutputDir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const existing = JSON.parse(fs.readFileSync(path.join(PATHS.articleOutputDir, name), "utf-8"));
      if (normalizeDoi(existing.doi ?? "") === doi) return existing.id ?? name.replace(/\.json$/, "");
    } catch {
      // 壊れたJSONは取り込みの判断材料にしない
    }
  }
  return undefined;
}

function writeJson(target: string, data: unknown) {
  const temp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(temp, target);
}

// mhtml/ 配下の出版社フォルダ名（変換スクリプトの略称 → 読める名前）
const PLATFORM_FOLDERS: Record<string, string> = { sd: "sciencedirect", oup: "oup", iop: "iop", bjr: "boneandjoint" };

const backupStamp = new Date().toISOString().replace(/[:.]/g, "-");

async function ingest(file: string, options: Options, ctx: ZoteroContext | null) {
  const id = path.basename(file).replace(/\.mhtml?$/i, "");
  console.log(`\n▶ ${id}`);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`File name must be the article ID (letters, digits, _ or -): ${path.basename(file)}`);

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "llamaindex-offline-"));
  try {
    const { article, reference, audit, dir } = convert(file, id, options.figureDirs, stage);
    const doi = normalizeDoi(article.doi);
    const platform = article.provenance?.savedPlatform ?? "other";
    console.log(`  DOI: ${doi}  ${article.journal} ${article.year}  [${platform}]`);
    console.log(
      `  Parsed: ${audit.textParagraphs} paragraphs, ${audit.embeddedFigures}/${audit.figures} figure images, ${audit.tables} tables, ${audit.references} references`,
    );
    for (const warning of [...(article.qualityWarnings ?? []), ...(audit.notices ?? [])]) console.log(`  ⚠ ${warning}`);
    if ((article.qualityWarnings ?? []).some((w: string) => w.startsWith("Figure image not embedded"))) {
      console.log(`    → save missing figures as ${id}_fig<N>.jpg in ${options.figureDirs[0] ?? downloadsDir()} and re-run with --replace`);
    }

    // ID・DOI の衝突を確かめる（別IDで同じ DOI が入っていれば止める）
    const articlePath = path.join(PATHS.articleOutputDir, `${id}.json`);
    const referencePath = path.join(PATHS.referenceOutputDir, `${id}.json`);
    const sameDoi = idForDoi(doi);
    if (sameDoi && sameDoi !== id) throw new Error(`DOI already imported as ${sameDoi}; rename the file to ${sameDoi}.mhtml to replace it`);
    const exists = fs.existsSync(articlePath);
    if (exists) {
      const existing = JSON.parse(fs.readFileSync(articlePath, "utf-8"));
      if (normalizeDoi(existing.doi ?? "") !== doi) throw new Error(`ID ${id} is already used by another paper (${existing.doi}); rename the file`);
      if (!options.replace) throw new Error(`${id} is already imported; review it and re-run with --replace to overwrite`);
    }

    // MHTML の置き場所: データの mhtml/ 配下ならそのまま、外なら mhtml/<出版社>/<ID>.mhtml
    const folder = PLATFORM_FOLDERS[platform] ?? platform;
    const stored = isInside(file, PATHS.mhtmlDir) ? file : path.join(PATHS.mhtmlDir, folder, `${id}.mhtml`);
    if (stored !== file && fs.existsSync(stored) && !isSameFile(file, stored)) {
      throw new Error(`A different archive is already at ${stored}; move it away first`);
    }
    article.sourceMhtml = relData(stored);
    article.provenance = { ...article.provenance, mhtmlFile: relData(stored), importGroup: path.basename(path.dirname(stored)) };
    const figureFiles = fs.existsSync(path.join(dir, "figures")) ? fs.readdirSync(path.join(dir, "figures")) : [];

    if (options.dryRun) {
      console.log(`  MHTML: ${stored === file ? "stays at" : "would move to"} ${relData(stored)}`);
      console.log(`  JSON: would ${exists ? "replace" : "write"} article_sets/${id}.json and reference_sets/${id}.json (${figureFiles.length} figure files)`);
      if (ctx) await addToZotero(doi, article.sourceUrl, ctx, true);
      return;
    }

    if (stored !== file) {
      moveFile(file, stored);
      console.log(`  MHTML: moved to ${relData(stored)}`);
    }
    if (exists) {
      const backup = path.join(PATHS.outputDir, "backups", `ingest-offline-${backupStamp}`);
      fs.mkdirSync(backup, { recursive: true });
      fs.copyFileSync(articlePath, path.join(backup, `${id}.article.json`));
      if (fs.existsSync(referencePath)) fs.copyFileSync(referencePath, path.join(backup, `${id}.reference.json`));
      console.log(`  Backup: previous JSON in ${relData(backup)}`);
    }
    for (const d of [PATHS.articleOutputDir, PATHS.referenceOutputDir, PATHS.rawHtmlDir]) fs.mkdirSync(d, { recursive: true });
    writeJson(articlePath, article);
    writeJson(referencePath, reference);
    fs.copyFileSync(path.join(dir, "source.html"), path.join(PATHS.rawHtmlDir, `${id}.source.html`));
    if (figureFiles.length) {
      const figureDir = path.join(PATHS.rawHtmlDir, `${id}_figures`);
      fs.mkdirSync(figureDir, { recursive: true });
      for (const name of figureFiles) fs.copyFileSync(path.join(dir, "figures", name), path.join(figureDir, name));
    }
    let type = "";
    try {
      const classified = await classifyArticle(id);
      type = classified.articleType ?? "not in PubMed";
    } catch (e: any) {
      type = `classification failed (${String(e?.message ?? e)}; retried on next server start)`;
    }
    console.log(`  JSON: ${id} written, ${type}`);
    if (ctx) await addToZotero(doi, article.sourceUrl, ctx, false);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = inputFiles(options.inputs);
  if (!options.figureDirs.length && fs.existsSync(downloadsDir())) options.figureDirs.push(downloadsDir());
  const ctx = options.zotero ? await zoteroContext(options.collection) : null;
  if (ctx) console.log(`Zotero collection: ${ctx.target.name}${options.dryRun ? "  (dry run: nothing is written)" : ""}`);
  else if (options.dryRun) console.log("Dry run: nothing is written");

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
  console.log(`\n${files.length - failed}/${files.length} ${options.dryRun ? "checked" : "imported"}`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
