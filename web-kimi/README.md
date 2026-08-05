# Reference Abstract RAG (Kimi版)

論文ページのHTMLから参考文献リンクを拾い、PubMedのPMID/abstractを取得してJSON化し、そのabstractだけを対象にLlamaIndex.TSで検索するローカルWebアプリ。

`../web`（OpenAI版）と同じコードベースのフォークで、回答生成LLMをKimi(Moonshot)に差し替え、JA→EN自動翻訳機能を削除して完全英語化した版。embeddingは引き続きOpenAIを使用する。ポートを変えてあるので両方同時に起動できる。

## 想定ワークフロー

1. 制限付き論文をログイン済みブラウザで開く。
2. Web UIの `ORS Import` ブックマークレットをChromeのブックマークバーに登録する。
3. 論文ページを開いた状態でブックマークレットを実行し、主論文JSONとReference JSONを作る。
4. 作成されたreference setに対して日本語または英語で検索する。

サーバ側のURL取得も使えますが、ログインCookieは共有されないため、制限付き記事ではHTMLファイル/貼り付けが主経路です。
ブックマークレットはログイン済みChromeの現在DOMを `http://localhost:5174/api/import/ors` に送るため、制限付き記事ではこちらが推奨経路です。

## ORSブックマークレット

1. `npm run dev` でAPIサーバとWeb UIを起動する。
2. Web UI上部の `ORS Import` をブックマークバーへドラッグする。クリックした場合はJavaScript URLがクリップボードにコピーされる。
3. ORSの論文ページをChromeで開き、登録した `ORS Import` を実行する。
4. 完了後、Web UIで「一覧を更新」し、作成された主論文JSONを選択する。

ブックマークレットの送信先ポートは `web/` 版と異なる（下記「実行」参照）。

## 主なファイル

| ファイル | 役割 |
|---|---|
| `src/server/referenceHarvester.ts` | HTMLから参考文献候補を抽出し、PubMed E-utilitiesでPMID/abstractを取得してJSON保存 |
| `src/server/referenceRag.ts` | 保存済みreference setをabstract単位のDocumentにしてLlamaIndex検索 |
| `src/server/server.ts` | Express API |
| `src/client/App.tsx` | React UI |

保存先（gitリポジトリ外。Dropbox同期で他端末と共有する。`web/` 版と同じ場所を参照するため、収集済みの論文/参考文献データはそのまま共有される）:

```text
<Obsidian>/50_coding/llamaindex/reference_sets   # 参考文献セット JSON
<Obsidian>/50_coding/llamaindex/article_sets     # 主論文セット JSON
<Obsidian>/50_coding/llamaindex/raw_html         # 取り込み時の入力HTML（再現性確保・パーサ検証用）
<Obsidian>/50_coding/llamaindex/storage_all_ts_kimi  # ベクトルindex（web版のstorage_all_tsとは別ディレクトリ）
```

`<Obsidian>` は `config.ts` が自動解決する（Windows: `~/Dropbox/obsidian`、Mac: `~/Library/CloudStorage/Dropbox/obsidian`）。
環境変数 `OBSIDIAN_DIR` で明示指定も可能。

## 実行

```bash
cd web-kimi
npm install
npm run dev
```

UI:

```text
http://localhost:5273
```

API:

```text
http://localhost:5176
```

必要な環境変数（リポジトリ直下の `.env` または `web-kimi/.env`）:

```text
OPENAI_API_KEY=...           # embedding用（text-embedding-3-large）
KIMI_API_KEY=...             # 回答生成LLM用（Moonshot）
KIMI_BASE_URL=https://api.moonshot.ai/v1   # 省略時のデフォルト値
KIMI_MODEL=kimi-k3            # 省略時のデフォルト値
```

`web/` 版で使っていた `.env` に `KIMI_API_KEY` を追記すれば、`OPENAI_API_KEY` も含めてそのまま両版で共有できる。

## JA→EN翻訳機能について

`web/`（OpenAI版）はクエリが日本語かどうかを自動判定して英訳してから検索する機能があるが、この版では削除済み。クエリは常にそのまま検索に使われるため、英語で入力する。

## 旧RXFP1 RAG

既存の全論文RAG用コードは `src/server/rag.ts`、`buildJson.ts`、`buildIndex.ts` などに残しています。Reference Abstract RAGとはAPIとUIを分けてあります。
