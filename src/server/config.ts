// パス・モデル設定
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

const ROOT = path.resolve(import.meta.dirname, "../..");
// リポジトリ直下の .env（OPENAI_API_KEY / ANTHROPIC_API_KEY）を読み込む
dotenv.config({ path: path.join(ROOT, ".env") });

export function resolveObsidianDir(
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.OBSIDIAN_DIR) return env.OBSIDIAN_DIR;
  const infoFiles = platform === "win32"
    ? [env.LOCALAPPDATA, env.APPDATA].filter(Boolean).map((dir) => path.join(dir!, "Dropbox", "info.json"))
    : [path.join(home, ".dropbox", "info.json")];
  const configured: string[] = [];
  for (const file of infoFiles) {
    try {
      const info = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const account of [info?.personal, info?.business]) {
        if (typeof account?.path === "string" && path.isAbsolute(account.path)) {
          configured.push(path.join(account.path, "obsidian"));
        }
      }
    } catch {
      // Dropbox may not be installed or its configuration may be unreadable.
    }
  }
  const local = path.join(home, "Dropbox", "obsidian");
  const fallback = platform === "darwin" ? [local, path.join(home, "Library", "CloudStorage", "Dropbox", "obsidian")] : [local];
  return configured.find((dir) => fs.existsSync(dir)) ?? configured[0]
    ?? fallback.find((dir) => fs.existsSync(dir)) ?? local;
}

const OBSIDIAN = resolveObsidianDir();
const CODING = path.join(OBSIDIAN, "50_coding");
const BASE = path.join(CODING, "llamaindex");
// 文献データ（reference_sets / article_sets / raw_html）は llamaindex 配下に集約する。
// Dropbox同期されるObsidianルート配下に置くことで、複数端末で共有する。

export const PATHS = {
  outputDir: BASE,
  manuscriptReviewDir: process.env.MANUSCRIPT_REVIEW_DIR || BASE,
  manuscriptLiteratureFile: process.env.MANUSCRIPT_LITERATURE_FILE,
  manuscriptReader: path.join(ROOT, "scripts", "read-manuscript.py"),
  manuscriptPython: process.env.MANUSCRIPT_PYTHON || (process.platform === "win32"
    ? path.join(ROOT, ".venv", "Scripts", "python.exe") : path.join(ROOT, ".venv", "bin", "python")),
  referenceOutputDir: path.join(BASE, "reference_sets"),
  articleOutputDir: path.join(BASE, "article_sets"),
  rawHtmlDir: path.join(BASE, "raw_html"),
  // CLI 取り込み（npm run ingest）で保存した MHTML の原本。<DOI>.mhtml で置く。
  mhtmlDir: path.join(BASE, "mhtml"),
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
