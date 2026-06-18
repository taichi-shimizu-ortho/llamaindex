"""
[STEP 06] 保存済みインデックスを読み込んで全論文横断RAG検索
結果をMarkdownファイルに出力

実行順: 10 -> 20 -> 30 -> 40 -> 50
前提: 40_build_all_articles_index.py を実行してインデックスを構築しておくこと

使い方:
    python 50_search_all_articles.py "HMWHAの軟骨保護作用" "relaxinのMMP誘導"
"""

import sys
import platform
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path.home() / "uv-envs/llamaindex/.env")

from llama_index.core import Settings, StorageContext, load_index_from_storage
from llama_index.core.vector_stores import MetadataFilters, ExactMatchFilter
from llama_index.embeddings.openai import OpenAIEmbedding
from llama_index.llms.openai import OpenAI

# 設定
Settings.llm = OpenAI(model="gpt-5-nano-2025-08-07", temperature=0.1)
Settings.embed_model = OpenAIEmbedding(model="text-embedding-3-large")

# パス設定（Mac/Windows対応）
SCRIPT_DIR = Path(__file__).resolve().parent
if platform.system() == "Darwin":
    # Mac: CloudStorageパス
    STORAGE_DIR = Path.home() / "Library/CloudStorage/Dropbox/obsidian/50_coding/llamaindex/storage_all"
    OUTPUT_DIR = Path.home() / "Library/CloudStorage/Dropbox/obsidian/50_coding/llamaindex"
else:
    # Windows: 環境変数参照
    STORAGE_DIR = Path.home() / "Dropbox" / "obsidian" / "50_coding" / "llamaindex" / "storage_all"
    OUTPUT_DIR = Path.home() / "Dropbox" / "obsidian" / "50_coding" / "llamaindex"

# デフォルト検索対象セクション
# materials_methods は除外（方法論より結果・考察を優先）
DEFAULT_SECTION_TYPES = ['abstract', 'introduction', 'results', 'discussion', 'conclusion']


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


def search(
    index,
    query: str,
    top_k: int = 5,
    section_types: list[str] | None = None,
    citekeys: list[str] | None = None,
):
    """
    RAG検索を実行

    Args:
        index: VectorStoreIndex
        query: 検索クエリ
        top_k: 取得する上位件数
        section_types: 絞り込むセクションタイプ（例: ['discussion', 'results']）
        citekeys: 絞り込む論文citekey（例: ['Sato2014', 'Ahmad2012']）

    Returns:
        レスポンス
    """
    kwargs = {
        "similarity_top_k": top_k,
        "response_mode": "compact",
    }

    # フィルタ構築
    filters = []
    if section_types:
        for st in section_types:
            filters.append(ExactMatchFilter(key="section_type", value=st))
    if citekeys:
        for ck in citekeys:
            filters.append(ExactMatchFilter(key="citekey", value=ck))

    if filters:
        kwargs["filters"] = MetadataFilters(filters=filters, condition="or")

    query_engine = index.as_query_engine(**kwargs)
    return query_engine.query(query)


def write_result(f, query: str, response, section_types=None, citekeys=None):
    """検索結果をMarkdown形式でファイルに書き込む"""
    f.write(f"\n---\n\n")
    f.write(f"## 検索クエリ\n\n")

    # サーチクエリブロック（ベクトル検索に使用したパラメータを明示）
    f.write(f"> **クエリ**: {query}\n")
    if section_types:
        f.write(f"> **対象セクション**: {', '.join(section_types)}\n")
    if citekeys:
        f.write(f"> **対象論文**: {', '.join(citekeys)}\n")
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
        title = meta.get('title', '')
        source = meta.get('source', '')
        section = meta.get('section', '')
        subsection = meta.get('subsection', '')
        section_type = meta.get('section_type', '')

        # 引用場所の表示
        location = f"{citekey} - {title}"
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


def run_searches(index, queries: list[str], output_path: Path,
                 section_types: list[str] | None = None):
    """複数クエリを実行してMarkdownファイルに保存"""
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write("# 全論文横断RAG検索結果\n\n")
        f.write(f"**検索日時**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n")
        f.write(f"**検索クエリ数**: {len(queries)}件\n\n")
        f.write(f"**インデックス**: {STORAGE_DIR.name}/\n\n")
        if section_types:
            f.write(f"**対象セクション**: {', '.join(section_types)}\n\n")

        for query in queries:
            print(f"\n[*] 検索中: {query}")
            response = search(index, query, top_k=5, section_types=section_types)
            write_result(f, query, response, section_types=section_types)
            print(f"    引用元: {len(response.source_nodes)}件")

    print(f"\n[OK] 結果を保存しました: {output_path}")


def run_interactive_search(index, output_path: Path, section_types: list[str] | None = None):
    """対話的に1クエリごとに検索して、結果をファイルに追記"""
    # ファイルヘッダーを初期化
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write("# 全論文横断RAG検索結果\n\n")
        f.write(f"**インデックス**: {STORAGE_DIR.name}/\n\n")
        if section_types:
            f.write(f"**対象セクション**: {', '.join(section_types)}\n\n")
        f.write("---\n\n")

    query_count = 0
    print("\n" + "=" * 80)
    print("検索クエリを入力してください（1クエリごとに検索・結果を追記します）")
    print("（入力終了: 'quit' または 'exit' を入力）")
    print("=" * 80 + "\n")

    while True:
        query = input("クエリを入力 > ").strip()

        if query.lower() in ['quit', 'exit']:
            break

        if not query:
            print("  → 空のクエリはスキップしました\n")
            continue

        # 検索実行
        print(f"  [検索中...]")
        response = search(index, query, top_k=5, section_types=section_types)

        # 結果をファイルに追記
        with open(output_path, 'a', encoding='utf-8') as f:
            write_result(f, query, response, section_types=section_types)

        query_count += 1
        print(f"  ✓ 完了 (引用元: {len(response.source_nodes)}件)\n")

    if query_count == 0:
        print("\n[!] クエリが実行されていません")
        return

    # ファイルの最後に検索統計を追記
    with open(output_path, 'a', encoding='utf-8') as f:
        f.write(f"\n---\n\n")
        f.write(f"**検索日時**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n")
        f.write(f"**実行クエリ数**: {query_count}件\n")

    print(f"\n[OK] 結果を保存しました: {output_path}")


def parse_cli_args():
    """コマンドライン引数をパース。--sections オプションに対応。

    使い方:
        python 50_search_all_articles.py クエリ1 クエリ2
        python 50_search_all_articles.py --sections results,discussion クエリ1 クエリ2
    """
    section_types = None
    queries = []

    i = 1
    while i < len(sys.argv):
        arg = sys.argv[i]

        if arg == "--sections" and i + 1 < len(sys.argv):
            # 次の引数がセクション指定
            section_str = sys.argv[i + 1]
            section_types = [s.strip() for s in section_str.split(",")]
            i += 2
        else:
            # クエリ
            queries.append(arg)
            i += 1

    return queries, section_types


def main():
    print("=" * 80)
    print("全論文横断RAG検索")
    print("=" * 80)

    # インデックス読み込み
    index = load_index()

    # 出力ファイル名
    search_date = datetime.now().strftime('%m%d_%H%M')
    output_path = OUTPUT_DIR / f"search_{search_date}.md"

    # コマンドライン引数をパース
    queries, section_types = parse_cli_args()
    if section_types is None:
        section_types = DEFAULT_SECTION_TYPES

    # 指定されたセクションを表示
    if section_types != DEFAULT_SECTION_TYPES:
        print(f"[*] 対象セクション: {', '.join(section_types)}\n")

    # クエリがある場合はバッチ実行、ない場合は対話的入力
    if queries:
        run_searches(index, queries, output_path, section_types=section_types)
    else:
        # 対話的入力：1クエリごとに検索・追記
        run_interactive_search(index, output_path, section_types=section_types)

    print("\n" + "=" * 80)
    print(f"完了！  {output_path.name}")
    print("=" * 80)


if __name__ == "__main__":
    main()
