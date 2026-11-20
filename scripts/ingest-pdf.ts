// PDF例外取り込み。ページ座標を目視確認したprofileを使い、Zotero原本は保持する。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PATHS } from "../src/server/config.js";
import { readLibrary, writeLibrary } from "../src/server/library.js";

const USAGE = "npm run ingest:pdf -- --profile <layout.json> --folder <folder name> [--dry-run] [--replace] <file.pdf>";
const args = process.argv.slice(2);
let profile = "", folderName = "", input = "", dryRun = false, replace = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--profile" || arg === "--folder") {
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--profile") profile = path.resolve(value);
    else folderName = value;
  } else if (arg === "--dry-run") dryRun = true;
  else if (arg === "--replace") replace = true;
  else if (arg === "--help") { console.log(USAGE); process.exit(0); }
  else if (arg.startsWith("--") || input) throw new Error(USAGE);
  else input = path.resolve(arg);
}
if (!input || !profile || !folderName) throw new Error(USAGE);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const python = process.env.PDF_PYTHON || path.join(root, ".venv", ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));
const library = readLibrary();
const folders = library.folders.filter(f => f.name === folderName || f.id === folderName);
if (folders.length !== 1) throw new Error("Folder missing or ambiguous; specify an existing folder ID");
const folder = folders[0];
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "llamaindex-pdf-"));
const hash = (p: string) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
try {
  const result = spawnSync(python, [path.join(root, "scripts", "convert-local-pdf.py"), input, "--profile", profile, "--output-dir", stage], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`PDF conversion failed (${result.status})`);
  const article = JSON.parse(fs.readFileSync(path.join(stage, "article.json"), "utf8"));
  const reference = JSON.parse(fs.readFileSync(path.join(stage, "reference.json"), "utf8"));
  const id = article.id;
  if (!/^[A-Za-z0-9_.-]+$/.test(id) || [".", ".."].includes(id)) throw new Error("Invalid ID");
  const articlePath = path.join(PATHS.articleOutputDir, `${id}.json`);
  const referencePath = path.join(PATHS.referenceOutputDir, `${id}.json`);
  // Protect existing IDs and DOIs, including files imported under another citation key.
  for (const name of fs.existsSync(PATHS.articleOutputDir) ? fs.readdirSync(PATHS.articleOutputDir) : []) {
    if (!name.endsWith(".json")) continue;
    const existing = JSON.parse(fs.readFileSync(path.join(PATHS.articleOutputDir, name), "utf8"));
    if (existing.doi?.toLowerCase() === article.doi.toLowerCase() && existing.id !== id) throw new Error(`DOI already imported as ${existing.id}`);
  }
  for (const target of [articlePath, referencePath]) {
    if (fs.existsSync(target)) {
      const existing = JSON.parse(fs.readFileSync(target, "utf8"));
      if (existing.doi?.toLowerCase() !== article.doi.toLowerCase()) throw new Error(`ID collision at ${target}`);
      if (!replace) throw new Error(`${id} already exists; review before using --replace`);
      if (target === articlePath && existing.legacyRxfp1Ids?.length) article.legacyRxfp1Ids = existing.legacyRxfp1Ids;
    }
  }
  const pdfPath = path.join(PATHS.pdfDir, `${id}.pdf`);
  if (fs.existsSync(pdfPath) && hash(pdfPath) !== hash(input)) throw new Error("A different source PDF already exists; preserve it before importing");
  article.sourcePdf = path.relative(PATHS.outputDir, pdfPath).split(path.sep).join("/");
  console.log(JSON.stringify({ dryRun, id, folder: folder.name, sourcePdf: article.sourcePdf, paragraphs: article.chunkCount, references: reference.totalReferences }));
  if (!dryRun) {
    for (const dir of [PATHS.pdfDir, PATHS.articleOutputDir, PATHS.referenceOutputDir]) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(pdfPath)) fs.copyFileSync(input, pdfPath, fs.constants.COPYFILE_EXCL);
    for (const [target, data] of [[articlePath, article], [referencePath, reference]] as const) {
      const temp = `${target}.tmp-${process.pid}`;
      fs.writeFileSync(temp, JSON.stringify(data, null, 2), "utf8");
      fs.renameSync(temp, target);
    }
    // Read again so folder changes during conversion are retained.
    const next = readLibrary();
    if (!next.folders.some(f => f.id === folder.id)) throw new Error("Target folder was removed during conversion");
    next.assignments[id] = folder.id;
    writeLibrary(next);
    console.log(`Imported ${id} into ${folder.name}; original PDF retained.`);
  }
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
