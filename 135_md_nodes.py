"""
130_md_single_rag.py のnode分けをデバッグするスクリプト
node分けの各段階をファイルに出力して、Lubahn2006とNishimura2023の差を調査
"""
import os
import sys
import re
from pathlib import Path
from dotenv import load_dotenv
from llama_index.core import Document
from llama_index.core.node_parser import MarkdownNodeParser

load_dotenv()

def find_paper(paper_name: str) -> str:
    base_path = Path.home() / "Dropbox/obsidian/10_article"
    for root, _, files in os.walk(base_path):
        for file in files:
            if file.startswith(paper_name) and file.endswith(".md"):
                return os.path.join(root, file)
    raise FileNotFoundError(f"論文 '{paper_name}' が見つかりません")

def debug_nodes(paper_name: str = "Nishimura2023"):
    """node分けのデバッグ出力"""

    # ファイル読み込み
    try:
        file_path = find_paper(paper_name)
    except FileNotFoundError as e:
        print(f"Error: {e}")
        return

    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # クリーニング前の状態を保存
    original_content = content

    # クリーニング
    content = re.sub(r'%%.*?%%', '', content, flags=re.DOTALL)
    content = re.sub(r'(^#+)', r'\n\1', content, flags=re.MULTILINE)

    doc = Document(text=content, metadata={"file_name": os.path.basename(file_path)})

    # MarkdownNodeParser で第1段階のノード化
    md_parser = MarkdownNodeParser()
    all_nodes = md_parser.get_nodes_from_documents([doc])

    # Main Text フィルタリング
    nodes = [
        node for node in all_nodes
        if "main text" in str(node.metadata.get("header_path", "")).lower()
        or "#4" in str(node.metadata.get("header_path", ""))
    ]

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

    if nodes:
        final_nodes = []
        for node in nodes:
            final_nodes.extend(split_by_paragraphs(node))
    else:
        final_nodes = []

    # デバッグ出力をファイルに保存
    output_file = Path.cwd() / f"debug_nodes_{paper_name}.txt"

    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(f"=" * 80 + "\n")
        f.write(f"NODE PARSING DEBUG: {paper_name}\n")
        f.write(f"=" * 80 + "\n\n")

        # 0. クリーニング前後の確認
        f.write(f"【0】クリーニング前後の比較\n")
        f.write("-" * 80 + "\n")
        f.write(f"Original content length: {len(original_content)} chars\n")
        f.write(f"Cleaned content length: {len(content)} chars\n\n")

        # ## セクションを探す（クリーニング前）
        original_sections = re.findall(r'^##\s+(.+?)$', original_content, re.MULTILINE)
        cleaned_sections = re.findall(r'^##\s+(.+?)$', content, re.MULTILINE)
        f.write(f"Original sections found: {original_sections}\n")
        f.write(f"Cleaned sections found: {cleaned_sections}\n")

        if original_sections != cleaned_sections:
            f.write(f"⚠️ WARNING: セクション名が変わっています！\n")
        f.write("\n")

        # 1. 全ノード情報
        f.write(f"【1】全ノード数: {len(all_nodes)}\n")
        f.write("-" * 80 + "\n")
        for i, node in enumerate(all_nodes[:20]):  # 最初の20個
            f.write(f"\nNode {i}:\n")
            f.write(f"  header_path: {node.metadata.get('header_path', 'N/A')}\n")
            f.write(f"  content length: {len(node.get_content())} chars\n")
            f.write(f"  first 100 chars: {node.get_content()[:100]}\n")
        if len(all_nodes) > 20:
            f.write(f"\n... and {len(all_nodes) - 20} more nodes\n")

        # 2. Main Text フィルタリング結果
        f.write(f"\n\n【2】Main Text フィルタリング後: {len(nodes)} nodes\n")
        f.write("-" * 80 + "\n")
        for i, node in enumerate(nodes[:10]):  # 最初の10個
            f.write(f"\nFiltered Node {i}:\n")
            f.write(f"  header_path: {node.metadata.get('header_path', 'N/A')}\n")
            f.write(f"  content length: {len(node.get_content())} chars\n")
            f.write(f"  first 150 chars:\n{node.get_content()[:150]}\n")
        if len(nodes) > 10:
            f.write(f"\n... and {len(nodes) - 10} more filtered nodes\n")

        # 3. 最終的な分割ノード情報
        f.write(f"\n\n【3】SentenceSplitter 後: {len(final_nodes)} nodes\n")
        f.write("-" * 80 + "\n")
        for i, node in enumerate(final_nodes[:15]):  # 最初の15個
            f.write(f"\nFinal Node {i}:\n")
            f.write(f"  header_path: {node.metadata.get('header_path', 'N/A')}\n")
            f.write(f"  content length: {len(node.get_content())} chars\n")
            f.write(f"  content:\n{node.get_content()}\n")
            f.write("-" * 40 + "\n")
        if len(final_nodes) > 15:
            f.write(f"\n... and {len(final_nodes) - 15} more final nodes\n")

        # 4. header_path の確認（セクション名を含む）
        f.write(f"\n\n【4】header_path（セクション名を含む）\n")
        f.write("-" * 80 + "\n")
        for i, node in enumerate(final_nodes[:15]):
            header_path = node.metadata.get("header_path", "不明")
            section = node.metadata.get("section_name", "Main Text")
            f.write(f"Final Node {i}: header_path='{header_path}' | section='{section}'\n")

        # 5. 段落分けの分析（各セクション内で空行x2による分割）
        f.write(f"\n\n【5】段落分けの分析（セクション内での空行による分割）\n")
        f.write("-" * 80 + "\n")

        # セクションごとにノードをカウント
        section_nodes = {}
        for node in final_nodes:
            section = node.metadata.get("section_name", "不明")
            if section not in section_nodes:
                section_nodes[section] = []
            section_nodes[section].append(node)

        # 結果を出力
        for section in sorted(section_nodes.keys()):
            node_list = section_nodes[section]
            f.write(f"\n【{section}】 段落数: {len(node_list)}\n")
            for i, node in enumerate(node_list[:5], 1):
                content = node.get_content()[:80].replace('\n', ' ')
                f.write(f"  段落{i}: {content}...\n")
            if len(node_list) > 5:
                f.write(f"  ... and {len(node_list) - 5} more\n")
            f.write("\n")

    print(f"[OK] デバッグ出力ファイル: {output_file}")
    print(f"   All nodes: {len(all_nodes)}")
    print(f"   Filtered nodes: {len(nodes)}")
    print(f"   Final nodes: {len(final_nodes)}")

    # コンソールにも段落数サマリーを表示
    section_paragraphs = {}
    for node in final_nodes:
        section = node.metadata.get("section_name", "不明")
        if section not in section_paragraphs:
            section_paragraphs[section] = 0
        section_paragraphs[section] += 1

    print("\n【段落分けのサマリー】")
    for section in sorted(section_paragraphs.keys()):
        count = section_paragraphs[section]
        print(f"  {section}: {count} 段落")

if __name__ == "__main__":
    paper_name = sys.argv[1] if len(sys.argv) > 1 else "Nishimura2023"
    debug_nodes(paper_name)
