// [STEP 30 移植] MDディレクトリ → 構造化JSON 一括変換
import fs from "node:fs";
import path from "node:path";
import { convertArticle } from "./parse.js";
import { PATHS } from "./config.js";
import type { Article, ArticlesFile } from "../shared/types.js";

export function batchConvert(inputDir = PATHS.mdSourceDir, outputFile = PATHS.articlesJson): ArticlesFile {
  if (!fs.existsSync(inputDir)) {
    throw new Error(`ディレクトリが見つかりません: ${inputDir}`);
  }
  const mdFiles = fs
    .readdirSync(inputDir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  if (mdFiles.length === 0) {
    throw new Error(`マークダウンファイルが見つかりません: ${inputDir}`);
  }

  console.log(`[*] ${mdFiles.length} 個のファイルを処理します...`);
  console.log("-".repeat(80));

  const articles: Article[] = [];
  const failed: { filename: string; error: string }[] = [];

  mdFiles.forEach((name, i) => {
    try {
      console.log(`[${i + 1}/${mdFiles.length}] 処理中: ${name}`);
      const content = fs.readFileSync(path.join(inputDir, name), "utf-8");
      const article = convertArticle(content, name);
      articles.push(article);
      const label = article.is_review ? "review" : "original";
      console.log(`    [OK] ${article.sections.length} セクション | ${label}`);
    } catch (e: any) {
      failed.push({ filename: name, error: String(e?.message ?? e) });
      console.log(`    [!] エラー: ${e?.message ?? e}`);
    }
  });

  console.log("-".repeat(80));
  console.log(`\n[完了] 成功: ${articles.length} 個 / 失敗: ${failed.length} 個`);
  if (failed.length) {
    console.log("\n失敗したファイル:");
    failed.forEach((f) => console.log(`  - ${f.filename}: ${f.error}`));
  }

  const result: ArticlesFile = {
    articles,
    metadata: {
      total_count: articles.length,
      failed_count: failed.length,
      source_directory: inputDir,
      failed_files: failed,
    },
  };

  fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), "utf-8");
  const sizeMB = fs.statSync(outputFile).size / 1024 / 1024;
  console.log(`\n[保存完了] ${outputFile}`);
  console.log(`合計サイズ: ${sizeMB.toFixed(2)} MB`);
  return result;
}

// CLI 実行
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const inputDir = process.argv[2] || PATHS.mdSourceDir;
  const outputFile = process.argv[3] || PATHS.articlesJson;
  console.log("=".repeat(80));
  console.log("一括変換ツール (TS): MD → 構造化JSON");
  console.log("=".repeat(80));
  console.log(`入力: ${inputDir}`);
  console.log(`出力: ${outputFile}`);
  console.log("=".repeat(80) + "\n");
  try {
    batchConvert(inputDir, outputFile);
    console.log("\n次のステップ: npm run build-index");
  } catch (e: any) {
    console.error(`\n[!] 致命的エラー: ${e?.message ?? e}`);
    process.exit(1);
  }
}
