# web-kimi（アーカイブ）

`web/` のフォークで、回答生成 LLM を Kimi（Moonshot）に差し替えた版。2026-10-30 に運用を終了した。
ここには web との違い（エッセンス）だけを残す。

## 元に戻す

コード全体はタグ `archive/web-kimi`（コミット `6bb1b9b`）に残っている。

```bash
git checkout archive/web-kimi -- web-kimi
```

web に Kimi 版の変更を当てたいときは、`web-kimi.patch`（web → web-kimi の差分、24 ファイル）を使う。2026-10-30 時点の web に、そのまま適用できることを確認済み。

```bash
patch -p1 -d web < archive/web-kimi/web-kimi.patch
```

git で管理していなかったファイルは、リポジトリの外に移してある（`.env` を含むので、Dropbox やリポジトリには入れていない）。

```text
~/uv-envs/_archive/llamaindex-web-kimi-untracked-20261030/
  .env                         KIMI_API_KEY / KIMI_BASE_URL / KIMI_MODEL / OPENAI_API_KEY / SPRINGER_API_KEY
  debug_arthroscopy*.ts など   Arthroscopy 誌の取り込みを調べたときの使い捨てスクリプト
  arthroscopy1_raw.html, arthroscopy_out.json
```

## Kimi 版としての違い（運用を止めたので不要）

| 項目 | web | web-kimi |
|---|---|---|
| 回答生成 LLM | OpenAI（`gpt-5.6-terra`） | Kimi（`KIMI_MODEL`、既定 `kimi-k3`）。`OpenAIClient({ apiKey: KIMI_API_KEY, baseURL: KIMI_BASE_URL })` で OpenAI 互換 API として呼ぶ |
| embedding | OpenAI | OpenAI（同じ） |
| JA→EN 翻訳 | あり（UI のチェックボックス） | なし（サーバ側で `translate: false` に固定し、UI からも削除） |
| ポート | UI 5173 / API 5174 | UI 5273 / API 5176 |
| 表示名 | Reference Abstract RAG | Reference Abstract RAG (Kimi)、`Kimi K3` バッジ |
| データの保存先 | Obsidian の `50_coding/llamaindex/` | 同じ（収集データは両版で共有していた） |

関係するファイルは `config.ts`（`KIMI`）、`articleRag.ts` / `referenceRag.ts` / `integratedRag.ts`（LLM クライアント）、`server.ts`、`RagScreen.tsx`、`App.tsx`、`vite.config.ts`、`scripts/dev.mjs`。

## web にない機能（移植の候補）

「同じ仕様にする」という取り決めがあったが、次の機能は web-kimi にしか入っていなかった。必要になったら `web-kimi.patch` の該当部分を web に移す。

1. **DOI からオープンアクセス全文を取得する**（`src/server/doiHarvester.ts`, 230 行。コミット `74f2eb9`）
   - `POST /api/article/harvest-by-doi` に DOI だけを渡すと、出版社を判定し、PMC / Europe PMC（Springer は Springer Nature OA API）から JATS XML を取って本文 JSON を作る。
   - 取れなかったときは、出版社の URL を添えて「ブックマークレットで取り込む」よう案内を返す。
   - UI は `LibraryScreen.tsx` の「DOIから自動取得」パネル（`api.harvestByDoi`、型は `DoiHarvestResult`）。
   - Springer / BMC には `SPRINGER_API_KEY` が必要。
2. **JATS パーサの修正**（`sageJatsHarvester.ts`）
   - 表・図（`<table-wrap>` / `<fig>`）の中の `<p>` が、本文の段落として二重に取り込まれるのを防ぐ（`stripBlockElements`）。
   - `contrib-type="author"` を、内容ではなく開始タグの属性で判定する（web 版は判定を誤る）。
   - `journal-title` を `journal-meta` から取る。
3. **JATS がある場合の ID とタイトル**（`articleHarvester.ts`, `citationId.ts`）
   - JATS の第一著者と年から ID を作る（`authorYearId`）。取得元のページが bot 検査のページを返しても、ID とタイトルが壊れない。
4. **図の判定を広げる**（`scripts/extract_figures_from_mhtml.py`）
   - `id` に `fig` を含むもの、または `class="figure"` の `<figure>` も図として扱う（web 版は `id` が `fig` で始まるものだけ）。
5. **SAGE ブックマークレットのソース**（`public/sage-import-bookmarklet-source.js`）
   - ログイン中のブラウザで `/doi/full-xml/{doi}` から JATS XML を取り、HTML と一緒に `/api/import/ors` に送る。送り先は 5176 番なので、web で使うなら 5174 に変える。
