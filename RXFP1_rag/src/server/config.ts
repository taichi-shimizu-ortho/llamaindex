// パス・モデル設定（Python版と同じ場所を参照）
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

// RXFP1_rag/.env（OPENAI_API_KEY）を読み込む
dotenv.config({ path: path.resolve(import.meta.dirname, "../../.env") });
// リポジトリ直下の .env があれば上書き
dotenv.config({ path: path.resolve(import.meta.dirname, "../../../.env") });

const HOME = os.homedir();
const BASE = path.join(HOME, "Library", "CloudStorage", "Dropbox", "obsidian", "50_coding", "llamaindex");

export const PATHS = {
  mdSourceDir: path.join(HOME, "Library", "CloudStorage", "Dropbox", "obsidian", "10_article", "RXFP1"),
  articlesJson: path.join(BASE, "articles_all3.json"),
  storageAll: path.join(BASE, "storage_all_ts"),
  outputDir: BASE,
};

export const MODELS = {
  llm: "gpt-4o-mini",
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
