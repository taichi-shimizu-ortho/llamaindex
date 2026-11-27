// 正本（article-ingest の Article JSON、<DATA_HOME>/articles/*.json）を llamaindex の
// ArticleSet / ReferenceSet として読む。正本は 50_article-json と共有なので、ここからは
// 分類（classification と meta.pmid）以外を書き換えない。
// どの論文を正本から読み、どれを article_sets/ から読むかは articleHarvester.ts の catalog が決める。
import fs from "node:fs";
import path from "node:path";
import { dirFor } from "article-ingest/paths";
import { toArticleSet, toReferenceSet } from "article-ingest/projection";
import type { Article } from "article-ingest/types";
import type { ArticleSet } from "./articleHarvester.js";
import type { ReferenceSet } from "./referenceHarvester.js";

// 図は <DATA_HOME>/figures/<正本id>/<file> にある。server.ts が読み取り専用で配信する。
export const CANONICAL_FIGURE_ROUTE = "/canonical-figures";

export function canonicalFiguresDir(): string {
  return dirFor("figures");
}

export function doiKey(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "");
}

export interface CanonicalEntry {
  canonicalId: string;
  file: string;
  mtimeMs: number;
  doi: string;
  aliases: string[];
  article: Article;
}

let cache: { stamp: string; entries: CanonicalEntry[] } | null = null;

// ファイル名と更新時刻が変わらない限り読み直さない（一覧のたびに全件 JSON を解析しない）。
export function canonicalEntries(): CanonicalEntry[] {
  const dir = dirFor("articles");
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const stats = names.map((name) => {
    const file = path.join(dir, name);
    try {
      return { file, mtimeMs: fs.statSync(file).mtimeMs };
    } catch {
      return { file, mtimeMs: -1 };
    }
  });
  const stamp = stats.map((s) => `${s.file}:${s.mtimeMs}`).join("|");
  if (cache?.stamp === stamp) return cache.entries;

  const entries: CanonicalEntry[] = [];
  for (const { file, mtimeMs } of stats) {
    try {
      const article = JSON.parse(fs.readFileSync(file, "utf-8")) as Article;
      if (!article?.id || !article.meta) continue;
      entries.push({
        canonicalId: article.id,
        file,
        mtimeMs,
        doi: doiKey(article.meta.doi),
        aliases: article.aliases ?? [],
        article,
      });
    } catch (e) {
      console.warn(`[canonical] skipped ${path.basename(file)}: ${String((e as Error)?.message ?? e)}`);
    }
  }
  cache = { stamp, entries };
  return entries;
}

// llamaindex の ArticleSet として読む。id は呼び出し側が決めた引用キー（aliases[0] か旧 article_sets の id）。
export function projectCanonical(entry: CanonicalEntry, id: string): ArticleSet {
  const projected = toArticleSet(entry.article, {
    id,
    figureUrl: (article, file) =>
      `${CANONICAL_FIGURE_ROUTE}/${encodeURIComponent(article.id)}/${encodeURIComponent(file)}`,
  });
  const checkedAt = entry.article.classification?.checkedAt;
  return { ...projected, ...(checkedAt ? { pubmedCheckedAt: checkedAt } : {}) } as ArticleSet;
}

// 参考文献。PubMed の abstract・MeSH は正本にまだ無いので、旧 reference_sets/<id>.json があれば
// DOI か PMID で突き合わせて pubmed を重ねる（RAG の抄録根拠と Preview の文献表示が今までどおり出る）。
export function canonicalReferenceSet(entry: CanonicalEntry, id: string, legacy?: ReferenceSet): ReferenceSet {
  const projected = toReferenceSet(entry.article, { id }) as unknown as ReferenceSet;
  if (!legacy?.records?.length) return { ...projected, doi: entry.article.meta.doi ?? "" };
  const byDoi = new Map<string, ReferenceSet["records"][number]>();
  const byPmid = new Map<string, ReferenceSet["records"][number]>();
  for (const record of legacy.records) {
    const doi = doiKey(record.doi || record.pubmed?.doi);
    const pmid = record.pmid || record.pubmed?.pmid || "";
    if (doi) byDoi.set(doi, record);
    if (pmid) byPmid.set(pmid, record);
  }
  const records = projected.records.map((record) => {
    const match = byDoi.get(doiKey(record.doi)) ?? (record.pmid ? byPmid.get(record.pmid) : undefined);
    if (!match?.pubmed) return record;
    return {
      ...record,
      pmid: record.pmid || match.pubmed.pmid,
      doi: record.doi || match.pubmed.doi,
      pubmedFound: true,
      pubmed: match.pubmed,
    };
  });
  return {
    ...projected,
    doi: entry.article.meta.doi ?? "",
    records,
    pubmedFound: records.filter((r) => r.pubmedFound).length,
    abstractFound: records.filter((r) => r.pubmed?.abstract?.trim()).length,
  };
}

// PubMed での分類を正本に書く。該当の2項目（classification と meta.pmid）だけを書き換え、
// ほかの項目と書式（2スペースのインデント、末尾の改行）はそのまま残す。
export function writeCanonicalClassification(
  entry: CanonicalEntry,
  classification: NonNullable<Article["classification"]>,
  pmid: string,
): void {
  const raw = fs.readFileSync(entry.file, "utf-8");
  const article = JSON.parse(raw) as Article;
  article.classification = classification;
  if (pmid) article.meta.pmid = pmid;
  const tmp = `${entry.file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(article, null, 2) + (raw.endsWith("\n") ? "\n" : ""), "utf-8");
  fs.renameSync(tmp, entry.file);
}
