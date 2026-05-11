# mac 0415 - text-only version without metadata
import os
import sys
import re
import socket
from datetime import datetime
from pathlib import Path
from dotenv import load_dotenv
from llama_index.core import SimpleDirectoryReader, VectorStoreIndex, Settings, Document
from llama_index.core.node_parser import MarkdownNodeParser
from llama_index.llms.openai import OpenAI
from llama_index.embeddings.openai import OpenAIEmbedding

load_dotenv()

def find_paper(paper_name: str) -> str:
    base_path = Path.home() / "Dropbox/obsidian/10_article"
    for root, _, files in os.walk(base_path):
        for file in files:
            if file.lower().startswith(paper_name.lower()) and file.endswith(".md"):
                return os.path.join(root, file)
    raise FileNotFoundError(f"論文 '{paper_name}' が見つかりません")

def is_japanese(text: str) -> bool:
    """テキストが日本語を含むかどうかを判定"""
    japanese_pattern = re.compile(r'[぀-ゟ゠-ヿ一-鿿]')
    return bool(japanese_pattern.search(text))

def translate_to_english(text: str) -> str:
    """日本語のテキストを英語に翻訳（OpenAI使用）"""
    llm = OpenAI(model="gpt-4o")
    translation_prompt = (
        f"Translate the following Japanese text to English. "
        f"Return only the English translation, no other text.\n\n"
        f"Japanese: {text}"
    )
    response = llm.complete(translation_prompt)
    return str(response).strip()

def remove_image_links(text: str) -> str:
    """Markdownの画像リンク ![alt](url) を削除"""
    return re.sub(r'!\[([^\]]*)\]\(([^)]*)\)', '', text)

def main(paper_name: str = "Nishimura2023"):
    Settings.llm = OpenAI(model="gpt-4o-mini", temperature=0.1)
    Settings.embed_model = OpenAIEmbedding(model="text-embedding-3-small")

    # 1. 論文MDの読み込みとクリーニング
    try:
        file_path = find_paper(paper_name)
    except FileNotFoundError as e:
        print(f"Error: {e}")
        return

    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    content = re.sub(r'%%.*?%%', '', content, flags=re.DOTALL)
    content = re.sub(r'(^#+)', r'\n\1', content, flags=re.MULTILINE)

    doc = Document(text=content, metadata={"file_name": os.path.basename(file_path)})

    # --- 【SPEED OPTIMIZATION 2】 二段階パースで処理を軽量化 ---
    # --- 【改善】 パースとインデックス作成 ---
    # 2. 構造パース
    md_parser = MarkdownNodeParser()
    # 構造に基づきノード化
    all_nodes = md_parser.get_nodes_from_documents([doc])

    # 【改善】Main Textセクション（# 4）に含まれるノードのみを抽出
    # lower() を使い、大文字小文字の揺れを許容する
    nodes = [
        node for node in all_nodes
        if "main text" in str(node.metadata.get("header_path", "")).lower()
        or "#4" in str(node.metadata.get("header_path", ""))
    ]
    # フィルタリング結果の確認
    if nodes:
        print(f"Filtered {len(nodes)} Main text nodes")
        # 【重要】各ノードから ## セクション名を抽出してメタデータに追加
        def extract_section_name(text: str) -> str:
            """ノードテキストから ## セクション名を抽出"""
            match = re.search(r'^##\s+(.+?)(?:\n|$)', text, re.MULTILINE)
            return match.group(1).strip() if match else "Main Text"

        def split_by_paragraphs(node):
            """ノードを段落ごとに分割
            ## セクション → ### 中段落 → 二重改行で小段落
            """
            content = node.get_content()
            original_header_path = node.metadata.get("header_path", "")

            # ## ヘッダーがなく ### のみのノード（例：9.1. のようなサブセクション）
            if not re.search(r'^##(?!#)', content, re.MULTILINE):
                h3_match = re.search(r'^###\s+(.+?)(?:\n|$)', content, re.MULTILINE)
                if not h3_match:
                    return []
                subsec_name = h3_match.group(1).strip()
                if subsec_name.lower() in ["references", "abbreviations"]:
                    return []
                content_body = re.sub(r'^###[^\n]*\n?', '', content, count=1, flags=re.MULTILINE)
                paragraphs = [p.strip() for p in re.split(r'\n\n+', content_body.strip()) if p.strip()]

                # 元々のheader_pathから## レベルを抽出
                original_header_path = node.metadata.get("header_path", "")
                # パスの最後の部分を取得 ('/4 Main Text/Methods/' → 'Methods')
                parts = original_header_path.strip('/').split('/')
                h2_name = parts[-1] if parts and len(parts) > 1 else ""
                header_prefix = f"## {h2_name}" if h2_name else ""

                return [
                    Document(text=remove_image_links(para), metadata={
                        "section_name": h2_name if h2_name else "Unknown",
                        "header_path": f"{header_prefix} > ### {subsec_name}" if header_prefix else f"### {subsec_name}",
                        "paragraph_number": i
                    })
                    for i, para in enumerate(paragraphs, 1)
                ]

            section = extract_section_name(content)
            # References と Abbreviations は除外
            if section.lower() in ["references", "abbreviations"]:
                return []

            # ## セクションで分割
            subsections = re.split(r'(?=^##)', content, flags=re.MULTILINE)

            docs = []
            for subsection in subsections:
                if not subsection.strip():
                    continue

                # ## ヘッダーを抽出
                subsec_match = re.search(r'^##\s+(.+?)(?:\n|$)', subsection, re.MULTILINE)
                if not subsec_match:
                    # ## ヘッダーがない場合はスキップ（最初の空きテキストなど）
                    continue

                subsec_name = subsec_match.group(1).strip()

                # ## ヘッダー行を削除（末尾改行なしにも対応）
                content_without_header = re.sub(r'^##[^\n]*\n?', '', subsection, count=1, flags=re.MULTILINE)

                # ### 中段落で分割
                subsubsections = re.split(r'(?=^###)', content_without_header, flags=re.MULTILINE)

                # パターン判定：### があるかどうか
                has_subsubsec = any(re.search(r'^###', s, re.MULTILINE) for s in subsubsections)

                if not has_subsubsec:
                    # パターン1：## 直下に内容がある（### がない）
                    text = content_without_header.strip()
                    if text:
                        # 二重改行で小段落に分割
                        paragraphs = re.split(r'\n\n+', text)
                        paragraphs = [p.strip() for p in paragraphs if p.strip()]

                        # 各段落を Document に
                        for i, para in enumerate(paragraphs, 1):
                            doc = Document(
                                text=remove_image_links(para),
                                metadata={
                                    "section_name": subsec_name,
                                    "header_path": f"## {subsec_name}",
                                    "paragraph_number": i
                                }
                            )
                            docs.append(doc)
                else:
                    # パターン2：## の下が ### で分割される
                    for subsubsection in subsubsections:
                        if not subsubsection.strip():
                            continue

                        # ### ヘッダーを抽出
                        subsubsec_match = re.search(r'^###\s+(.+?)(?:\n|$)', subsubsection, re.MULTILINE)
                        if not subsubsec_match:
                            # ### ヘッダーがない場合はスキップ
                            continue

                        subsubsec_name = subsubsec_match.group(1).strip()
                        # ### ヘッダー行を削除（末尾改行なしにも対応）
                        text = re.sub(r'^###[^\n]*\n?', '', subsubsection, count=1, flags=re.MULTILINE)

                        # 二重改行で小段落に分割
                        paragraphs = re.split(r'\n\n+', text.strip())
                        paragraphs = [p.strip() for p in paragraphs if p.strip()]

                        # 各段落を Document に
                        for i, para in enumerate(paragraphs, 1):
                            doc = Document(
                                text=remove_image_links(para),
                                metadata={
                                    "section_name": subsec_name,
                                    "header_path": f"## {subsec_name} > ### {subsubsec_name}",
                                    "paragraph_number": i
                                }
                            )
                            docs.append(doc)

            return docs

        # 各ノードを段落ごとに分割
        final_nodes = []
        for node in nodes:
            final_nodes.extend(split_by_paragraphs(node))
    else:
        print("Warning: Main text nodes not found.")
        final_nodes = []

    # 【重要】メタデータをベクトル化から除外（テキストのみで検索）
    for node in final_nodes:
        node.excluded_embed_metadata_keys = ["section_name", "header_path", "paragraph_number"]
        node.excluded_llm_metadata_keys = ["section_name", "header_path", "paragraph_number"]

    # 3. インデックス構築
    print(f"Building index with {len(final_nodes)} nodes...")
    print("Note: Metadata excluded from embedding - text-based search only")
    index = VectorStoreIndex(final_nodes)

    # セクション名をMDでの出現順で取得（重複なし）
    seen = set()
    unique_sections = []
    for node in final_nodes:
        section = node.metadata.get("section_name", "Unknown")
        if section and section not in seen:
            unique_sections.append(section)
            seen.add(section)

    section_flag_map = {}
    flag_to_section = {}
    for section in unique_sections:
        # セクション名の先頭文字をフラグとする（例：Results → r）
        flag = section[0].lower()
        section_flag_map[section] = flag
        flag_to_section[flag] = section

    # 利用可能なセクションを表示
    print("\n【利用可能なセクション】")
    for section in unique_sections:
        flag = section_flag_map[section]
        print(f"  -{flag}: {section}")
    print("（クエリに -r -m のように付加して複数指定可能）\n")

    # 5. クエリエンジン（以下、対話ログ保存ロジックは同じ）
    query_engine = index.as_query_engine(
        similarity_top_k=3,
        response_mode="compact",
        streaming=True
    )

    # (以下、対話ログ保存ロジックは維持)
    # 保存ファイル名の生成（1回の起動ごとに1ファイル、デバイス名を含める）
    output_dir = Path.home() / "Dropbox/obsidian/50_coding/llamaindex"
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    device_name = socket.gethostname()
    output_file = output_dir / f"{timestamp}_dialogue_{paper_name}_{device_name}.md"

    print(f"--- 論文 RAG 起動: {paper_name} (テキストのみモード) ---\n")

    turn = 1

    def parse_query_and_sections(query: str) -> tuple[str, list[str]]:
        """クエリからセクション指定フラグを抽出
        Returns: (クエリテキスト, セクション指定リスト)
        """
        flags = re.findall(r'-([a-z]+)', query)
        clean_query = re.sub(r'-[a-z]+', '', query).strip()

        sections = []
        for flag in flags:
            if flag in flag_to_section:
                sections.append(flag_to_section[flag])

        return clean_query, sections

    while True:
        query = input(f"\n[{turn}] Q: ") # turnを表示
        if query.lower() in ["exit", "q"]: break

        # クエリとセクション指定を分離
        clean_query, target_sections = parse_query_and_sections(query)

        # 日本語判定と英訳
        search_query = clean_query
        is_japanese_query = is_japanese(clean_query)

        if is_japanese_query:
            print(f"  日本語クエリを検出、英訳中...")
            search_query = translate_to_english(clean_query)
            print(f"  英訳クエリ: {search_query}")

        if target_sections:
            print(f"  検索対象セクション: {', '.join(target_sections)}")

        # セクション指定がある場合はノードをフィルタリング
        if target_sections:
            filtered_nodes = [
                node for node in final_nodes
                if node.metadata.get("section_name") in target_sections
            ]
            if filtered_nodes:
                filtered_index = VectorStoreIndex(filtered_nodes)
                filtered_query_engine = filtered_index.as_query_engine(
                    similarity_top_k=3,
                    response_mode="compact",
                    streaming=True
                )
                response = filtered_query_engine.query(search_query)
            else:
                print(f"  警告: 指定されたセクションにノードが見つかりません")
                response = query_engine.query(search_query)
        else:
            response = query_engine.query(search_query)

        # 回答表示（ストリーミング）
        full_response = ""
        for text in response.response_gen:
            print(text, end="", flush=True)
            full_response += text
        print("\n")

        # 【改善】参照元を個別に score とともに記録（ファイル出力用）
        source_details = []
        for i, node in enumerate(response.source_nodes, 1):
            path = node.node.metadata.get("header_path", "不明")
            para_num = node.node.metadata.get("paragraph_number", "?")
            score = node.score if hasattr(node, 'score') else 0.0
            content = node.get_content()

            source_str = f"{path} 第{para_num}段落 (score: {score:.4f})"
            source_details.append(f"【参照元 {i}】{source_str}\n{content}\n")

        # 3. ファイルへの書き込み（turn変数がここで活きる）
        with open(output_file, "a", encoding="utf-8") as f:
            if turn == 1:
                f.write(f"# Dialogue with {paper_name} (Text-only mode)\nDate: {timestamp}\n\n")

            f.write(f"## Q{turn}: {query}\n")
            if is_japanese_query:
                f.write(f"*(英訳: {search_query})*\n")
            if target_sections:
                f.write(f"*(対象セクション: {', '.join(target_sections)})*\n")
            f.write("\n")
            f.write(f"**Answer**:\n{full_response}\n\n")
            f.write(f"**Source Details**:\n\n")
            f.write("".join(source_details))
            f.write("\n---\n\n")

        # 【重要】ループの最後でカウントアップ
        turn += 1

if __name__ == "__main__":
    if len(sys.argv) > 1:
        paper_name = sys.argv[1]
    else:
        paper_name = input("文献名を入力してください: ")
    main(paper_name)
