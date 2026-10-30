# Corpus RAG

論文ページのHTMLを主論文JSON（＋参考文献JSON）として取り込み、フォルダ／Zoteroコレクションで整理した
**複数の論文（10〜30本を想定）をまとめて段落単位で検索し、Claude に根拠付きで答えさせる**ローカルWebアプリ。

単一論文の Q&A はここではやらない。1本なら今の LLM に全文を渡すほうが確実なので、50_article-json 側の全文検索に任せている。
RAG を使うのは、本数が多く全文をそのまま渡せないときだけ、という切り分け。

旧 rxfp1（Python の全論文RAG）の「段落を1検索単位にし、論文メタデータを保持したままベクトル化する」考え方を引き継いでいる。
旧 Python パイプラインは `archive/rxfp1/` にある。

## 想定ワークフロー

1. 制限付き論文をログイン済みブラウザで開く。
2. Web UIの `ORS Import` ブックマークレットをChromeのブックマークバーに登録する。
3. 論文ページを開いた状態でブックマークレットを実行し、主論文JSONとReference JSONを作る。
4. `Documents` 画面の `Zotero` パネルでコレクション構成をフォルダとして同期する（手動フォルダでもよい）。
5. フォルダを開いて `Ask this folder (N) →` を押すと、そのフォルダ（既定でサブフォルダも含む）の論文全体を対象に `RAG` 画面で質問できる。
   1本ずつ足し引きしたいときは文献カードのチェックで手動選択に切り替える（`Ask N selected →`）。

サーバ側のURL取得も使えますが、ログインCookieは共有されないため、制限付き記事ではHTMLファイル/貼り付けが主経路です。
ブックマークレットはログイン済みChromeの現在DOMを `http://localhost:5174/api/import/ors` に送るため、制限付き記事ではこちらが推奨経路です。

## ORSブックマークレット

1. `npm run dev` でAPIサーバとWeb UIを起動する。
2. Web UI上部の `ORS Import` をブックマークバーへドラッグする。クリックした場合はJavaScript URLがクリップボードにコピーされる。
3. ORSの論文ページをChromeで開き、登録した `ORS Import` を実行する。
4. 完了後、`Documents` 画面の `Refresh` を押し、作成された主論文JSONをフォルダに振り分ける。

## 画面構成

UIは2画面に分かれている。上部のナビゲーション（`Documents` / `RAG`）で切り替える。

### 1. Documents（ドキュメント選択・取り込み）

- **Import**: 論文URLを入力するか、ログイン済みブラウザからコピーしたHTMLを貼り付けて取り込む。`/api/import/ors` を叩き、主論文JSONと参考文献JSONを同時に作る。取り込み先フォルダをその場で指定できる。
- **Folders**: 文献をフォルダに整理する。フォルダは入れ子にでき、`All documents` / `Unfiled` と並んでツリー表示される。
  - `+ Folder` で作成、行の `+` でサブフォルダ作成、`✎` でリネーム、`×` で削除。
  - 削除するとサブフォルダも消えるが、**文献JSONそのものは消えず未分類（Unfiled）に戻る**。
  - 文献カードをフォルダ行へドラッグ＆ドロップで振り分ける（カードの `Folder` セレクトでも可）。フォルダ行を別のフォルダ行へドラッグすると階層を変更できる。`Unfiled` 行へのドロップは、文献なら未分類化、フォルダならトップレベルへの移動。
- **Documents**: フォルダ内の文献一覧。タイトル/IDでの絞り込み、参考文献abstractの取得状況の確認。
  RAG の対象（corpus）の決め方は2通り:
  - **フォルダ単位（基本）**: フォルダを開いて `Ask this folder (N) →`。`Subfolders` のチェックで子孫フォルダを含めるか決める。
    対象はフォルダに紐づくので、Zotero を同期し直してコレクションの中身が変われば次の検索から追従する。
    30本を超えるフォルダでも検索はできるが、上位段落が一部の論文に偏りやすいので注意を出す。
  - **手動選択**: カードのチェックで付け外しする。フォルダ単位の対象でチェックを触ると、その時点の中身を起点にした手動選択に切り替わる。
  どちらもブラウザに記憶される。

フォルダ構成は `library.json`（下記「保存先」参照）に保存され、Dropbox同期で他端末とも共有される。文献JSON自体には一切書き込まない。

### Zotero連携（コレクション取り込み）

Documents画面の `Zotero` パネルから、Zoteroのコレクション構成をフォルダとして取り込める。
**Zotero 7 のローカルAPI**（`http://127.0.0.1:23119/api/users/0`）を読むだけで、APIキーもクラウド同期も不要。
Zotero側には一切書き込まない。

準備:

1. Zotero 7 を起動する。
2. 設定 > 詳細 > 「他のアプリケーションがこのコンピュータ上の Zotero と通信することを許可」を有効にする。

使い方:

1. `Zotero` パネルが `Connected`（コレクション数・アイテム数）になっていることを確認する。
2. `Sync collections` を押すとプレビューが出る。**この時点では何も書き込まれない**。
   新規フォルダ・リネーム・削除・文献の移動先が一覧できる。
3. 内容を確認して `Apply` で確定する。

同期の仕様:

- Zoteroのコレクション木がそのままフォルダ階層になる（`z_<コレクションkey>` というIDで固定。再同期しても同じフォルダを指す）。
- Zotero由来フォルダは `Z` バッジが付き、リネーム・削除・ドラッグ移動ができない（Zotero側が正）。
  手動で作ったフォルダはそのまま残り、これまでどおり編集できる。
- **1文献が複数コレクションに属する場合、置き場所（カードの `Folder`）はコレクションツリーの一番上（各階層を名前順に並べた深さ優先で最初）にするが、
  フォルダの一覧・件数・フォルダ単位の RAG では所属するすべてのコレクションに含める**（Zotero のサイドバーと同じ見え方）。
  所属は `library.json` の `zoteroFolders` に持ち、カードには「Also in …」と出る。レポートの「In several collections」でも確認できる。
  この仕様より前に同期した `library.json` には `zoteroFolders` が無いので、一度 `Sync collections` → `Apply` し直す。
- Zoteroでコレクションを消すと対応フォルダも消える。**文献JSONは消えず、未分類に戻るだけ**。
- Zotero側でどのコレクションにも入っていないアイテムは、こちらの振り分けを壊さずそのまま残す。
- 突き合わせは **DOI → Better BibTeX の citation key → タイトル** の順。対応が付いた文献には `Zotero` バッジが付く。
- Zoteroにあってアプリに取り込んでいない文献は「Not in this app」に出る（取り込みたい場合は上の Import から）。

接続先を変えたい場合（グループライブラリ、別ポート）は環境変数 `ZOTERO_API_BASE` を指定する。

### 2. RAG（複数論文の横断検索）

Documents で選んだフォルダ（または手動で選んだ論文）の本文を段落単位で横断検索し、上位の段落だけを Claude に渡して回答させる。
画面上部と保存する md の各回に、対象のスコープ（例 `Folder: Rxfp1 / Clinical (with subfolders)` / `Custom selection`）を出す。

- **索引の単位**: 1段落 = 1検索単位。各段落に論文メタデータ（引用ラベル・タイトル・著者・年・誌名・DOI）と構造メタデータ
  （節・小見出し・節の種類・段落番号）を持たせる。abstract は本文とほぼ同じ文で top-K を食いつぶすので除く（本文が無い論文だけ残す）。
  利益相反・著者貢献などの定型節も除く。
- **引用ラベル**: 論文JSONのID（取り込み時の連番 `-2` などを落としたもの。例 `Li2026`）。同名があれば `Li2026a` / `Li2026b`。
- **節の種類**: Intro / Methods / Results / Discussion / Conclusion / Figures / Tables / Other に揃える。
  取り込み元によって type が `body` や `other` のときは見出しから推定する。`Sections` チップで絞り込める。
- **Top-K / Per paper**: 回答に渡す段落数と、1論文から取る上限（0 = 上限なし）。1本の論文が上位を独占しないよう既定は 3。
- **回答**: Claude は根拠段落を `[S3]` / `[S2, S7]` で引用する。画面では論文ラベルのチップになり、ホバーで節・段落、クリックで該当段落へ飛ぶ。
  論文間で結果が違うときは論文ラベルを添えて比べるよう指示している。
- **埋め込み**: 論文ごとにディスクキャッシュする（`embeddings_cache/corpus/<id>.json`）。組み合わせを変えても再埋め込みしない。
  RAG 画面を開いた時点で未作成の分だけ作る。論文JSONを取り込み直すと（更新日時が変われば）作り直す。
- 毎回の質問と回答・根拠段落は `<Obsidian>/50_coding/llamaindex/<日時>_corpus_rag.md` に追記する。

## 主なファイル

| ファイル | 役割 |
|---|---|
| `src/server/articleHarvester.ts` | 論文ページのHTML/JATSから主論文JSON（節・段落・図表）を作る |
| `src/server/referenceHarvester.ts` | HTMLから参考文献候補を抽出し、PubMed E-utilitiesでPMID/abstractを取得してJSON保存 |
| `src/server/corpusRag.ts` | 複数論文の段落索引（メタデータ付き）、横断検索、Claude による引用付き回答 |
| `src/server/embeddingStore.ts` | 埋め込みのディスクキャッシュとコサイン類似度 |
| `src/server/server.ts` | Express API |
| `src/server/library.ts` | フォルダ構成（library.json）の読み書き。ネスト・循環チェック・削除時の未分類化 |
| `src/server/zotero.ts` | Zotero ローカルAPIの読み取りと、コレクション→フォルダ同期 |
| `src/client/App.tsx` | 画面シェル（Documents / RAG の切り替え、データ読み込み） |
| `src/client/LibraryScreen.tsx` | ドキュメント選択・取り込み画面（フォルダツリー、Import、文献カード） |
| `src/client/ZoteroPanel.tsx` | Zotero同期パネル（接続状態、プレビュー、適用） |
| `src/client/RagScreen.tsx` | 複数論文RAG画面（対象論文一覧、検索、回答、根拠段落） |

保存先（gitリポジトリ外。Dropbox同期で他端末と共有する）:

```text
<Obsidian>/50_coding/llamaindex/reference_sets   # 参考文献セット JSON
<Obsidian>/50_coding/llamaindex/article_sets     # 主論文セット JSON
<Obsidian>/50_coding/llamaindex/raw_html         # 取り込み時の入力HTML（再現性確保・パーサ検証用）
<Obsidian>/50_coding/llamaindex/library.json     # ドキュメント選択画面のフォルダ構成
```

`<Obsidian>` は `config.ts` が自動解決する（Windows: `~/Dropbox/obsidian`、Mac: `~/Library/CloudStorage/Dropbox/obsidian`）。
環境変数 `OBSIDIAN_DIR` で明示指定も可能。

## 実行

```bash
npm install
npm run dev
```

UI:

```text
http://localhost:5175
```

50_article-json の viewer（5173）と同時に起動できるよう、UI は 5175 にしてある。

API:

```text
http://localhost:5174
```

`OPENAI_API_KEY` と `ANTHROPIC_API_KEY` は、リポジトリ直下の `.env` から読み込みます。

- 回答の生成は Claude Sonnet 5.5（`claude-sonnet-5-5`、`ANTHROPIC_API_KEY`）。安全上の理由で断られたときは、サーバ側で代替モデルに回します（`fallbacks: "default"`）。
- 埋め込み（`text-embedding-3-small`）と JA→EN 翻訳は OpenAI（`OPENAI_API_KEY`）。
- 使っているモデルは画面右上に表示し、回答ごとのモデルは回答欄と保存する md に残します。

## アーカイブ

- `archive/rxfp1/` — 旧 rxfp1 の Python パイプライン（Entrez メタデータ取得 → MD → JSON → 全論文インデックス → GUI）。
- `archive/web-kimi/` — 旧 web-kimi（タグ `archive/web-kimi`）。
- 単一論文の RAG（本文／参考文献abstract／統合）は 2026-10-30 に外した。コードはその直前のコミット（`git show e14fe5a:src/server/articleRag.ts` など）に残っている。
