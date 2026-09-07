# SAGE XML v2.2：正規版`web`のブラウザ検証と実装報告

## 結論

SAGE OJSM論文の全文JATS XMLは、ブラウザから正しく取得できます。対象URL `https://journals.sagepub.com/doi/full-xml/10.1177/23259671261440203` をブラウザで直接開き、`<article>`、`article-meta`、`abstract`、`body`、`fig`、`table-wrap`、`ref-list`を含むXML document treeを確認しました。

以後の正規実装は **`C:\Users\a2189\uv-envs\llamaindex\web` のみ**とします。起動時の入口はUIが`http://localhost:5173`、内部の取込APIが`http://localhost:5174`です。ユーザーはAPIポートを意識せず、`web`のブックマークレットを登録・実行するだけで取り込めます。`web-kimi`は後続工程で`web`へ統合し、同時起動・別ブックマークレットの運用はしません。

| 区分 | 現在の正規設定 |
|---|---|
| 完成対象 | `web` |
| UI | `http://localhost:5173` |
| SAGE Importの送信先 | `http://localhost:5174/api/import/ors` |
| ブックマークレット | `web/public/sage-import-bookmarklet-v2.url.txt` |
| article JSON | JATS XML優先 |
| reference JSON | DOI/PMIDが取れるSAGE HTML `bibr`優先、XMLは件数・本文構造の確認に利用 |

## 実XMLによる検証結果

ブラウザで取得した対象論文の実XMLを、`web/src/server/sageJatsHarvester.ts`へ入力して回帰検証しました。メタデータと本文階層をJATSから取得でき、HTMLに混ざるmodal・ナビゲーション・ページ装飾に依存しない構造化が可能です。

| 検証項目 | 結果 |
|---|---:|
| JATS XMLの有効判定 | 成功 |
| DOI | `10.1177/23259671261440203` |
| 著者 | 5名 |
| Abstract subsection | 6件 |
| Introduction | 5段落 |
| Tables | 3件 |
| Figures | 2件 |
| JATS reference | 23件 |
| HTML `bibr` reference | 23件、23件にDOIまたはPMIDを保持 |

対象XMLの`ref-list`は23件の書誌テキストを持ちますが、DOI／PMIDの`pub-id`を持ちません。reference JSONまでXMLだけにするとPubMed abstract補完の識別精度が低下します。このため、article JSONはJATS XMLを正とし、reference JSONは識別子を豊富に持つHTMLのSAGE `div#bibrN-*`抽出を正とするハイブリッド設計です。

> XML優先とは、論文本文の構造をXMLに委ねることです。reference補完のためのDOI／PMID抽出までXMLだけに固定することではありません。

## 実装済みの修正

| ファイル | 修正内容 |
|---|---|
| `web/src/server/sageJatsHarvester.ts` | JATSのメタデータ、構造化abstract、本文、表、図説明、referenceを抽出する専用モジュールを追加 |
| `web/src/server/articleHarvester.ts` | `jatsXml`を受け入れ、有効なXMLがあればarticle JSONをXML優先で生成。図画像はHTMLから絶対URLとして補完 |
| `web/src/server/referenceHarvester.ts` | JATS／HTML両方の文献候補を比較し、DOI/PMIDが豊富な方を選択 |
| `web/src/server/server.ts` | 統合インポートが`jatsXml`を受信し、`raw_html/<ID>.source.xml`へ保存。応答に`extractionSource`を追加 |
| `web/src/client/App.tsx` | Abstract subsectionの表示、caption付き表のtable描画、SAGEの`colspan`を含む不揃いな行の表示を修正 |
| `web/public/sage-import-bookmarklet-source.js` | 正規のSAGE full-xml URLをブラウザ同一オリジンで取得し、HTMLと共に5174へ送信 |
| `web/public/sage-import-bookmarklet-v2.url.txt` | Chrome登録用の一行版ブックマークレット |

ブラウザからJATS XMLを取得するURLでは、DOIの`/`をURLエンコードしません。`10.1177/23259671261440203`のように、DOIのprefixとsuffixをURLパスとして維持します。XMLがライセンス条件や一時的な応答で取得できない場合は、例外で停止せずHTML抽出へフォールバックします。

## 利用手順

1. PowerShellで正規版のみを起動します。

```powershell
cd C:\Users\a2189\uv-envs\llamaindex\web
npm run dev
```

2. `web/public/sage-import-bookmarklet-v2.url.txt`を開き、全内容をChromeの既存`SAGE Import`ブックマークのURL欄へ貼り付けます。先頭の`javascript:`を含めて全て貼り付けます。

3. SAGEの論文ページを開き、本文とReferencesが表示された状態で`SAGE Import`をクリックします。XML取得に成功した場合、右下の完了表示でarticleは`(sage-jats)`になります。referenceは対象論文では`(html)`となるのが正しい動作です。

4. 取込後、`raw_html`に`Gao2026-N.source.xml`、`article_sets`に`Gao2026-N.json`が作られることを確認します。article JSONには`"extractionSource": "sage-jats"`が記録され、UIではAbstract、Introduction、Tables、Figuresが表示されます。

## 実装検証

`web`のクライアントproduction buildおよび、`server.ts`、`articleHarvester.ts`、`referenceHarvester.ts`、`sageJatsHarvester.ts`のTypeScript型検証は成功しています。次の実行で新しいJSONが生成されれば、`.source.xml`と`extractionSource`を確認して最終受入とします。


## Gao2026-8／Gao2026-9の実行結果

Gao2026-8には`extractionSource`および`.source.xml`がなく、旧サーバー実行時のHTML抽出結果でした。これに対して、正規版`web`の現行サーバーを明示的に起動し、ブラウザで確認した実JATS XMLとGao2026-8の保存HTMLを`/api/import/ors`へ送ったところ、**Gao2026-9**が正常に生成されました。

| 生成物 | 実測結果 |
|---|---|
| `article_sets/Gao2026-9.json` | `extractionSource: "sage-jats"`、38 chunks |
| `reference_sets/Gao2026-9.json` | 23 references、23 abstracts、`extractionSource: "html"` |
| `raw_html/Gao2026-9.source.xml` | 保存成功、67,098 bytes |
| Abstract | 6 subsection（Background〜Conclusion） |
| Introduction | 5 paragraph |
| Tables | Table 1〜3の3件 |
| Figures | Figure 1〜2の2件 |

つまり、**現行の`web`コードと`5174` APIではXML優先の統合処理が完走することを実証済み**です。Gao2026-9は削除せず残してあります。UIを`web`から起動すれば、このデータセットを選択して表示確認できます。

Gao2026-8が旧形式になったのは、ブックマークレットではなく、当時起動していたAPIサーバーが変更前のコードを読み込んでいたためです。今後は取り込み前に`web`ディレクトリで`npm run dev`を起動し直してください。
