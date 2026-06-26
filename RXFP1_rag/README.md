# RXFP1 RAG - Archived

本来のメイン web プロジェクトから **2026-06-26** に分離されたレガシー RAG システムです。

## 内容

- `src/server/rag.ts` - ベクトル検索 + LLM回答合成
- `src/server/buildIndex.ts` - インデックス構築スクリプト
- `src/server/buildJson.ts` - RXFP1論文をJSONに変換
- `src/server/config.ts` - パス・モデル設定

## 詳細

元々の web プロジェクトは RXFP1 論文を対象に LlamaIndex を使った RAG 検索を提供していました。

その後、以下の新しいシステムが追加されました：
- **Reference RAG**: PubMed abstracts の検索
- **Article RAG**: 任意の論文本文の検索
- **Integrated RAG**: 上記の統合検索

UI が新しい 3 つのシステムに特化したため、RXFP1 RAG はサーバー側のエンドポイント `/api/query` が取り残されました。

## 復活させる方法

このフォルダの `rag.ts`, `buildIndex.ts`, `buildJson.ts` を web/src/server に復帰させ、server.ts にエンドポイントを追加することで、RXFP1 RAG 検索機能を復活できます。

## インデックス位置

RXFP1 インデックスは以下に存在します：

```
~/Library/CloudStorage/Dropbox/obsidian/50_coding/llamaindex/storage_all_ts/
  - doc_store.json (18MB)
  - index_store.json (9.2MB)
  - vector_store.json (196MB)
```

最終更新: 2026-06-22 22:48
