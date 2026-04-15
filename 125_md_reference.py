"""
Markdown参考文献RAGシステム
Nishimura2023.mdから参考文献リストを抽出し、
同じディレクトリにある論文MDファイルをコンテキストにしてQAセッションを行う
"""

import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
load_dotenv(Path.home() / "uv-envs/llamaindex/.env")

from llama_index.core import Document, Settings, VectorStoreIndex
from llama_index.embeddings.openai import OpenAIEmbedding
from llama_index.llms.openai import OpenAI

# ══════════════════════════════════════════════════════════════════════════════

# 参照ディレクトリ設定
REFERENCE_DIR = Path.home() / "Dropbox/obsidian/10_article/hamstrings"
OUTPUT_DIR = Path.home() / "Dropbox/obsidian/50_coding/llamaindex/Rag_result"
DEFAULT_MAIN_PAPER = "Nishimura2023.md"
TOP_K = 3

# ══════════════════════════════════════════════════════════════════════════════

Settings.llm = OpenAI(model="gpt-5.4-nano", temperature=0.1)
Settings.embed_model = OpenAIEmbedding(model="text-embedding-3-small")


# ── ファイル読み込み関数 ────────────────────────────────────────────────────

def extract_references(paper_path: Path) -> List[str]:
    """元論文から[[AuthorYear]]形式の参考文献を抽出"""
    with open(paper_path, 'r', encoding='utf-8') as f:
        content = f.read()
    # [[Abebe2012]] のような形式を抽出
    refs = re.findall(r'\[\[(.*?)\]\]', content)
    return list(set(refs))  # 重複を削除


def extract_abstract(content: str) -> str:
    """Markdownから [!Abstract] セクションを抽出"""
    # > [!Abstract] で始まるセクションを検索
    # 複数行の > で始まるテキストに対応
    pattern = r'>\s*\[!Abstract\]\s*\n((?:>.*\n?)*)'
    match = re.search(pattern, content, re.DOTALL)

    if match:
        abstract_text = match.group(1).strip()
        # 先頭の > と余分なスペースを削除
        abstract_text = re.sub(r'^>\s*', '', abstract_text, flags=re.MULTILINE)
        # 複数の空行を1行に統一
        abstract_text = re.sub(r'\n\s*\n+', '\n\n', abstract_text)
        return abstract_text

    return ""


def load_markdown_file(file_path: Path) -> Optional[Dict[str, Any]]:
    """Markdownファイルを読み込んでメタデータを抽出"""
    if not file_path.exists():
        return None

    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # ファイル名から著者と年を抽出
    filename = file_path.stem  # "Abebe2012" など

    # 簡易的に最後の4文字が年である想定
    if len(filename) >= 4 and filename[-4:].isdigit():
        authors = filename[:-4]
        year = filename[-4:]
    else:
        authors = filename
        year = "N/A"

    # アブストラクトを抽出
    abstract = extract_abstract(content)

    return {
        'filename': filename,
        'authors': authors,
        'year': year,
        'content': content,
        'abstract': abstract,
        'path': file_path
    }


def markdown_to_documents(md_files: List[Path]) -> List[Document]:
    """MarkdownファイルをDocumentに変換（アブストラクトのみを対象）"""
    documents = []
    skipped_count = 0

    for file_path in md_files:
        md_data = load_markdown_file(file_path)

        if md_data is None:
            skipped_count += 1
            continue

        abstract = md_data.get('abstract', '').strip()

        # アブストラクトがない場合はスキップ
        if not abstract:
            skipped_count += 1
            continue

        metadata = {
            'filename': md_data['filename'],
            'authors': md_data['authors'],
            'year': md_data['year'],
            'filepath': str(md_data['path']),
            'abstract': abstract,
        }

        documents.append(Document(text=abstract, metadata=metadata))

    if skipped_count > 0:
        print(f"  -- {skipped_count} 件のファイルはアブストラクトがないためスキップしました")

    return documents


def create_index(documents: List[Document]) -> VectorStoreIndex:
    """DocumentリストからVectorStoreIndexを作成

    チャンク分割を無効化して、各論文を1つのDocumentのままにする
    """
    from llama_index.core.node_parser import SimpleNodeParser

    # チャンク分割を無効化：chunk_size を非常に大きくする
    node_parser = SimpleNodeParser.from_defaults(chunk_size=100000, chunk_overlap=0)

    from llama_index.core import Settings as CoreSettings
    CoreSettings.node_parser = node_parser

    return VectorStoreIndex.from_documents(documents)


def is_japanese(text: str) -> bool:
    """テキストが日本語を含むかどうかを判定"""
    japanese_pattern = re.compile(r'[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]')
    return bool(japanese_pattern.search(text))


def translate_to_english(text: str) -> str:
    """日本語のテキストを英語に翻訳"""
    from llama_index.llms.openai import OpenAI

    llm = OpenAI(model="gpt-4o-mini")
    translation_prompt = (
        f"Translate the following Japanese text to English. "
        f"Return only the English translation, no other text.\n\n"
        f"Japanese: {text}"
    )

    response = llm.complete(translation_prompt)
    return str(response).strip()


def highlight_keywords(text: str, keywords: str) -> str:
    """テキスト内のキーワードを太字にする"""
    if not keywords:
        return text

    keyword_list = [kw.strip() for kw in keywords.split(",")]
    highlighted_text = text

    for keyword in keyword_list:
        pattern = re.compile(re.escape(keyword), re.IGNORECASE)
        highlighted_text = pattern.sub(f"**{keyword}**", highlighted_text)

    return highlighted_text


def get_unique_output_path(base_path: Path) -> Path:
    """ファイルが存在しない場合は base_path を返す。
    存在する場合は _2, _3, ... を付けて返す"""
    if not base_path.exists():
        return base_path

    stem = base_path.stem
    suffix = base_path.suffix
    parent = base_path.parent

    counter = 2
    while True:
        new_path = parent / f"{stem}_{counter}{suffix}"
        if not new_path.exists():
            return new_path
        counter += 1


def search_with_citation_to_file(
    query: str,
    index: VectorStoreIndex,
    output_file,
    top_k: int = 5,
) -> None:
    """参考文献RAG検索を実行し、Markdown形式でファイルに書き出す"""
    from llama_index.core.prompts import PromptTemplate

    # 日本語判定と英訳
    search_query = query
    is_japanese_query = is_japanese(query)

    if is_japanese_query:
        print(f"  日本語クエリを検出、英訳中...")
        search_query = translate_to_english(query)
        print(f"  英訳クエリ: {search_query}")

    output_file.write(f"\n---\n\n## 検索クエリ\n\n{query}\n\n")

    # カスタムプロンプト：回答と3つのキーワードを生成
    custom_prompt = PromptTemplate(
        "Context information is below.\n"
        "---------------------\n"
        "{context_str}\n"
        "---------------------\n"
        "Given the context information and not prior knowledge, answer the query.\n"
        "Query: {query_str}\n"
        "\n"
        "Please provide your answer, and also provide exactly 3 relevant keywords in English that summarize the answer.\n"
        "Format your response as:\n"
        "ANSWER:\n"
        "[your answer]\n"
        "\n"
        "KEYWORDS:\n"
        "[keyword1, keyword2, keyword3]\n"
    )

    query_engine = index.as_query_engine(
        text_qa_template=custom_prompt,
        similarity_top_k=top_k,
        response_mode="compact"
    )
    response = query_engine.query(search_query)

    # レスポンスをパースして、回答とキーワードを分離
    response_text = str(response)
    answer = response_text
    keywords = ""

    if "ANSWER:" in response_text and "KEYWORDS:" in response_text:
        parts = response_text.split("KEYWORDS:")
        answer = parts[0].replace("ANSWER:", "").strip()
        keywords = parts[1].strip() if len(parts) > 1 else ""

    # キーワードで回答テキストをハイライト
    if keywords:
        answer = highlight_keywords(answer, keywords)

    output_file.write("### 回答\n\n")
    output_file.write(f"{answer}\n\n")

    if keywords:
        output_file.write("### キーワード\n\n")
        output_file.write(f"{keywords}\n\n")

    output_file.write("### 関連論文\n\n")
    for i, node in enumerate(response.source_nodes, 1):
        meta = node.node.metadata
        filename = meta.get('filename', 'Unknown')
        authors = meta.get('authors', 'Unknown')
        year = meta.get('year', 'N/A')

        output_file.write(f"#### [{i}] {filename}\n\n")
        output_file.write(f"- **著者**: {authors}\n")
        output_file.write(f"- **年**: {year}\n")
        output_file.write(f"- **類似度スコア**: {node.score:.4f}\n\n")

        # アブストラクトを表示
        abstract = node.node.get_content()
        output_file.write(f"**Abstract:**\n\n> [!abstract]\n> \n> {abstract}\n\n")


# ── メイン ────────────────────────────────────────────────────────────────────

def main():
    # コマンドライン引数で主論文を指定可能
    if len(sys.argv) > 1:
        main_paper = sys.argv[1]
    else:
        main_paper = DEFAULT_MAIN_PAPER

    main_paper_path = REFERENCE_DIR / main_paper

    if not main_paper_path.exists():
        print(f"エラー: {main_paper_path} が見つかりません")
        sys.exit(1)

    # 元論文から参考文献を抽出
    print(f"参考文献リストを抽出中: {main_paper}")
    ref_list = extract_references(main_paper_path)
    print(f"  参考文献数: {len(ref_list)} 件")

    if not ref_list:
        print("参考文献が見つかりませんでした")
        sys.exit(1)

    # 参考文献に対応するMDファイルを収集
    print(f"\n参考文献ファイルを検索中...")
    md_files = []
    found_count = 0
    missing_count = 0

    for ref in sorted(ref_list):
        ref_file = REFERENCE_DIR / f"{ref}.md"
        if ref_file.exists():
            md_files.append(ref_file)
            found_count += 1
        else:
            missing_count += 1

    print(f"  OK {found_count} 件のファイルを見つけました")
    if missing_count > 0:
        print(f"  -- {missing_count} 件のファイルが見つかりません")

    if not md_files:
        print("参考文献ファイルが見つかりませんでした")
        sys.exit(1)

    # Markdownファイルをクエリに適した形式に変換
    print(f"\n{len(md_files)} 件の論文をベクトル化します...")
    documents = markdown_to_documents(md_files)
    print(f"  OK {len(documents)} 件の論文をDocumentに変換しました")

    # インデックス作成
    print("ベクトルインデックス構築中...")
    index = create_index(documents)
    print("インデックス作成完了")

    # 出力ディレクトリを作成
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # 検索 → ファイル出力（インタラクティブモード）
    date_str = datetime.now().strftime('%m%d')
    base_path = OUTPUT_DIR / f"{main_paper_path.stem}_reference_rag_{date_str}.md"
    output_path = get_unique_output_path(base_path)

    # ファイル初期化（ヘッダー出力）
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write("# 参考文献RAG検索結果（Abstract抽出版）\n\n")
        f.write(f"**主論文**: {main_paper}\n\n")
        f.write(f"**参考文献総数**: {len(ref_list)} 件\n\n")
        f.write(f"**検索対象（Abstract有）**: {len(documents)} 件\n\n")
        f.write(f"**検索モード**: インタラクティブ\n\n")

    print(f"\n出力ファイル: {output_path}")
    print(f"ベクトルインデックス準備完了。参考文献を検索してください。")
    print(f"終了するには 'exit' または 'quit' と入力\n")

    # インタラクティブクエリループ
    query_count = 0
    while True:
        query = input(">> 質問を入力: ").strip()

        if not query:
            continue

        if query.lower() in ('exit', 'quit'):
            print(f"\n検索完了！結果を保存しました: {output_path}")
            break

        query_count += 1
        with open(output_path, 'a', encoding='utf-8') as f:
            search_with_citation_to_file(query, index, f, top_k=TOP_K)

        print(f"✓ クエリ {query_count} を処理・追記しました\n")


if __name__ == "__main__":
    main()