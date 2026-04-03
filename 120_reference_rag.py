"""
参考文献RAGシステム（インタラクティブモード）
Em2015_ref.json から参考文献データを読み込み、abstract のみを検索対象として対話的に検索
日本語クエリは自動的に英訳されます
"""

import json
import sys
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
load_dotenv(Path.home() / "uv-envs/llamaindex/.env")

from llama_index.core import Document, Settings, VectorStoreIndex
from llama_index.embeddings.openai import OpenAIEmbedding
from llama_index.llms.openai import OpenAI

# ══════════════════════════════════════════════════════════════════════════════

# 参考文献RAG設定
REFERENCE_JSON_DIR = Path.home() / "Dropbox/obsidian/50_coding/llamaindex"
DEFAULT_CITEKEY = "Em2015"

# 各クエリで取得する引用元の数
TOP_K = 5

# 検索対象：abstractのみ（abstractがない文献は自動スキップ）

# ══════════════════════════════════════════════════════════════════════════════

Settings.llm = OpenAI(model="gpt-4o", temperature=0.1)
Settings.embed_model = OpenAIEmbedding(model="text-embedding-3-large")


# ── ファイル読み込み関数 ────────────────────────────────────────────────────

def load_reference_json(citekey: str) -> List[Dict[str, Any]]:
    """参考文献JSONファイルを読み込む"""
    ref_json_path = REFERENCE_JSON_DIR / f"{citekey}_ref.json"

    if not ref_json_path.exists():
        raise FileNotFoundError(f"参考文献JSONが見つかりません: {ref_json_path}")

    with open(ref_json_path, 'r', encoding='utf-8') as f:
        refs = json.load(f)

    return refs


def extract_citation_info(ref: Dict[str, Any]) -> Dict[str, str]:
    """参考文献から主著者、年、journal、titleを抽出"""
    citation = {
        'authors': '',
        'year': '',
        'journal': '',
        'title': '',
    }

    # PubMed情報がある場合
    if ref.get('pubmed'):
        pubmed = ref['pubmed']

        # 主著者（第一著者）
        if pubmed.get('authors') and len(pubmed['authors']) > 0:
            citation['authors'] = pubmed['authors'][0]

        # 年
        if pubmed.get('year'):
            citation['year'] = pubmed['year']

        # Journal
        if pubmed.get('journal'):
            citation['journal'] = pubmed['journal']

        # Title
        if pubmed.get('title'):
            citation['title'] = pubmed['title']
    else:
        # テキストから解析（簡易版）
        text = ref.get('text', '')

        # [N] を除去
        import re
        text_clean = re.sub(r'^\[\d+\]\s*', '', text)

        # 最初の部分から著者を抽出（簡易版：最初の単語）
        parts = text_clean.split('.')
        if parts:
            first_part = parts[0].strip()
            authors_part = first_part.split(',')[0].strip()
            citation['authors'] = authors_part[:50]  # 最初の50文字

        # 年を抽出（括弧内の4桁数字）
        year_match = re.search(r'\((\d{4})\)', text)
        if year_match:
            citation['year'] = year_match.group(1)
        else:
            year_match = re.search(r'\d{4}', text)
            if year_match:
                citation['year'] = year_match.group(0)

        # Journalを抽出（簡易版）
        if len(parts) > 1:
            citation['journal'] = parts[1].strip()[:100]

        # Titleを抽出（簡易版：最初の文）
        if parts:
            citation['title'] = parts[0].strip()[:150]

    return citation


def references_to_documents(refs: List[Dict[str, Any]], citekey: str) -> List[Document]:
    """参考文献リストをDocumentに変換（abstractのみを検索対象）"""
    documents = []
    skipped_count = 0

    for ref in refs:
        pubmed = ref.get('pubmed')

        # abstract がない場合はスキップ
        if not pubmed or not pubmed.get('abstract'):
            skipped_count += 1
            continue

        citation = extract_citation_info(ref)
        abstract = pubmed.get('abstract', '')

        metadata = {
            'citekey': citekey,
            'ref_index': ref.get('index', 0),
            'section': ref.get('section', 'References'),
            'authors': citation['authors'],
            'year': citation['year'],
            'journal': citation['journal'],
            'title': citation['title'],
            'abstract': abstract,
            'full_text': ref.get('text', ''),
        }

        documents.append(Document(text=abstract, metadata=metadata))

    if skipped_count > 0:
        print(f"  ⊘ {skipped_count} 件の文献はabstractがないためスキップしました")

    return documents


def create_index(documents: List[Document]) -> VectorStoreIndex:
    """DocumentリストからVectorStoreIndexを作成

    注: 各参考文献は1つのDocumentのまま（チャンク分割しない）
         デフォルトでは長いabstractが複数チャンクに分割されて、
         検索結果で同じabstractが複数ヒットするため、
         node_parserをNoneにして分割を無効化
    """
    from llama_index.core.node_parser import SimpleNodeParser

    # チャンク分割を無効化：chunk_size を非常に大きくする
    node_parser = SimpleNodeParser.from_defaults(chunk_size=100000, chunk_overlap=0)

    # Settingsに設定して、from_documentsで適用
    from llama_index.core import Settings as CoreSettings
    CoreSettings.node_parser = node_parser

    return VectorStoreIndex.from_documents(documents)


def is_japanese(text: str) -> bool:
    """テキストが日本語を含むかどうかを判定"""
    japanese_pattern = re.compile(r'[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]')
    return bool(japanese_pattern.search(text))


def translate_to_english(text: str) -> str:
    """日本語のテキストを英語に翻訳（OpenAI使用）"""
    from llama_index.llms.openai import OpenAI

    llm = OpenAI(model="gpt-4o")
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

    # キーワードをカンマで分割
    keyword_list = [kw.strip() for kw in keywords.split(",")]

    highlighted_text = text
    for keyword in keyword_list:
        # 大文字小文字を区別せずにキーワードをハイライト
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

    output_file.write("### 関連参考文献\n\n")
    for i, node in enumerate(response.source_nodes, 1):
        meta = node.node.metadata
        authors = meta.get('authors', 'Unknown')
        year = meta.get('year', 'N/A')
        journal = meta.get('journal', 'N/A')
        title = meta.get('title', '')
        ref_index = meta.get('ref_index', '?')
        abstract = meta.get('abstract', '')

        # 引用形式：著者 (年) Journal
        citation_str = f"{authors} ({year}) {journal}".strip()

        output_file.write(f"#### [{i}] 参考文献 [{ref_index}]\n\n")
        output_file.write(f"- **引用**: {citation_str}\n")
        if title:
            output_file.write(f"- **タイトル**: {title}\n")
        output_file.write(f"- **類似度スコア**: {node.score:.4f}\n\n")

        output_file.write(f"**内容:**\n\n> [!abstract]\n> \n> {abstract}\n\n")


# ── メイン ────────────────────────────────────────────────────────────────────

def main():
    # コマンドライン引数で citekey を指定可能
    if len(sys.argv) > 1:
        citekey = sys.argv[1]
    else:
        citekey = DEFAULT_CITEKEY

    # 参考文献JSONを読み込む
    print(f"参考文献JSONを読み込み中: {citekey}_ref.json")
    refs = load_reference_json(citekey)
    print(f"  参考文献数: {len(refs)} 件")

    # DocumentListに変換（abstractのみ）
    print(f"{len(refs)} 件の参考文献をスキャン（abstractのみを対象）")
    documents = references_to_documents(refs, citekey)
    print(f"  ✓ {len(documents)} 件のabstractをベクトル化します")

    # インデックス作成
    print("ベクトルインデックス構築中...")
    index = create_index(documents)
    print("インデックス作成完了")

    # 検索 → ファイル出力（インタラクティブモード）
    date_str = datetime.now().strftime('%m%d')
    base_path = REFERENCE_JSON_DIR / f"{citekey}_reference_rag_{date_str}.md"
    output_path = get_unique_output_path(base_path)

    # ファイル初期化（ヘッダー出力）
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write("# 参考文献RAG検索結果（Abstract抽出版）\n\n")
        f.write(f"**論文**: {citekey}\n\n")
        f.write(f"**参考文献総数**: {len(refs)} 件\n\n")
        f.write(f"**検索対象（Abstract有）**: {len(documents)} 件\n\n")
        f.write(f"**検索モード**: インタラクティブ\n\n")

    print(f"出力ファイル: {output_path}")
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
