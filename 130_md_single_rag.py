import os
import sys
import re
from datetime import datetime
from dotenv import load_dotenv
from llama_index.core import SimpleDirectoryReader, VectorStoreIndex, Settings, Document
from llama_index.core.node_parser import MarkdownNodeParser, SentenceSplitter
from llama_index.llms.openai import OpenAI
from llama_index.embeddings.openai import OpenAIEmbedding

load_dotenv()

def find_paper(paper_name: str) -> str:
    base_path = "/Users/taichishimizu/Library/CloudStorage/Dropbox/obsidian/10_article"
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
    # 巨大なセクション（Discussion等）を検索に適したサイズに刻む
    text_splitter = SentenceSplitter(chunk_size=512, chunk_overlap=50)
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
        # Node を Document に変換して再分割
        docs_from_nodes = [
            Document(text=node.get_content(), metadata=node.metadata)
            for node in nodes
        ]
        final_nodes = text_splitter.get_nodes_from_documents(docs_from_nodes)
    else:
        print("Warning: Main text nodes not found. Using all nodes.")
        docs_from_nodes = [
            Document(text=node.get_content(), metadata=node.metadata)
            for node in all_nodes
        ]
        final_nodes = text_splitter.get_nodes_from_documents(docs_from_nodes)

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
    # 保存ファイル名の生成（1回の起動ごとに1ファイル）
    output_dir = "/Users/taichishimizu/Library/CloudStorage/Dropbox/obsidian/50_coding/llamaindex"
    os.makedirs(output_dir, exist_ok=True)
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    output_file = os.path.join(output_dir, f"dialogue_{paper_name}_{timestamp}.md")

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

        # 【改善】参照元の詳細表示
        # header_path に "/4 Main Text/Discussion" 等が入るようになる
        sources = []
        for node in response.source_nodes:
            path = node.node.metadata.get("header_path", "不明")
            if path not in sources:
                sources.append(path)
        
        print(f"【参照元】: {', '.join(sources)}")

        # 3. ファイルへの書き込み（turn変数がここで活きる）
        with open(output_file, "a", encoding="utf-8") as f:
            if turn == 1:
                f.write(f"# Dialogue with {paper_name}\nDate: {timestamp}\n\n")

            f.write(f"## Q{turn}: {query}\n\n")
            f.write(f"**Answer**:\n{full_response}\n\n")
            f.write(f"**Sources**:\n- " + "\n- ".join(sources) + "\n\n")
            f.write("---\n\n")

        # 【重要】ループの最後でカウントアップ
        turn += 1

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "Nishimura2023")