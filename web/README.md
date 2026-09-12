# Reference Abstract RAG

論文ページのHTMLから参考文献リンクを拾い、PubMedのPMID/abstractを取得してJSON化し、そのabstractだけを対象にLlamaIndex.TSで検索するローカルWebアプリ。

## 想定ワークフロー

1. 制限付き論文をログイン済みブラウザで開く。
2. Web UIの `ORS Import` ブックマークレットをChromeのブックマークバーに登録する。
3. 論文ページを開いた状態でブックマークレットを実行し、主論文JSONとReference JSONを作る。
4. `Documents` 画面で取り込んだ文献をフォルダに整理し、対象を選んで `Open in RAG`。
5. `RAG` 画面で、その文献に対して検索する。

サーバ側のURL取得も使えますが、ログインCookieは共有されないため、制限付き記事ではHTMLファイル/貼り付けが主経路です。
ブックマークレットはログイン済みChromeの現在DOMを `http://localhost:5174/api/import/ors` に送るため、制限付き記事ではこちらが推奨経路です。

## ORSブックマークレット

1. `npm run dev` でAPIサーバとWeb UIを起動する。
2. Web UI上部の `ORS Import` をブックマークバーへドラッグする。クリックした場合はJavaScript URLがクリップボードにコピーされる。
3. ORSの論文ページをChromeで開き、登録した `ORS Import` を実行する。
4. 完了後、`Documents` 画面の `Refresh` を押し、作成された主論文JSONをフォルダに振り分けて `Open in RAG`。

## 画面構成

UIは2画面に分かれている。上部のナビゲーション（`Documents` / `RAG`）で切り替える。

### 1. Documents（ドキュメント選択・取り込み）

- **Import**: 論文URLを入力するか、ログイン済みブラウザからコピーしたHTMLを貼り付けて取り込む。`/api/import/ors` を叩き、主論文JSONと参考文献JSONを同時に作る。取り込み先フォルダをその場で指定できる。
- **Folders**: 文献をフォルダに整理する。フォルダは入れ子にでき、`All documents` / `Unfiled` と並んでツリー表示される。
  - `+ Folder` で作成、行の `+` でサブフォルダ作成、`✎` でリネーム、`×` で削除。
  - 削除するとサブフォルダも消えるが、**文献JSONそのものは消えず未分類（Unfiled）に戻る**。
  - 文献カードをフォルダ行へドラッグ＆ドロップで振り分ける（カードの `Folder` セレクトでも可）。フォルダ行を別のフォルダ行へドラッグすると階層を変更できる。`Unfiled` 行へのドロップは、文献なら未分類化、フォルダならトップレベルへの移動。
- **Documents**: フォルダ内の文献一覧。タイトル/IDでの絞り込み、参考文献abstractの取得状況の確認、`Open in RAG` でRAG画面へ。

フォルダ構成は `library.json`（下記「保存先」参照）に保存され、Dropbox同期で他端末とも共有される。文献JSON自体には一切書き込まない。

### 2. RAG（文献に対する検索）

Documents画面で選んだ主論文JSON（と自動で対応付いた参考文献JSON）に対して検索する。本文ブラウザ、引用番号のポップアップ、検索結果のソース表示、参考文献一覧はこの画面にまとまっている。画面を移動しても入力中の質問や検索結果は保持される。

## 主なファイル

| ファイル | 役割 |
|---|---|
| `src/server/referenceHarvester.ts` | HTMLから参考文献候補を抽出し、PubMed E-utilitiesでPMID/abstractを取得してJSON保存 |
| `src/server/referenceRag.ts` | 保存済みreference setをabstract単位のDocumentにしてLlamaIndex検索 |
| `src/server/server.ts` | Express API |
| `src/server/library.ts` | フォルダ構成（library.json）の読み書き。ネスト・循環チェック・削除時の未分類化 |
| `src/client/App.tsx` | 画面シェル（Documents / RAG の切り替え、データ読み込み） |
| `src/client/LibraryScreen.tsx` | ドキュメント選択・取り込み画面（フォルダツリー、Import、文献カード） |
| `src/client/RagScreen.tsx` | ドキュメントRAG画面（検索、回答、ソース、参考文献一覧） |

保存先（gitリポジトリ外。Dropbox同期で他端末と共有する）:

```text
<Obsidian>/50_coding/pubmed_mcp/reference_sets   # 参考文献セット JSON
<Obsidian>/50_coding/pubmed_mcp/article_sets     # 主論文セット JSON
<Obsidian>/50_coding/pubmed_mcp/raw_html         # 取り込み時の入力HTML（再現性確保・パーサ検証用）
<Obsidian>/50_coding/pubmed_mcp/library.json     # ドキュメント選択画面のフォルダ構成
```

`<Obsidian>` は `config.ts` が自動解決する（Windows: `~/Dropbox/obsidian`、Mac: `~/Library/CloudStorage/Dropbox/obsidian`）。
環境変数 `OBSIDIAN_DIR` で明示指定も可能。

## 実行

```bash
cd web
npm install
npm run dev
```

UI:

```text
http://localhost:5173
```

API:

```text
http://localhost:5174
```

`OPENAI_API_KEY` はリポジトリ直下の `.env` または `web/.env` から読み込みます。

## 旧RXFP1 RAG

既存の全論文RAG用コードは `src/server/rag.ts`、`buildJson.ts`、`buildIndex.ts` などに残しています。Reference Abstract RAGとはAPIとUIを分けてあります。
