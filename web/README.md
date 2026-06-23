# RXFP1 文献検索 (TypeScript / LlamaIndex.TS)

Python パイプライン（30→40→52）を TypeScript に作り替えたローカル Web アプリ。
**JSON 構造化の原理は Python 版と完全一致**（全92件バイトレベル検証済み）。

## アーキテクチャ

| ファイル | 対応する Python | 役割 |
|---|---|---|
| `src/server/parse.ts` | `30_batch_convert_articles.py` | MD → 構造化JSON（frontmatter / Info block / Main Text を h2/h3 で section・subsection 分割、type分類、review判定） |
| `src/server/documents.ts` | `40_*`（Document化部） | 構造化JSON → 段落単位 Document（regular/review別、除外type） |
| `src/server/buildIndex.ts` | `40_build_all_articles_index.py` | Document → OpenAI埋め込み → ベクトルIndex永続化 |
| `src/server/rag.ts` | `52_gui_rxfp1.py`（検索部） | 日本語→英語翻訳 → ベクトル検索 → 回答合成 → 引用元整形 |
| `src/server/server.ts` | — | Express API |
| `src/client/` | `52_gui_rxfp1.py`（GUI部） | React UI（tkinter置き換え） |

## セットアップ

```bash
cd web
npm install
```

`OPENAI_API_KEY` はリポジトリ直下の `.env` を自動読み込み（`web/.env` でも上書き可）。

パス（`src/server/config.ts`）:
- MD入力: `~/Dropbox/obsidian/10_article/RXFP1`
- 構造化JSON: `~/Dropbox/obsidian/50_coding/llamaindex/articles_all3.json`
- ベクトルIndex: `~/Dropbox/obsidian/50_coding/llamaindex/storage_all_ts`（Python版 `storage_all` とは別ディレクトリ）

## 実行手順

```bash
npm run convert       # MD → 構造化JSON（step 30 相当・無料）
npm run build-index   # JSON → ベクトルIndex（step 40 相当・OpenAI課金あり）
npm run dev           # APIサーバ + Vite を同時起動 → http://localhost:5173
```

本番配信:
```bash
npm run build:client  # dist/ を生成
npm run start         # Express が API と dist/ を配信（http://localhost:5174）
```

## メモ

- ベクトルストアは LlamaIndex.TS 形式で、Python版の `storage_all` とは互換でないため `build-index` で作り直す。
- 検索は単一の「All Articles」インデックス。UI でセクションタイプ別フィルタ・スコアバー・DOI/PubMedリンク・対話のMarkdown保存に対応。
