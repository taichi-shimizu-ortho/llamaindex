// 保存済み MHTML を出版社別のオフライン変換で取り込む CLI。
//
//   npm run ingest:offline -- -c "postless traction" mhtml/postless/wiley/Habib2018.mhtml
//   npm run ingest:offline -- -c "postless traction" mhtml/postless/wiley/      # フォルダ内の .mhtml をすべて
//   npm run ingest:offline -- -c general --dry-run ~/Downloads/Smith2026.mhtml   # 何も書かずに変換結果と行き先を確認
//
// ファイル名（拡張子を除く）がそのまま論文ID（引用キー。例: Habib2018）になる。出版社は MHTML の保存元URLから自動判定し、
// DOI・タイトル・著者はページのメタタグから読む。
//
// 変換は出版社で分かれる（2026-11-28〜）。
//   article-ingest が扱える出版社（ScienceDirect・Wiley・SAGE・PMC・MDPI・Frontiers・OUP・IOP・Bone & Joint・Dove）
//     → article-ingest の importMhtml.py で JATS にし、正本 <DATA_HOME>/articles/<DOI由来id>.json を作る。
//       引用キーは正本の aliases の先頭に入る。article_sets/ には書かない（一覧・RAG は正本から読む）。
//   それ以外（Springer・PNAS・JBJS など）、または --legacy
//     → 今までどおり scripts/convert-local-mhtml.py で article_sets / reference_sets / raw_html に書く。
//
// 1本ごとに:
//   1. 変換し、段落・図・表・参考文献の数と警告を表示する
//   2. MHTML が <データ>/mhtml/ の外にあれば mhtml/<出版社>/<ID>.mhtml へ移す（中にあればそのまま）
//   3. 正本（または article_sets）へ書き込み、PubMed で Original / Review に分類する
//   4. Zotero に DOI で登録して -c のコレクションへ入れる（既に同じ DOI があれば登録しない）
// 最後に Zotero のコレクション構成をフォルダへ同期する。
//
// MHTML に埋め込まれていない図は、ブラウザで開いて <ID>_fig<N>.jpg の名前で Downloads（または --figure-dir）に保存し、
// --replace を付けて取り込み直すと反映される。既存の raw_html/<ID>_figures/Figure_<N>.* も再利用する。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PATHS } from "../src/server/config.js";
import { articleIdForDoi } from "../src/server/articleHarvester.js";
import { classifyArticle } from "../src/server/articleClassifier.js";
import { normalizeDoi, syncZotero } from "../src/server/zotero.js";
import { addToZotero, downloadsDir, isInside, isSameFile, moveFile, zoteroContext } from "./lib/ingest-common.js";
import { aliasOwner, articleIngestPublisher, findCanonicalByDoi, importMhtml, setCitationKey, snapshotUrl } from "./lib/article-ingest.js";
import type { ZoteroContext } from "./lib/ingest-common.js";

const USAGE =
  'Usage: npm run ingest:offline -- -c <Zotero collection> [--dry-run] [--replace] [--no-zotero] [--copy] [--id <article ID>] [--figure-dir <dir>] [--legacy] <file.mhtml | folder> ...';

interface Options {
  collection: string;
  dryRun: boolean;
  replace: boolean;
  zotero: boolean;
  copy: boolean;
  legacy: boolean;
  id?: string;
  figureDirs: string[];
  inputs: string[];
}

function parseArgs(argv: string[]): Options {
  const options: Options = { collection: "", dryRun: false, replace: false, zotero: true, copy: false, legacy: false, figureDirs: [], inputs: [] };
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
    else if (arg === "--copy") options.copy = true;
    else if (arg === "--legacy") options.legacy = true;
    else if (arg === "--id") options.id = value();
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
  const args = ["-I", path.join(root, "scripts", "convert-local-mhtml.py"), id, "--input-file", file, "--output-dir", stage];
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

function writeJson(target: string, data: unknown) {
  const temp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(temp, target);
}

// mhtml/ 配下の出版社フォルダ名（変換スクリプトの略称 → 読める名前）
const PLATFORM_FOLDERS: Record<string, string> = { sd: "sciencedirect", oup: "oup", iop: "iop", bjr: "boneandjoint", dove: "dovepress" };

// MHTML の置き場所: データの mhtml/ 配下ならそのまま、外なら mhtml/<出版社>/<ID>.mhtml。
// 戻り値は置き場所と、もう同じものが置いてあるか。別の中身が置いてあれば止める。
function archiveTarget(file: string, id: string, platform: string, copy: boolean, sha256?: string) {
  const folder = PLATFORM_FOLDERS[platform] ?? platform;
  const stored = isInside(file, PATHS.mhtmlDir) ? file : path.join(PATHS.mhtmlDir, folder, `${id}.mhtml`);
  const digest = (p: string) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  const alreadyArchived = stored !== file && fs.existsSync(stored) &&
    (isSameFile(file, stored) || (copy && digest(stored) === (sha256 ?? digest(file))));
  if (stored !== file && fs.existsSync(stored) && !alreadyArchived) {
    throw new Error(`A different archive is already at ${stored}; move it away first`);
  }
  return { stored, alreadyArchived };
}

function archive(file: string, stored: string, alreadyArchived: boolean, copy: boolean) {
  if (stored === file || alreadyArchived) return;
  if (copy) {
    fs.mkdirSync(path.dirname(stored), { recursive: true });
    fs.copyFileSync(file, stored, fs.constants.COPYFILE_EXCL);
  } else moveFile(file, stored);
  console.log(`  MHTML: ${copy ? "copied" : "moved"} to ${relData(stored)}`);
}

async function classify(id: string): Promise<string> {
  try {
    const classified = await classifyArticle(id);
    return classified.articleType ?? "not in PubMed";
  } catch (e: any) {
    return `classification failed (${String(e?.message ?? e)}; retried on next server start)`;
  }
}

// article-ingest 経由（正本へ）の取り込み
async function ingestCanonical(file: string, id: string, sourceUrl: string, options: Options, ctx: ZoteroContext | null) {
  const figureDirs = [...options.figureDirs, path.join(PATHS.rawHtmlDir, `${id}_figures`)].filter((d) => fs.existsSync(d));
  const preview = importMhtml(file, { key: id, figureDirs, dryRun: true });
  const s = preview.summary;
  const doi = normalizeDoi(s.doi);
  console.log(`  DOI: ${doi}  [${s.publisher} → article-ingest ${preview.slug}]`);
  console.log(`  Parsed: ${s.paragraphs} paragraphs, ${s.embeddedFigures ?? s.figures}/${s.figures} figure images, ${s.tables} tables, ${s.references} references`);
  for (const warning of [...s.warnings, ...s.notices]) console.log(`  ⚠ ${warning}`);
  if (s.warnings.some((w) => w.startsWith("Figure image not embedded"))) {
    console.log(`    → save missing figures as ${id}_fig<N>.jpg in ${options.figureDirs[0] ?? downloadsDir()} and re-run with --replace`);
  }

  // ID・DOI の衝突を確かめる
  const sameDoi = articleIdForDoi(doi);
  if (sameDoi && sameDoi !== id) throw new Error(`DOI already imported as ${sameDoi}; use --id ${sameDoi} --replace to update it`);
  const legacyPath = path.join(PATHS.articleOutputDir, `${id}.json`);
  const legacy = fs.existsSync(legacyPath) ? JSON.parse(fs.readFileSync(legacyPath, "utf-8")) : null;
  if (legacy && normalizeDoi(legacy.doi ?? "") !== doi) throw new Error(`ID ${id} is already used by another paper (${legacy.doi}); rename the file`);
  const existing = findCanonicalByDoi(doi);
  const owner = aliasOwner(id);
  if (owner && owner !== existing?.id) throw new Error(`ID ${id} is already an alias of another canonical article (${owner}); rename the file`);
  if ((existing || legacy) && !options.replace) throw new Error(`${id} is already imported; review it and re-run with --replace to overwrite`);

  const { stored, alreadyArchived } = archiveTarget(file, id, s.publisher, options.copy);
  if (options.dryRun) {
    console.log(`  MHTML: ${stored === file || alreadyArchived ? "stays at" : options.copy ? "would copy to" : "would move to"} ${relData(stored)}`);
    console.log(`  JSON: would ${existing ? "rebuild" : "write"} the canonical article ${existing?.id ?? preview.slug} with alias ${id}`);
    if (ctx) await addToZotero(doi, sourceUrl, ctx, true);
    return;
  }

  const result = importMhtml(file, { key: id, figureDirs, force: !!existing || options.replace });
  const canonical = findCanonicalByDoi(doi);
  if (!canonical) throw new Error(`article-ingest wrote ${result.slug}, but no canonical article has DOI ${doi}`);
  setCitationKey(canonical.id, id, legacy?.legacyRxfp1Ids ?? []);
  archive(file, stored, alreadyArchived, options.copy);
  const type = await classify(id);
  console.log(`  JSON: canonical ${canonical.id} (alias ${id}) written, ${type}`);
  if (legacy) console.log(`  Note: article_sets/${id}.json is kept but no longer read (the canonical article has the same DOI)`);
  if (ctx) await addToZotero(doi, sourceUrl, ctx, false);
}

const backupStamp = new Date().toISOString().replace(/[:.]/g, "-");

async function ingest(file: string, options: Options, ctx: ZoteroContext | null) {
  const id = options.id ?? path.basename(file).replace(/\.mhtml?$/i, "");
  console.log(`\n▶ ${id}`);
  if (!/^[A-Za-z0-9_.-]+$/.test(id) || id === "." || id === "..") {
    throw new Error(`Invalid article ID: ${id}`);
  }

  const sourceUrl = snapshotUrl(file);
  const publisher = options.legacy ? null : articleIngestPublisher(sourceUrl);
  if (publisher) return ingestCanonical(file, id, sourceUrl, options, ctx);

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
    const sameDoi = articleIdForDoi(doi);
    if (sameDoi && sameDoi !== id) throw new Error(`DOI already imported as ${sameDoi}; use --id ${sameDoi} --replace to update it`);
    const exists = fs.existsSync(articlePath);
    if (exists) {
      const existing = JSON.parse(fs.readFileSync(articlePath, "utf-8"));
      if (normalizeDoi(existing.doi ?? "") !== doi) throw new Error(`ID ${id} is already used by another paper (${existing.doi}); rename the file`);
      if (!options.replace) throw new Error(`${id} is already imported; review it and re-run with --replace to overwrite`);
      if (existing.legacyRxfp1Ids?.length) article.legacyRxfp1Ids = existing.legacyRxfp1Ids;
    }

    const { stored, alreadyArchived } = archiveTarget(file, id, platform, options.copy, audit.sha256);
    article.sourceMhtml = relData(stored);
    article.provenance = { ...article.provenance, mhtmlFile: relData(stored), importGroup: path.basename(path.dirname(stored)) };
    const figureFiles = fs.existsSync(path.join(dir, "figures")) ? fs.readdirSync(path.join(dir, "figures")) : [];

    if (options.dryRun) {
      console.log(`  MHTML: ${stored === file || alreadyArchived ? "stays at" : options.copy ? "would copy to" : "would move to"} ${relData(stored)}`);
      console.log(`  JSON: would ${exists ? "replace" : "write"} article_sets/${id}.json and reference_sets/${id}.json (${figureFiles.length} figure files)`);
      if (ctx) await addToZotero(doi, article.sourceUrl, ctx, true);
      return;
    }

    archive(file, stored, alreadyArchived, options.copy);
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
    console.log(`  JSON: ${id} written, ${await classify(id)}`);
    if (ctx) await addToZotero(doi, article.sourceUrl, ctx, false);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = inputFiles(options.inputs);
  if (options.id && files.length !== 1) throw new Error("--id requires exactly one MHTML file");
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
