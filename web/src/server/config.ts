// パス・モデル設定（Python版と同じ場所を参照）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

// リポジトリ直下の .env（OPENAI_API_KEY）を読み込む
dotenv.config({ path: path.resolve(import.meta.dirname, "../../../.env") });
// web/.env があれば上書き
dotenv.config({ path: path.resolve(import.meta.dirname, "../../.env") });

const HOME = os.homedir();

// Obsidianルートをクロスプラットフォームで解決する。
// Windows: ~/Dropbox/obsidian、Mac: ~/Library/CloudStorage/Dropbox/obsidian。
// 環境変数 OBSIDIAN_DIR で明示指定も可能。
function resolveObsidianDir(): string {
  if (process.env.OBSIDIAN_DIR) return process.env.OBSIDIAN_DIR;
  const candidates = [
    path.join(HOME, "Dropbox", "obsidian"),
    path.join(HOME, "Library", "CloudStorage", "Dropbox", "obsidian"),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? candidates[0];
}

const OBSIDIAN = resolveObsidianDir();
const CODING = path.join(OBSIDIAN, "50_coding");
const BASE = path.join(CODING, "llamaindex");
// 文献データ（reference_sets / article_sets / raw_html）は pubmed_mcp 配下に集約する。
// gitリポジトリ外（Dropbox同期）に置くことで、コードと文献データを分離する。
const PUBMED = path.join(CODING, "pubmed_mcp");

export const PATHS = {
  mdSourceDir: path.join(OBSIDIAN, "10_article", "RXFP1"),
  articlesJson: path.join(BASE, "articles_all3.json"),
  storageAll: path.join(BASE, "storage_all_ts"),
  outputDir: BASE,
  referenceOutputDir: path.join(PUBMED, "reference_sets"),
  articleOutputDir: path.join(PUBMED, "article_sets"),
  rawHtmlDir: path.join(PUBMED, "raw_html"),
};

export const MODELS = {
  llm: "gpt-5.4-mini",
  embed: "text-embedding-3-large",
  translate: "gpt-4o-mini",
};

// 検索対象から除外するセクションタイプ（Python版 40 と一致）
export const EXCLUDE_FROM_INDEX = new Set([
  "references",
  "acknowledgements",
  "abbreviations",
  "keywords",
  "other",
]);
