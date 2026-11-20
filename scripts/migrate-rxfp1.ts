// Copy the legacy RXFP1 corpus into the regular article catalogue. Re-running the
// migration fills missing records and aliases without refreshing edited current text.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { articleSetPath, listArticleSets, loadArticleSet, type ArticleSet } from "../src/server/articleHarvester.js";
import { PATHS } from "../src/server/config.js";
import { descendantIds, readLibrary, rxfp1DocumentIds } from "../src/server/library.js";
import { hasRxfp1Body, loadLegacyRxfp1Corpus } from "../src/server/rxfp1Corpus.js";

function workKeys(set: ArticleSet): string[] {
  const doi = set.doi?.trim().replace(/^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/i, "").toLowerCase();
  const title = set.title?.normalize("NFKD").toLowerCase().replace(/\p{M}|[^\p{L}\p{N}]/gu, "");
  return [
    doi ? `doi:${doi}` : "",
    set.pmid ? `pmid:${set.pmid}` : "",
    title && set.year ? `title:${title}:${set.year}` : "",
  ].filter(Boolean);
}

function compatible(a: ArticleSet, b: ArticleSet): boolean {
  const known = new Set(workKeys(a));
  for (const key of workKeys(b)) {
    if (key.startsWith("title:")) continue;
    const kind = key.split(":")[0];
    if ([...known].some((candidate) => candidate.startsWith(kind + ":") && candidate !== key)) return false;
  }
  return true;
}

interface Update {
  file: string;
  previous: string | null;
  next: string;
}

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--apply" && arg !== "--dry-run") || args.length > 1) {
  throw new Error("Usage: node --import tsx scripts/migrate-rxfp1.ts [--dry-run | --apply]");
}
const apply = args.includes("--apply");
const now = new Date().toISOString();
const legacy = loadLegacyRxfp1Corpus();
if (legacy.errors.length) throw new Error(legacy.errors.join("\n"));
if (!legacy.articles.size) throw new Error("The legacy RXFP1 corpus is empty.");

const current = listArticleSets().map(({ id }) => loadArticleSet(id));
const library = readLibrary();
const roots = library.folders.filter((folder) => folder.name.toLowerCase() === "rxfp1");
if (roots.length > 1) throw new Error("There is more than one RXFP1 folder.");
const root = roots[0] ?? { id: `f_${randomUUID()}`, name: "RXFP1", parentId: null, createdAt: now };
const libraryBefore = fs.existsSync(PATHS.libraryFile) ? fs.readFileSync(PATHS.libraryFile, "utf8") : null;
const originalAssignments = { ...library.assignments };
if (!roots.length) library.folders.push(root);
const folderMembers = rxfp1DocumentIds(library);
const childFolders = descendantIds(library, root.id);
const updates: Update[] = [];
const reused: string[] = [];
const created: string[] = [];
const keptElsewhere: string[] = [];
const allocated = new Map<string, string>();
for (const set of current) {
  for (const id of [set.id, ...(set.legacyRxfp1Ids ?? [])]) {
    const owner = allocated.get(id.toLowerCase());
    if (owner && owner !== set.id) throw new Error(`Existing article ID or alias collision: ${id}`);
    allocated.set(id.toLowerCase(), set.id);
  }
}

const bindings: { article: ArticleSet; existing?: ArticleSet }[] = [];
for (const source of legacy.articles.values()) {
  const sourceKeys = workKeys(source);
  const knownIds = [source.id, ...(source.legacyRxfp1Ids ?? [])];
  const candidates = current.filter((set) => compatible(set, source) &&
    (knownIds.some((id) => allocated.get(id.toLowerCase()) === set.id) || workKeys(set).some((key) => sourceKeys.includes(key))));
  if (candidates.length > 1) throw new Error(`Multiple current matches for ${source.title}: ${candidates.map((set) => set.id).join(", ")}`);
  const existing = candidates[0];
  const id = existing?.id ?? source.id;
  for (const alias of knownIds) {
    const previous = allocated.get(alias.toLowerCase());
    if (previous && previous !== id) throw new Error(`Article ID collision: ${alias} is already assigned to ${previous}`);
    allocated.set(alias.toLowerCase(), id);
  }

  const aliases = [...new Set([...(existing?.legacyRxfp1Ids ?? []), ...knownIds])].filter((alias) => alias !== id).sort();
  let article: ArticleSet;
  if (!existing) {
    article = { ...source, createdAt: now };
    created.push(id);
  } else {
    article = { ...existing };
    if (!hasRxfp1Body(existing) && hasRxfp1Body(source)) {
      const abstract = existing.sections.some((section) => section.type === "abstract");
      article.sections = [
        ...existing.sections.filter((section) => section.type === "abstract"),
        ...source.sections.filter((section) => section.type !== "abstract" || !abstract),
      ];
      article.chunkCount = article.sections.reduce((sum, section) =>
        sum + section.paragraphs.length + section.subsections.reduce((count, subsection) => count + subsection.paragraphs.length, 0), 0);
    }
    reused.push(id);
  }
  if (aliases.length) article.legacyRxfp1Ids = aliases;
  bindings.push({ article, existing });

  const assigned = library.assignments[id];
  if (!assigned) library.assignments[id] = root.id;
  else if (!childFolders.has(assigned) && !folderMembers.has(id)) keptElsewhere.push(id);
}

if (new Set(bindings.map(({ article }) => article.id)).size !== bindings.length) {
  throw new Error("Multiple legacy records would write the same article; review the duplicate metadata.");
}

for (const { article, existing } of bindings) {
  if (existing && JSON.stringify(existing) === JSON.stringify(article)) continue;
  const file = articleSetPath(article.id);
  const previous = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  updates.push({ file, previous, next: JSON.stringify(article, null, 2) + "\n" });
}
if (!roots.length || JSON.stringify(originalAssignments) !== JSON.stringify(library.assignments)) {
  updates.push({ file: PATHS.libraryFile, previous: libraryBefore, next: JSON.stringify(library, null, 2) + "\n" });
}

const summary = {
  dryRun: !apply,
  total: bindings.length,
  fromStructuredJson: bindings.filter(({ article, existing }) => !existing && article.extractionSource === "rxfp1-legacy-json").length,
  fromMarkdown: bindings.filter(({ article, existing }) => !existing && article.extractionSource === "rxfp1-markdown").length,
  newArticles: created.length,
  reused: reused.length,
  mergedIntoCurrent: reused.filter((id) => !id.startsWith("rxfp1.")),
  migratedWithBody: bindings.filter(({ article }) => hasRxfp1Body(article)).length,
  keptElsewhere,
  plannedWrites: updates.length,
};
console.log(JSON.stringify(summary, null, 2));

function writeAtomic(file: string, text: string, exclusive: boolean) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, text, { encoding: "utf8", flag: "wx" });
  try {
    if (!exclusive) fs.renameSync(temporary, file);
    else {
      try {
        fs.linkSync(temporary, file);
      } catch (error) {
        if (!["ENOTSUP", "EOPNOTSUPP", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        fs.copyFileSync(temporary, file, fs.constants.COPYFILE_EXCL);
      }
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

if (apply && updates.length) {
  const backup = path.join(PATHS.outputDir, "backups", `rxfp1-migration-${now.replace(/[:.]/g, "-")}`);
  for (const update of updates) {
    const disk = fs.existsSync(update.file) ? fs.readFileSync(update.file, "utf8") : null;
    if (disk !== update.previous) throw new Error(`Changed since migration planned: ${update.file}`);
    if (update.previous !== null) writeAtomic(path.join(backup, path.basename(update.file)), update.previous, true);
  }
  // The folder assignment is written last. A retry recognizes completed article copies.
  for (const update of updates) writeAtomic(update.file, update.next, update.previous === null);
  console.log(`Applied ${updates.length} writes. Backup: ${path.relative(PATHS.outputDir, backup)}`);
}
