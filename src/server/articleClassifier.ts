// 主論文を PubMed の Publication Type で Original / Review に分類し、論文JSONに書き込む。
// 取り込み時に1本ずつ、サーバ起動時に未確認の論文をまとめて分類する。
// PubMed に無い論文（プレプリント・原稿など）は articleType を null にして、確認済みとして記録する。
// 手で種別を付けた論文（articleTypeSource: "manual"）は上書きしない。
import fs from "node:fs";
import { articleSetPath, listArticleSets, loadArticleSet } from "./articleHarvester.js";
import { findPubmedRecord } from "./referenceHarvester.js";
import { classifyMainArticle } from "../shared/articleType.js";

export async function classifyArticle(id: string) {
  const set = loadArticleSet(id);
  if (set.articleTypeSource === "manual") return set;
  const record = await findPubmedRecord(set.doi, set.title);
  set.pmid = record?.pmid ?? "";
  set.publicationTypes = record?.publicationTypes ?? [];
  set.articleType = record ? classifyMainArticle(record.publicationTypes) : null;
  set.articleTypeSource = "pubmed";
  set.pubmedCheckedAt = new Date().toISOString();
  fs.writeFileSync(articleSetPath(set.id), JSON.stringify(set, null, 2), "utf-8");
  return set;
}

// 通信エラーの論文は確認済みにせず、次の起動で再試行する。
export async function classifyUncheckedArticles(): Promise<void> {
  const unchecked = listArticleSets().filter((summary) => !loadArticleSet(summary.id).pubmedCheckedAt);
  for (const { id } of unchecked) {
    try {
      const set = await classifyArticle(id);
      console.log(`[classify] ${id}: ${set.articleType ?? "not in PubMed"}${set.pmid ? ` (PMID ${set.pmid})` : ""}`);
    } catch (e: any) {
      console.warn(`[classify] ${id}: ${String(e?.message ?? e)}`);
    }
  }
}
