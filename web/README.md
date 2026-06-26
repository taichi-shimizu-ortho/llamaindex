# Reference Abstract RAG

論文ページのHTMLから参考文献リンクを拾い、PubMedのPMID/abstractを取得してJSON化し、そのabstractだけを対象にLlamaIndex.TSで検索するローカルWebアプリ。

## 想定ワークフロー

1. 制限付き論文をログイン済みブラウザで開く。
2. ページHTMLを保存するか、References周辺のHTMLをコピーする。
3. Web UIにHTMLファイルまたはHTMLテキストを渡してJSONを作る。
4. 作成されたreference setに対して日本語または英語で検索する。

サーバ側のURL取得も使えますが、ログインCookieは共有されないため、制限付き記事ではHTMLファイル/貼り付けが主経路です。

## 主なファイル

| ファイル | 役割 |
|---|---|
| `src/server/referenceHarvester.ts` | HTMLから参考文献候補を抽出し、PubMed E-utilitiesでPMID/abstractを取得してJSON保存 |
| `src/server/referenceRag.ts` | 保存済みreference setをabstract単位のDocumentにしてLlamaIndex検索 |
| `src/server/server.ts` | Express API |
| `src/client/App.tsx` | React UI |

保存先:

```text
~/Library/CloudStorage/Dropbox/obsidian/50_coding/llamaindex/reference_sets
```

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
