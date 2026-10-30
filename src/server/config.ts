// パス・モデル設定
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

// リポジトリ直下の .env（OPENAI_API_KEY / ANTHROPIC_API_KEY）を読み込む
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
// 文献データ（reference_sets / article_sets / raw_html）は llamaindex 配下に集約する。
// Dropbox同期されるObsidianルート配下に置くことで、複数端末で共有する。

export const PATHS = {
  outputDir: BASE,
  referenceOutputDir: path.join(BASE, "reference_sets"),
  articleOutputDir: path.join(BASE, "article_sets"),
  rawHtmlDir: path.join(BASE, "raw_html"),
  // ドキュメント選択画面のフォルダ構成（フォルダ定義と文献の振り分け）。
  libraryFile: path.join(BASE, "library.json"),
  // 埋め込みベクトルのキャッシュ（再起動時の再埋め込みを避ける）。
  // Dropbox同期のBASE配下に置くことで複数端末でも再埋め込み不要。
  embeddingCacheDir: path.join(BASE, "embeddings_cache"),
};

export const MODELS = {
  // 回答生成は Claude（ANTHROPIC_API_KEY）。埋め込みと翻訳は OpenAI（OPENAI_API_KEY）。
  llm: "claude-sonnet-5-5",
  embed: "text-embedding-3-small",
  translate: "gpt-5.6-terra",
};
