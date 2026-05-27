"""
[STEP 06a] ACLとrelaxinの複合検索スクリプト
50_search_all_articles.py を使用して複数の検索クエリを実行
"""

import sys
from datetime import datetime
from pathlib import Path

from llama_index.core import Settings, StorageContext, load_index_from_storage
from llama_index.core.vector_stores import MetadataFilters, ExactMatchFilter
from llama_index.embeddings.openai import OpenAIEmbedding
from llama_index.llms.openai import OpenAI

# 設定
Settings.llm = OpenAI(model="gpt-5-nano-2025-08-07", temperature=0.1)
Settings.embed_model = OpenAIEmbedding(model="text-embedding-3-large")

# パス設定
SCRIPT_DIR = Path(__file__).resolve().parent
STORAGE_DIR = SCRIPT_DIR / "storage_all"

# デフォルト検索対象セクション
DEFAULT_SECTION_TYPES = ['results', 'discussion', 'conclusion', 'abstract', 'other']

# ACLとrelaxinに関する検索クエリ
SEARCH_QUERIES = [
    "ACL relaxin laxity",
    "anterior cruciate ligament relaxin",
    "relaxin collagen ligament",
    "relaxin MMP collagenase ligament",
    "ACL injury pregnancy relaxin",
    "ligament biomechanics relaxin pregnancy",
    "relaxin joint laxity mechanism",
]


def load_index():
    """保存済みインデックスを読み込む"""
    if not STORAGE_DIR.exists():
        raise FileNotFoundError(
            f"インデックスが見つかりません: {STORAGE_DIR}\n"
            "先に 40_build_all_articles_index.py を実行してください"
        )
    print(f"[*] インデックスを読み込み中: {STORAGE_DIR.name}/")
    storage_context = StorageContext.from_defaults(persist_dir=str(STORAGE_DIR))
    index = load_index_from_storage(storage_context)
    print("[OK] インデックス読み込み完了")
    return index


def search(index, query: str, top_k: int = 5, section_types: list[str] | None = None):
    """RAG検索を実行"""
    kwargs = {
        "similarity_top_k": top_k,
        "response_mode": "compact",
    }

    if section_types:
        filters = []
        for st in section_types:
            filters.append(ExactMatchFilter(key="section_type", value=st))
        if filters:
            kwargs["filters"] = MetadataFilters(filters=filters, condition="or")

    query_engine = index.as_query_engine(**kwargs)
    return query_engine.query(query)


def write_result(f, query: str, response, section_types=None):
    """検索結果をMarkdown形式でファイルに書き込む"""
    f.write(f"\n---\n\n")
    f.write(f"## 検索クエリ\n\n")
    f.write(f"> **クエリ**: {query}\n")
    if section_types:
        f.write(f"> **対象セクション**: {', '.join(section_types)}\n")
    f.write("\n")

    # 回答
    f.write("### 回答\n\n")
    f.write(f"{response.response}\n\n")

    # 引用元
    if not response.source_nodes:
        f.write("_引用元なし_\n\n")
        return

    f.write("### 引用元\n\n")
    for i, node_with_score in enumerate(response.source_nodes, 1):
        node = node_with_score.node
        score = node_with_score.score
        meta = node.metadata

        citekey = meta.get('citekey', 'Unknown')
        published = meta.get('published', '')
        source = meta.get('source', '')
        section = meta.get('section', '')
        subsection = meta.get('subsection', '')
        section_type = meta.get('section_type', '')

        # 引用場所の表示
        location = f"{citekey}（{published}）"
        if source:
            location += f" *{source}*"

        if subsection:
            section_display = f"{section} > {subsection}"
        else:
            section_display = section

        f.write(f"#### [{i}] {location}\n\n")
        f.write(f"- **セクション**: {section_display}\n")
        f.write(f"- **Type**: {section_type}\n")
        f.write(f"- **類似度**: {score:.4f}\n\n")
        f.write(f"**内容:**\n\n")
        f.write(f"> {node.text}\n\n")

    f.write("\n")


def main():
    print("=" * 80)
    print("ACL & Relaxin 複合検索")
    print("=" * 80)

    # インデックス読み込み
    index = load_index()

    # 出力ファイル名
    search_date = datetime.now().strftime('%m%d_%H%M')
    output_path = SCRIPT_DIR / f"search_acl_relaxin_{search_date}.md"

    # 検索実行
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write("# ACL & Relaxin 複合検索結果\n\n")
        f.write(f"**検索日時**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n")
        f.write(f"**検索クエリ数**: {len(SEARCH_QUERIES)}件\n\n")
        f.write(f"**インデックス**: {STORAGE_DIR.name}/\n\n")
        f.write(f"**対象セクション**: {', '.join(DEFAULT_SECTION_TYPES)}\n\n")

        for query in SEARCH_QUERIES:
            print(f"\n[*] 検索中: {query}")
            try:
                response = search(index, query, top_k=5, section_types=DEFAULT_SECTION_TYPES)
                write_result(f, query, response, section_types=DEFAULT_SECTION_TYPES)
                print(f"    引用元: {len(response.source_nodes)}件")
            except Exception as e:
                print(f"    エラー: {e}")
                f.write(f"\n---\n\n## 検索クエリ\n\n> **クエリ**: {query}\n\n")
                f.write(f"**エラー**: {e}\n\n")

    print(f"\n[OK] 結果を保存しました: {output_path}")
    print("=" * 80)


if __name__ == "__main__":
    main()
