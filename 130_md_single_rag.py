# mac 0415
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
            if file.startswith(paper_name) and file.endswith(".md"):
                return os.path.join(root, file)
    raise FileNotFoundError(f"論文 '{paper_name}' が見つかりません")

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
            section = extract_section_name(node.get_content())
            # References だけは除外
            if section.lower() == "references":
                return []

            content = node.get_content()

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

                # ## ヘッダー行を削除（改行まで）
                content_without_header = re.sub(r'^##[^\n]*\n', '', subsection, count=1, flags=re.MULTILINE)

                # ### 中段落で分割
                subsubsections = re.split(r'(?=^###)', content_without_header, flags=re.MULTILINE)

                for subsubsection in subsubsections:
                    if not subsubsection.strip():
                        continue

                    # ### ヘッダーを抽出（存在する場合）
                    subsubsec_match = re.search(r'^###\s+(.+?)(?:\n|$)', subsubsection, re.MULTILINE)
                    if subsubsec_match:
                        subsubsec_name = subsubsec_match.group(1).strip()
                        # ### ヘッダー行を削除（改行まで）
                        text = re.sub(r'^###[^\n]*\n', '', subsubsection, count=1, flags=re.MULTILINE)
                    else:
                        subsubsec_name = subsec_name
                        text = subsubsection

                    # 二重改行で小段落に分割
                    paragraphs = re.split(r'\n\n+', text.strip())
                    # 空白段落を除去
                    paragraphs = [p.strip() for p in paragraphs if p.strip()]

                    # 各段落を Document に
                    for i, para in enumerate(paragraphs, 1):
                        doc = Document(
                            text=para,
                            metadata={
                                "section_name": subsubsec_name,
                                "header_path": f"## {subsec_name}",
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

    # 3. インデックス構築
    print(f"Building index with {len(final_nodes)} nodes...")
    index = VectorStoreIndex(final_nodes)

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

    print(f"\n--- 論文 RAG 起動: {paper_name} ---")

    turn = 1 

    while True:
        query = input(f"\n[{turn}] Q: ") # turnを表示
        if query.lower() in ["exit", "q"]: break

        response = query_engine.query(query)
        
        # 回答表示（ストリーミング）
        full_response = ""
        for text in response.response_gen:
            print(text, end="", flush=True)
            full_response += text
        print("\n")

        # 【改善】参照元を個別に score とともに記録（ファイル出力用）
        # header_path から セクション名を抽出（形式: "## Introduction"）
        source_details = []
        for i, node in enumerate(response.source_nodes, 1):
            path = node.node.metadata.get("header_path", "不明")
            # "## Results" のような形式から "Results" を抽出
            match = re.search(r'##\s+(.+?)$', path)
            section = match.group(1).strip() if match else path
            score = node.score if hasattr(node, 'score') else 0.0
            content = node.get_content()

            source_str = f"{section} (score: {score:.4f})"
            source_details.append(f"【参照元 {i}】{source_str}\n{content}\n")

        # 3. ファイルへの書き込み（turn変数がここで活きる）
        with open(output_file, "a", encoding="utf-8") as f:
            if turn == 1:
                f.write(f"# Dialogue with {paper_name}\nDate: {timestamp}\n\n")

            f.write(f"## Q{turn}: {query}\n\n")
            f.write(f"**Answer**:\n{full_response}\n\n")
            f.write(f"**Source Details**:\n\n")
            f.write("".join(source_details))
            f.write("\n---\n\n")

        # 【重要】ループの最後でカウントアップ
        turn += 1

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "Nishimura2023")