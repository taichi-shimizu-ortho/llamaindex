"""
RXFP1 Abstract インデックスを使って RAG 検索
結果を Markdown ファイルに出力

前提: 41_build_rxfp1_abstract_index.py を実行してインデックスを構築しておくこと

使い方:
    uv run 51_search_rxfp1_abstract.py "relaxinのMMP誘導" "RXFP1シグナル"
"""

import sys
from datetime import datetime
from pathlib import Path

from llama_index.core import Settings, StorageContext, load_index_from_storage
from llama_index.embeddings.openai import OpenAIEmbedding
from llama_index.llms.openai import OpenAI

Settings.llm = OpenAI(model="gpt-4o-mini", temperature=0.1)
Settings.embed_model = OpenAIEmbedding(model="text-embedding-3-large")

STORAGE_DIR = Path.home() / "Dropbox" / "obsidian" / "50_coding" / "llamaindex" / "storage_rxfp1_abstract"
OUTPUT_DIR = Path.home() / "Dropbox" / "obsidian" / "50_coding" / "llamaindex"


def load_index():
    if not STORAGE_DIR.exists():
        raise FileNotFoundError(
            f"インデックスが見つかりません: {STORAGE_DIR}\n"
            "先に 41_build_rxfp1_abstract_index.py を実行してください"
        )

    print(f"[*] インデックスを読み込み中: {STORAGE_DIR.name}/")
    storage_context = StorageContext.from_defaults(persist_dir=str(STORAGE_DIR))
    index = load_index_from_storage(storage_context)
    print("[OK] インデックス読み込み完了")
    return index


def search(index, query: str, top_k: int = 5):
    query_engine = index.as_query_engine(
        similarity_top_k=top_k,
        response_mode="compact",
    )
    return query_engine.query(query)


def write_result(f, query: str, response):
    f.write(f"\n---\n\n")
    f.write(f"## 検索クエリ\n\n")
    f.write(f"> **クエリ**: {query}\n\n")

    f.write("### 回答\n\n")
    f.write(f"{response.response}\n\n")

    if not response.source_nodes:
        f.write("_引用元なし_\n\n")
        return

    f.write("### 引用元\n\n")
    for i, node_with_score in enumerate(response.source_nodes, 1):
        node = node_with_score.node
        score = node_with_score.score
        meta = node.metadata

        citekey = meta.get("citekey", "Unknown")
        title = meta.get("title", "")
        doi = meta.get("doi", "")
        tags = meta.get("tags", "")
        mesh_terms = meta.get("mesh_terms", "")

        f.write(f"#### [{i}] {citekey}\n\n")
        if title:
            f.write(f"- **タイトル**: {title}\n")
        if doi:
            f.write(f"- **DOI**: {doi}\n")
        if tags:
            f.write(f"- **Tags**: {tags}\n")
        if mesh_terms:
            f.write(f"- **MeSH**: {mesh_terms}\n")
        f.write(f"- **類似度**: {score:.4f}\n\n")
        f.write(f"**Abstract:**\n\n")
        f.write(f"> {node.text}\n\n")

    f.write("\n")


def run_searches(index, queries: list[str], output_path: Path):
    with open(output_path, "w", encoding="utf-8") as f:
        f.write("# RXFP1 Abstract RAG 検索結果\n\n")
        f.write(f"**検索日時**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n")
        f.write(f"**クエリ数**: {len(queries)}件\n\n")
        f.write(f"**インデックス**: {STORAGE_DIR.name}/\n\n")

        for query in queries:
            print(f"\n[*] 検索中: {query}")
            response = search(index, query, top_k=5)
            write_result(f, query, response)
            print(f"    引用元: {len(response.source_nodes)}件")

    print(f"\n[OK] 結果を保存しました: {output_path}")


def main():
    print("=" * 70)
    print("RXFP1 Abstract RAG 検索")
    print("=" * 70)

    index = load_index()

    if len(sys.argv) > 1:
        queries = sys.argv[1:]
    else:
        queries = [
            "relaxinのMMP誘導とシグナル伝達",
            "RXFP1と線維化",
        ]

    search_date = datetime.now().strftime("%m%d_%H%M")
    output_path = OUTPUT_DIR / f"search_rxfp1_{search_date}.md"

    run_searches(index, queries, output_path)

    print("\n" + "=" * 70)
    print(f"完了！  {output_path.name}")
    print("=" * 70)


if __name__ == "__main__":
    main()
