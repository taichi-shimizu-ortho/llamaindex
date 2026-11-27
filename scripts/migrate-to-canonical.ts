// 既存の article_sets/ の論文を article-ingest の正本（<DATA_HOME>/articles/）へ移す。
//
//   npm run migrate:canonical -- --dry-run                 # 何も書かずに、論文ごとの経路（計画）だけを出す
//   npm run migrate:canonical -- --dry-run --only Habib2018,Li2026
//   npm run migrate:canonical                              # 実行（article_sets/ と reference_sets/ を backups/ に丸ごとコピーしてから）
//   ARTICLE_JSON_DATA_HOME=/tmp/box npm run migrate:canonical   # 共有の箱に書かず、コピーで試す
//
// 経路:
//   alias  正本に同じ DOI の論文がある → 作り直さず、別名（引用キー）だけを付ける
//   mhtml  MHTML があり、article-ingest が扱える出版社 → importMhtml.py で作り直す
//   jats   sage-jats / pmc-jats で raw_html/<id>.source.xml がある → raw/ に置いて build
//   json   それ以外（rxfp1-legacy-json・html・記録なし・未対応の出版社の MHTML）→ import-json（最小限の JATS）
//   keep   PDF・Word・DOI なし → 移さない（article_sets/ のまま読む）
// mhtml と jats が失敗したら json で取り込み直し、理由をレポートに残す。
//
// どの経路でも、引用キーを aliases の先頭に入れ（legacyRxfp1Ids も別名にする）、分類を classification に移し、
// 図の画像が旧データにだけあれば <DATA_HOME>/figures/ にコピーする。最後に射影と旧 JSON を比べ、
// <Obsidian>/50_coding/llamaindex/<日付>_canonical移行レポート.md に表でまとめる。
// article_sets/ と reference_sets/ は消さない・書き換えない。別名が衝突したら、そこで止める。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildXmlFile } from "article-ingest/build";
import { compareArticleSets, type Comparison } from "article-ingest/compare";
import { slugFromDoi } from "article-ingest/parseJats";
import { DATA_HOME, dirFor } from "article-ingest/paths";
import { toArticleSet } from "article-ingest/projection";
import type { ArticleSet as ProjectedSet } from "article-ingest/projection";
import { PATHS } from "../src/server/config.js";
import {
  articleIngestDir,
  articleIngestPublisher,
  attachLegacyFigures,
  doiKey,
  findCanonicalByDoi,
  importMhtml,
  setCitationKey,
  snapshotUrl,
  transferClassification,
  updateCorpus,
  writeArticle,
} from "./lib/article-ingest.js";

type Route = "alias" | "mhtml" | "jats" | "json" | "keep";
const ROUTES: Route[] = ["alias", "mhtml", "jats", "json", "keep"];

const USAGE =
  "Usage: npm run migrate:canonical -- [--dry-run] [--only <id,id>] [--route <alias|mhtml|jats|json>] [--limit <n>] [--force] [--report <file.md>]";

interface Options {
  dryRun: boolean;
  only: Set<string>;
  routes: Set<Route>;
  limit: number;
  force: boolean;
  report?: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { dryRun: false, only: new Set(), routes: new Set(), limit: Infinity, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith("--")) throw new Error(`${arg} needs a value\n${USAGE}`);
      return next;
    };
    if (arg === "--dry-run" || arg === "-n") options.dryRun = true;
    else if (arg === "--only") for (const id of value().split(",")) options.only.add(id.trim());
    else if (arg === "--route") {
      const route = value() as Route;
      if (!ROUTES.includes(route)) throw new Error(`Unknown route ${route}\n${USAGE}`);
      options.routes.add(route);
    } else if (arg === "--limit") options.limit = Number(value());
    else if (arg === "--force") options.force = true;
    else if (arg === "--report") options.report = path.resolve(value());
    else if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`Unknown option ${arg}\n${USAGE}`);
  }
  return options;
}

interface LegacySet {
  id: string;
  doi?: string;
  sourceUrl?: string;
  sections: Array<{ title: string; type: string; paragraphs: string[]; content?: string; subsections: Array<{ paragraphs: string[] }> }>;
  chunkCount: number;
  extractionSource?: string;
  sourceMhtml?: string;
  provenance?: { mhtmlFile?: string; savedPlatform?: string; supplements?: Array<{ source?: string; figure?: string }> };
  legacyRxfp1Ids?: string[];
  articleType?: "original" | "review" | "manuscript" | null;
  articleTypeSource?: "pubmed" | "manual";
  publicationTypes?: string[];
  pubmedCheckedAt?: string;
  pmid?: string;
}

interface Plan {
  id: string;
  file: string;
  set?: LegacySet;
  doi: string;
  route: Route;
  reason: string;
  slug: string;
  mhtml?: string;
  jats?: string;
  reference?: string;
}

interface Outcome {
  plan: Plan;
  route: Route;
  canonicalId?: string;
  fallback?: string;
  comparison?: Comparison;
  figuresCopied?: number;
  warnings: string[];
  error?: string;
}

// mhtml/ 配下を一度だけ索引する（<ID>.mhtml、<DOI>.mhtml のどちらでも引けるように）
function mhtmlIndex(): Map<string, string> {
  const index = new Map<string, string>();
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.mhtml?$/i.test(entry.name)) index.set(entry.name.replace(/\.mhtml?$/i, "").toLowerCase(), full);
    }
  };
  walk(PATHS.mhtmlDir);
  return index;
}

function findMhtml(set: LegacySet, index: Map<string, string>): string | undefined {
  for (const recorded of [set.sourceMhtml, set.provenance?.mhtmlFile]) {
    if (!recorded) continue;
    const rel = recorded.replace(/\\/g, "/");
    const candidate = path.isAbsolute(rel) ? rel : path.join(PATHS.outputDir, ...rel.split("/"));
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  const doiName = set.doi ? set.doi.replace(/[^a-zA-Z0-9._-]+/g, "_").toLowerCase() : "";
  return index.get(set.id.toLowerCase()) ?? (doiName ? index.get(doiName) : undefined);
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function planAll(options: Options): Plan[] {
  const index = mhtmlIndex();
  const plans: Plan[] = [];
  const names = fs.readdirSync(PATHS.articleOutputDir).filter((n) => n.endsWith(".json")).sort();
  for (const name of names) {
    const id = name.replace(/\.json$/, "");
    if (options.only.size && !options.only.has(id)) continue;
    const file = path.join(PATHS.articleOutputDir, name);
    let set: LegacySet;
    try {
      set = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch (e) {
      plans.push({ id, file, doi: "", route: "keep", reason: `unreadable JSON (${(e as Error).message})`, slug: "" });
      continue;
    }
    const doi = doiKey(set.doi);
    const base = { id: set.id || id, file, set, doi, slug: doi ? slugFromDoi(set.doi, id) : "" };
    const reference = path.join(PATHS.referenceOutputDir, `${base.id}.json`);
    const withRef = fs.existsSync(reference) ? { reference } : {};
    const source = set.extractionSource ?? "";
    if (source === "pdf" || source === "docx") {
      plans.push({ ...base, route: "keep", reason: source });
      continue;
    }
    if (!doi) {
      plans.push({ ...base, route: "keep", reason: "no DOI" });
      continue;
    }
    const canonical = findCanonicalByDoi(doi);
    if (canonical) {
      plans.push({ ...base, slug: canonical.id, route: "alias", reason: `canonical ${canonical.id} exists` });
      continue;
    }
    const mhtml = findMhtml(set, index);
    const publisher = mhtml ? articleIngestPublisher(snapshotUrl(mhtml)) : null;
    // 手で足した図以外の内容（Breuil2021 の表の HTML など）は MHTML に無いので、作り直すと消える。旧 JSON から載せる。
    const supplied = (set.provenance?.supplements ?? []).filter((x) => !/image|figure/i.test(x.source ?? "") && !x.figure);
    if (mhtml && publisher && supplied.length) {
      plans.push({ ...base, ...withRef, route: "json", reason: `user-supplied content not in the MHTML (${supplied.map((x) => x.source).join(", ")})` });
      continue;
    }
    if (mhtml && publisher) {
      plans.push({ ...base, ...withRef, route: "mhtml", reason: publisher, mhtml });
      continue;
    }
    const jats = path.join(PATHS.rawHtmlDir, `${base.id}.source.xml`);
    if (/-jats$/.test(source) && fs.existsSync(jats)) {
      plans.push({ ...base, ...withRef, route: "jats", reason: source, jats });
      continue;
    }
    const why = mhtml ? `MHTML from an unsupported publisher (${hostnameOf(snapshotUrl(mhtml)) || "no URL"})`
      : /-jats$/.test(source) ? `${source} without source.xml` : source || "no extraction record";
    plans.push({ ...base, ...withRef, route: "json", reason: why });
  }
  return plans;
}

function backupLegacy(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(PATHS.outputDir, "backups", `canonical-migration-${stamp}`);
  for (const dir of [PATHS.articleOutputDir, PATHS.referenceOutputDir]) {
    fs.cpSync(dir, path.join(dest, path.basename(dir)), { recursive: true, errorOnExist: true });
  }
  return dest;
}

function rawPath(slug: string) {
  return path.join(dirFor("raw"), `${slug}.xml`);
}

function build(xml: string, force: boolean): string {
  const row = buildXmlFile(xml, { force });
  if (row.status === "error") throw new Error(`build: ${row.message}`);
  return row.id!;
}

function runJats(plan: Plan, force: boolean): string {
  const dest = rawPath(plan.slug);
  if (fs.existsSync(dest) && !force) throw new Error(`Already in raw/: ${path.basename(dest)} (use --force)`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(plan.jats!, dest);
  return build(dest, force);
}

function runJson(plan: Plan, force: boolean): string {
  const dest = rawPath(plan.slug);
  if (fs.existsSync(dest) && !force) throw new Error(`Already in raw/: ${path.basename(dest)} (use --force)`);
  const args = ["--import", "tsx", path.join(articleIngestDir(), "src", "tools", "importArticleJson.ts"), plan.file];
  if (plan.reference) args.push(plan.reference);
  if (force) args.push("--force");
  const result = spawnSync(process.execPath, args, { cwd: articleIngestDir(), encoding: "utf-8", env: process.env });
  if (result.status !== 0) {
    const last = `${result.stderr}\n${result.stdout}`.trim().split("\n").filter(Boolean).pop();
    throw new Error(`import-json: ${last}`);
  }
  if (!fs.existsSync(dest)) throw new Error(`import-json did not write ${path.basename(dest)}`);
  return build(dest, true);
}

function runMhtml(plan: Plan, force: boolean): { id: string; warnings: string[] } {
  const figures = path.join(PATHS.rawHtmlDir, `${plan.id}_figures`);
  const result = importMhtml(plan.mhtml!, { key: plan.id, figureDirs: [figures], force, corpus: false });
  const canonical = findCanonicalByDoi(plan.doi);
  if (!canonical) throw new Error(`imported ${result.slug}, but its DOI (${result.summary.doi}) does not match ${plan.doi}`);
  return { id: canonical.id, warnings: [...result.summary.warnings, ...result.summary.notices] };
}

function finish(plan: Plan, canonicalId: string, outcome: Outcome) {
  const set = plan.set!;
  // 別名: 引用キーを先頭に。衝突は例外にして、呼び出し側で全体を止める。
  const canonical = setCitationKey(canonicalId, plan.id, set.legacyRxfp1Ids ?? []);
  const article = canonical.article;
  transferClassification(article, set);
  outcome.figuresCopied = attachLegacyFigures(article, set.sections);
  writeArticle(canonical.file, article);
  const projected = toArticleSet(article, { id: plan.id, figureUrl: (a, f) => `/canonical-figures/${a.id}/${f}` });
  outcome.comparison = compareArticleSets(projected as ProjectedSet, set as unknown as ProjectedSet);
  outcome.canonicalId = canonicalId;
  outcome.warnings.push(...article.warnings.filter((w) => !outcome.warnings.includes(w)));
}

function migrate(plan: Plan, options: Options): Outcome {
  const outcome: Outcome = { plan, route: plan.route, warnings: [] };
  if (plan.route === "keep") return outcome;
  let canonicalId: string;
  if (plan.route === "alias") canonicalId = plan.slug;
  else {
    try {
      if (plan.route === "mhtml") {
        const r = runMhtml(plan, options.force);
        canonicalId = r.id;
        outcome.warnings.push(...r.warnings);
      } else if (plan.route === "jats") canonicalId = runJats(plan, options.force);
      else canonicalId = runJson(plan, options.force);
    } catch (e) {
      if (plan.route === "json") throw e;
      // 作り直せなかった論文は、旧 JSON から最小限の JATS で載せる（本文は残る）
      outcome.fallback = String((e as Error).message ?? e);
      outcome.route = "json";
      canonicalId = runJson(plan, true);
    }
  }
  finish(plan, canonicalId, outcome);
  return outcome;
}

// --- レポート -------------------------------------------------------------------

// 日付はこの Mac の現地時刻で（UTC だと朝の実行が前日の日付になる）
const localDate = () => new Date().toLocaleDateString("sv-SE");

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function summaryRow(o: Outcome): string {
  const c = o.comparison;
  if (o.error) return `| ${o.plan.id} | ${o.canonicalId ?? o.plan.slug} | ${o.route} | — | — | — | — | ✗ ${cell(o.error)} |`;
  if (!c) return `| ${o.plan.id} | — | keep | — | — | — | — | ${cell(o.plan.reason)} |`;
  const body = `${c.covered}/${c.current.body.length}`;
  const missing = c.missing.length ? `**${c.missing.length}**` : "0";
  const figures = `${c.projected.figures}（画像 ${c.projected.figureImages}）/ ${c.current.figures}（画像 ${c.current.figureImages}）`;
  const tables = `${c.projected.tables} / ${c.current.tables}${c.current.tableRows ? `（旧は1行1段落 ${c.current.tableRows}）` : ""}`;
  const notes = [
    c.missingTables.length ? `**中身が見つからない表: ${c.missingTables.join(", ")}**` : "",
    o.fallback ? `${o.plan.route} から json に切り替え: ${o.fallback}` : "",
    c.inCaptions ? `図表の説明文へ移動 ${c.inCaptions}` : "",
    o.figuresCopied ? `旧データから画像 ${o.figuresCopied} 枚` : "",
    ...o.warnings.slice(0, 3),
    o.warnings.length > 3 ? `ほか警告 ${o.warnings.length - 3} 件` : "",
  ].filter(Boolean);
  return `| ${o.plan.id} | ${o.canonicalId} | ${o.route} | ${body} | ${missing} | ${figures} | ${tables} | ${cell(notes.join("; "))} |`;
}

function writeReport(file: string, outcomes: Outcome[], backup: string | null, stopped?: string) {
  const count = (r: Route) => outcomes.filter((o) => o.route === r && !o.error).length;
  const errors = outcomes.filter((o) => o.error);
  const withMissing = outcomes.filter((o) => o.comparison?.missing.length);
  const withMissingTables = outcomes.filter((o) => o.comparison?.missingTables.length);
  const lines = [
    "---",
    `date: ${localDate()}`,
    "instructions: 2026-11-27 llamaindexエージェント指示書_article-ingest移行.md",
    "---",
    "",
    `# canonical 移行レポート（${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC）`,
    "",
    `- 正本の置き場所（DATA_HOME）: \`${DATA_HOME}\``,
    `- 旧データのバックアップ: ${backup ? `\`${path.relative(PATHS.outputDir, backup)}\`` : "（なし）"}`,
    `- 対象 ${outcomes.length} 本: alias ${count("alias")}、mhtml ${count("mhtml")}、jats ${count("jats")}、json ${count("json")}、移さない ${count("keep")}、失敗 ${errors.length}`,
    `- 本文の欠落がある論文: ${withMissing.length} 本、中身が見つからない表がある論文: ${withMissingTables.length} 本`,
    ...(stopped ? ["", `> **途中で止めた:** ${stopped}`] : []),
    "",
    "「本文」は、旧 JSON の本文段落のうち正本の射影にあるもの / 旧 JSON の本文段落の数。照合は文字と数字だけで行う（空白・記号・引用の書き方は無視する）。",
    "「欠落」は、本文にも図・表の説明文にも見つからない段落の数。表は別に、旧 JSON の表のセルの 9 割が射影のどこかにあるかを見る。",
    "",
    "| 引用キー | 正本 id | 経路 | 本文 | 欠落 | 図 正本 / 旧 | 表 正本 / 旧 | 警告・備考 |",
    "|---|---|---|---|---|---|---|---|",
    ...outcomes.map(summaryRow),
    "",
  ];
  if (withMissing.length) {
    lines.push("## 欠落した段落（各論文 5 件まで）", "");
    for (const o of withMissing) {
      lines.push(`### ${o.plan.id}（${o.route}）`, "");
      for (const p of o.comparison!.missing.slice(0, 5)) lines.push(`- ${cell(p.slice(0, 200))}`);
      lines.push("");
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n"), "utf-8");
}

function printPlan(plans: Plan[]) {
  const width = Math.max(...plans.map((p) => p.id.length), 8);
  for (const p of plans) console.log(`${p.id.padEnd(width)}  ${p.route.padEnd(5)}  ${p.slug.padEnd(34)}  ${p.reason}`);
  const counts = ROUTES.map((r) => `${r} ${plans.filter((p) => p.route === r).length}`).join(", ");
  console.log(`\n${plans.length} article(s): ${counts}`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  let plans = planAll(options);
  if (options.routes.size) plans = plans.filter((p) => options.routes.has(p.route));
  plans = plans.slice(0, options.limit);
  console.log(`DATA_HOME: ${DATA_HOME}${process.env.ARTICLE_JSON_DATA_HOME ? " (ARTICLE_JSON_DATA_HOME)" : ""}`);
  if (options.dryRun) {
    printPlan(plans);
    console.log("\nDry run: nothing was written.");
    return;
  }

  // 旧データは読むだけで書き換えないが、本番では念のため丸ごとコピーしておく。
  // ARTICLE_JSON_DATA_HOME で箱のコピーに書くリハーサルでは、Dropbox に同じコピーを増やさない。
  const rehearsal = !!process.env.ARTICLE_JSON_DATA_HOME;
  const backup = rehearsal ? null : backupLegacy();
  console.log(backup ? `Backup: ${path.relative(PATHS.outputDir, backup)}` : "Backup: skipped (rehearsal with ARTICLE_JSON_DATA_HOME)");
  const outcomes: Outcome[] = [];
  let stopped: string | undefined;
  for (const plan of plans) {
    process.stdout.write(`▶ ${plan.id} [${plan.route}] `);
    try {
      const outcome = migrate(plan, options);
      outcomes.push(outcome);
      const c = outcome.comparison;
      console.log(c ? `→ ${outcome.canonicalId}${outcome.fallback ? " (json fallback)" : ""}  body ${c.covered}/${c.current.body.length}, missing ${c.missing.length}${c.missingTables.length ? `, tables not found: ${c.missingTables.join(", ")}` : ""}` : `kept (${plan.reason})`);
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      outcomes.push({ plan, route: plan.route, warnings: [], error: message });
      console.log(`✗ ${message}`);
      if (/^Alias "/.test(message)) {
        stopped = `${plan.id}: ${message}`;
        break;
      }
    }
  }
  updateCorpus();
  const date = localDate();
  const report = options.report ?? path.join(PATHS.outputDir, `${date}_canonical移行レポート${rehearsal ? "（リハーサル）" : ""}.md`);
  writeReport(report, outcomes, backup, stopped);
  console.log(`\nReport: ${report}`);
  if (stopped) {
    console.error(`Stopped: ${stopped}`);
    process.exit(1);
  }
}

try {
  main();
} catch (e) {
  console.error(String((e as Error)?.message ?? e));
  process.exit(1);
}

