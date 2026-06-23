// [STEP 40 移植] 構造化JSON → 段落単位Document → ベクトルIndex永続化
import fs from "node:fs";
import { Settings, VectorStoreIndex, storageContextFromDefaults } from "llamaindex";
import { OpenAI, OpenAIEmbedding } from "@llamaindex/openai";
import { PATHS, MODELS } from "./config.js";
import { createSectionDocuments, isReviewArticle } from "./documents.js";
import type { ArticlesFile } from "../shared/types.js";

export async function buildAndSaveIndex(jsonFile = PATHS.articlesJson, storageDir = PATHS.storageAll) {
  Settings.llm = new OpenAI({ model: MODELS.llm, temperature: 0.1 });
  Settings.embedModel = new OpenAIEmbedding({ model: MODELS.embed });
  // 段落単位でDocument化済みのため自動チャンク分割を抑制
  Settings.chunkSize = 8192;
  Settings.chunkOverlap = 0;

  console.log(`[*] JSONファイルを読み込み中: ${jsonFile}`);
  const data: ArticlesFile = JSON.parse(fs.readFileSync(jsonFile, "utf-8"));
  const articles = data.articles || [];
  console.log(`[OK] ${articles.length}件の論文を読み込みました`);

  const reviewCount = articles.filter(isReviewArticle).length;
  console.log(`    regular: ${articles.length - reviewCount}件 / review: ${reviewCount}件`);

  const documents = createSectionDocuments(articles);
  console.log(`[OK] ${documents.length}個のDocumentを作成（段落単位）`);

  // セクションタイプ分布
  const dist: Record<string, number> = {};
  for (const d of documents) {
    const st = (d.metadata.section_type as string) || "unknown";
    dist[st] = (dist[st] || 0) + 1;
  }
  console.log("\nセクションタイプ分布（Document数）:");
  for (const [st, c] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${st}: ${c}件`);
  }

  // 既存インデックス削除
  if (fs.existsSync(storageDir)) {
    console.log(`\n[*] 既存インデックスを削除: ${storageDir}`);
    fs.rmSync(storageDir, { recursive: true, force: true });
  }

  console.log("\n[*] ベクトルインデックスを構築中（OpenAI embeddingを生成します）...");
  const storageContext = await storageContextFromDefaults({ persistDir: storageDir });
  await VectorStoreIndex.fromDocuments(documents, { storageContext });
  console.log("[OK] インデックス構築・保存完了");
  console.log(`保存先: ${storageDir}`);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  console.log("=".repeat(80));
  console.log("全論文インデックス構築ツール (TS / LlamaIndex.TS)");
  console.log("=".repeat(80));
  if (!fs.existsSync(PATHS.articlesJson)) {
    console.error(`[!] ${PATHS.articlesJson} が見つかりません。先に npm run convert を実行してください`);
    process.exit(1);
  }
  buildAndSaveIndex()
    .then(() => {
      console.log("\n完了！ npm run dev で検索UIを起動できます");
    })
    .catch((e) => {
      console.error(`[!] エラー: ${e?.stack ?? e}`);
      process.exit(1);
    });
}
