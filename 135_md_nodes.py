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
            if file.lower().startswith(paper_name.lower()) and file.endswith(".md"):
                return os.path.join(root, file)
    raise FileNotFoundError(f"論文 '{paper_name}' が見つかりません")

def debug_nodes(paper_name: str = "Konopka2016"):
    """node分けのデバッグ出力"""

    # ファイル読み込み
    try:
        file_path = find_paper(paper_name)
    except FileNotFoundError as e:
        print(f"Error: {e}")
        return

    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # クリーニング
    content = re.sub(r'%%.*?%%', '', content, flags=re.DOTALL)
    content = re.sub(r'(^#+)', r'\n\1', content, flags=re.MULTILINE)

    doc = Document(text=content, metadata={"file_name": os.path.basename(file_path)})

    # 「# 4 Main Text」以降のみを抽出して新しいdocを作成
    content_full = doc.get_content()
    main_text_match = re.search(r'^#\s+4\s+Main\s+Text', content_full, re.MULTILINE)

    if main_text_match:
        main_text_content = content_full[main_text_match.start():]
        doc_main_text = Document(
            text=main_text_content,
            metadata={"file_name": os.path.basename(file_path), "section": "Main Text"}
        )
    else:
        print(f"警告: '# 4 Main Text' が見つかりませんでした")
        doc_main_text = None
        return

    # MarkdownNodeParser で第1段階のノード化（doc_main_text を使用）
    md_parser = MarkdownNodeParser()
    nodes = md_parser.get_nodes_from_documents([doc_main_text])

    # 【重要】各ノードから ## セクション名を抽出してメタデータに追加
    def extract_section_name(text: str) -> str:
        """ノードテキストから ## セクション名を抽出"""
        match = re.search(r'^##\s+(.+?)(?:\n|$)', text, re.MULTILINE)
        return match.group(1).strip() if match else "Main Text"

    def split_by_paragraphs(node):
        """ノードを段落ごとに分割、セクション情報も記録
        ## セクション → ### 中段落 → 二重改行で小段落
        戻り値：(docs, sections_dict)
        """
        content = node.get_content()
        sections_dict = {}

        # ## ヘッダーがなく ### のみのノード（例：9.1. のようなサブセクション）
        if not re.search(r'^##(?!#)', content, re.MULTILINE):
            h3_match = re.search(r'^###\s+(.+?)(?:\n|$)', content, re.MULTILINE)
            if not h3_match:
                return [], {}
            subsec_name = h3_match.group(1).strip()
            if subsec_name.lower() == "references":
                return [], {}
            content_body = re.sub(r'^###[^\n]*\n?', '', content, count=1, flags=re.MULTILINE)
            paragraphs = [p.strip() for p in re.split(r'\n\n+', content_body.strip()) if p.strip()]

            # 元々のheader_pathから## レベルを抽出
            original_header_path = node.metadata.get("header_path", "")
            # パスの最後の部分を取得 ('/4 Main Text/Methods/' → 'Methods')
            parts = original_header_path.strip('/').split('/')
            h2_name = parts[-1] if parts and len(parts) > 1 else ""
            header_prefix = f"## {h2_name}" if h2_name else ""

            docs = [
                Document(text=para, metadata={
                    "section_name": subsec_name,
                    "header_path": f"{header_prefix} > ### {subsec_name}" if header_prefix else f"### {subsec_name}",
                    "paragraph_number": i
                })
                for i, para in enumerate(paragraphs, 1)
            ]
            section_key = f"{header_prefix} > ### {subsec_name}" if header_prefix else f"### {subsec_name}"
            sections_dict[section_key] = len(paragraphs)
            return docs, sections_dict

        section = extract_section_name(content)
        # References だけは除外
        if section.lower() == "references":
            return [], {}

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
            header_prefix = f"## {subsec_name}"

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
                            text=para,
                            metadata={
                                "section_name": subsec_name,
                                "header_path": header_prefix,
                                "paragraph_number": i
                            }
                        )
                        docs.append(doc)
                    sections_dict[header_prefix] = len(paragraphs)
                else:
                    # コンテンツがない場合も記録
                    sections_dict[header_prefix] = 0
            else:
                # パターン2：## の下が ### で分割される
                subsec_paragraph_count = 0
                for subsubsection in subsubsections:
                    if not subsubsection.strip():
                        continue

                    # ### ヘッダーを抽出
                    subsubsec_match = re.search(r'^###\s+(.+?)(?:\n|$)', subsubsection, re.MULTILINE)
                    if not subsubsec_match:
                        # ### ヘッダーがない場合はスキップ
                        continue

                    subsubsec_name = subsubsec_match.group(1).strip()
                    header_full = f"{header_prefix} > ### {subsubsec_name}"
                    # ### ヘッダー行を削除（末尾改行なしにも対応）
                    text = re.sub(r'^###[^\n]*\n?', '', subsubsection, count=1, flags=re.MULTILINE)

                    # 二重改行で小段落に分割
                    paragraphs = re.split(r'\n\n+', text.strip())
                    paragraphs = [p.strip() for p in paragraphs if p.strip()]

                    # 各段落を Document に
                    for i, para in enumerate(paragraphs, 1):
                        doc = Document(
                            text=para,
                            metadata={
                                "section_name": subsubsec_name,
                                "header_path": header_full,
                                "paragraph_number": i
                            }
                        )
                        docs.append(doc)
                    sections_dict[header_full] = len(paragraphs)
                    subsec_paragraph_count += len(paragraphs)

                # ## セクション自体も記録（### サブセクションの段落合計）
                sections_dict[header_prefix] = subsec_paragraph_count

        return docs, sections_dict

    if nodes:
        final_nodes = []
        all_sections = {}
        for node in nodes:
            docs, sections = split_by_paragraphs(node)
            final_nodes.extend(docs)
            all_sections.update(sections)
    else:
        final_nodes = []
        all_sections = {}

    # ## セクションの段落数を、配下の ### セクションの合計から再計算
    final_all_sections = {}
    for section, count in all_sections.items():
        if section.startswith("## ") and " > " not in section:
            # ## セクションの場合
            # 配下に > を含むセクションがあるかチェック
            has_children = any(
                s.startswith(f"{section} > ")
                for s in all_sections.keys()
            )
            if has_children:
                # 子セクションがある場合、合計を計算
                child_count = sum(
                    c for s, c in all_sections.items()
                    if s.startswith(f"{section} > ")
                )
                final_all_sections[section] = child_count
            else:
                # 子セクションがない場合、元々の値を保持
                final_all_sections[section] = count
        else:
            final_all_sections[section] = count
    all_sections = final_all_sections

    # デバッグ出力をファイルに保存
    output_file = Path.cwd() / f"debug_nodes_{paper_name}.txt"

    with open(output_file, 'w', encoding='utf-8') as f:
        # 段落分けの分析（各セクション内で空行x2による分割）
        f.write(f"【段落分けの分析】{paper_name}\n")
        f.write("=" * 80 + "\n\n")

        # セクションごとにノードをカウント
        section_nodes = {}
        for node in final_nodes:
            section = node.metadata.get("header_path", "不明")
            if section not in section_nodes:
                section_nodes[section] = []
            section_nodes[section].append(node)

        # 結果を出力（本文の順、内容のないセクションも含む）
        for section in all_sections.keys():
            count = all_sections[section]
            f.write(f"\n【{section}】 段落数: {count}\n")
            if section in section_nodes:
                node_list = section_nodes[section]
                for i, node in enumerate(node_list[:5], 1):
                    content = node.get_content()[:80].replace('\n', ' ')
                    f.write(f"  段落{i}: {content}...\n")
                if len(node_list) > 5:
                    f.write(f"  ... and {len(node_list) - 5} more\n")
            f.write("\n")

    print(f"[OK] デバッグ出力ファイル: {output_file}")
    print(f"   Parsed nodes: {len(nodes)}")
    print(f"   Final nodes: {len(final_nodes)}")

    # コンソールにも段落数サマリーを表示
    section_paragraphs = {}
    for node in final_nodes:
        section = node.metadata.get("header_path", "不明")
        if section not in section_paragraphs:
            section_paragraphs[section] = 0
        section_paragraphs[section] += 1

    print("\n【段落分けのサマリー】")
    for section in all_sections.keys():
        count = all_sections[section]
        # ### セクションはインデント表示（> を含むセクション）
        if " > ### " in section:
            # ## > ### 形式は、通常のインデント
            print(f"    {section}: {count} 段落")
        elif section.startswith("### "):
            # ### のみのセクション
            print(f"    {section}: {count} 段落")
        else:
            # ## セクション
            print(f"  {section}: {count} 段落")

if __name__ == "__main__":
    paper_name = sys.argv[1] if len(sys.argv) > 1 else "Konopka2016"
    debug_nodes(paper_name)
