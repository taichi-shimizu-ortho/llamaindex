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

    # クリーニング
    content = re.sub(r'%%.*?%%', '', content, flags=re.DOTALL)
    content = re.sub(r'(^#+)', r'\n\1', content, flags=re.MULTILINE)

    doc = Document(text=content, metadata={"file_name": os.path.basename(file_path)})

    # デバッグ: doc の内容をファイルに出力
    output_doc_file = Path.cwd() / f"debug_doc_{paper_name}.txt"
    with open(output_doc_file, 'w', encoding='utf-8') as f:
        f.write(f"=== DOC オブジェクト内容 ===\n")
        f.write(f"ファイル名: {paper_name}\n")
        f.write(f"メタデータ: {doc.metadata}\n")
        f.write(f"コンテンツ長: {len(doc.get_content())} 文字\n")
        f.write(f"\n{'='*80}\n")
        f.write(f"フルコンテンツ:\n")
        f.write(f"{'='*80}\n\n")
        f.write(doc.get_content())

    print(f"[OK] doc内容をファイルに出力: {output_doc_file}")
    print(f"  メタデータ: {doc.metadata}")
    print(f"  コンテンツ長: {len(doc.get_content())} 文字\n")

    # 「# 4 Main Text」以降のみを抽出して新しいdocを作成
    content_full = doc.get_content()
    main_text_match = re.search(r'^#\s+4\s+Main\s+Text', content_full, re.MULTILINE)

    if main_text_match:
        main_text_content = content_full[main_text_match.start():]
        doc_main_text = Document(
            text=main_text_content,
            metadata={"file_name": os.path.basename(file_path), "section": "Main Text"}
        )

        # Main Text docをファイルに出力
        output_main_text_file = Path.cwd() / f"debug_doc_main_text_{paper_name}.txt"
        with open(output_main_text_file, 'w', encoding='utf-8') as f:
            f.write(f"=== Main Text セクションのみ ===\n")
            f.write(f"ファイル名: {paper_name}\n")
            f.write(f"メタデータ: {doc_main_text.metadata}\n")
            f.write(f"コンテンツ長: {len(doc_main_text.get_content())} 文字\n")
            f.write(f"\n{'='*80}\n")
            f.write(f"Main Text コンテンツ:\n")
            f.write(f"{'='*80}\n\n")
            f.write(doc_main_text.get_content())

        print(f"[OK] Main Text docをファイルに出力: {output_main_text_file}")
        print(f"  コンテンツ長: {len(doc_main_text.get_content())} 文字\n")
    else:
        print("警告: '# 4 Main Text' が見つかりませんでした\n")
        doc_main_text = None

    # MarkdownNodeParser で第1段階のノード化（doc_main_text を使用）
    if doc_main_text is None:
        print("エラー: Main Text docが作成されていません")
        return

    md_parser = MarkdownNodeParser()
    nodes = md_parser.get_nodes_from_documents([doc_main_text])

    # MarkdownNodeParser後のノード情報をデバッグ出力
    parser_debug_file = Path.cwd() / f"debug_parser_nodes_{paper_name}.txt"
    with open(parser_debug_file, 'w', encoding='utf-8') as f:
        f.write(f"=== MarkdownNodeParser 出力ノード情報 ===\n")
        f.write(f"総ノード数: {len(nodes)}\n\n")
        for i, node in enumerate(nodes):
            f.write(f"【Node {i}】\n")
            f.write(f"  header_path: {node.metadata.get('header_path', 'N/A')}\n")
            f.write(f"  content length: {len(node.get_content())} chars\n")
            f.write(f"  content preview: {node.get_content()[:150].replace(chr(10), ' ')}...\n\n")
    print(f"[OK] parser_nodes debug: {parser_debug_file}")

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
        section = extract_section_name(content)

        # References と Abbreviations は除外
        if section.lower() in ["references", "abbreviations"]:
            return []

        # ##レベルも###レベルもないノード（#レベルなど）はスキップ
        has_h2 = re.search(r'^##(?!#)', content, re.MULTILINE)
        has_h3 = re.search(r'^###', content, re.MULTILINE)
        if not has_h2 and not has_h3:
            return []

        # header_path から ## レベルを抽出（###ノードの場合に必要）
        header_path = node.metadata.get("header_path", "")
        h2_section = None
        if header_path:
            # 末尾の'/'を除いて分割
            parts = [p for p in header_path.strip('/').split('/') if p]
            # ###ノード（##がない）の場合、parts[-1]が##レベル
            # ##ノードの場合も、parts[-1]が##レベル
            if len(parts) >= 1:
                h2_section = parts[-1]

        # ###ノード（##がない場合）の処理
        if not has_h2:
            h3_match = re.search(r'^###\s+(.+?)(?:\n|$)', content, re.MULTILINE)
            if h3_match:
                # ###ノードの場合は、##レベルはheader_pathから、###レベルはcontent から取得
                h2_name = h2_section if h2_section else section
                h3_name = h3_match.group(1).strip()

                # ### ヘッダー行を削除
                content_body = re.sub(r'^###[^\n]*\n?', '', content, count=1, flags=re.MULTILINE)
                paragraphs = [p.strip() for p in re.split(r'\n\n+', content_body.strip()) if p.strip()]

                docs = []
                for i, para in enumerate(paragraphs, 1):
                    doc = Document(
                        text=para,
                        metadata={
                            "section_name": h2_name,
                            "header_path": f"## {h2_name} > ### {h3_name}",
                            "paragraph_number": i
                        }
                    )
                    docs.append(doc)
                return docs
            else:
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

            # ## ヘッダー行を削除（改行まで）
            content_without_header = re.sub(r'^##[^\n]*\n', '', subsection, count=1, flags=re.MULTILINE)

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
                                "header_path": f"## {subsec_name}",
                                "paragraph_number": i
                            }
                        )
                        docs.append(doc)
            else:
                # パターン2：## の下が ### で分割される
                for idx, subsubsection in enumerate(subsubsections):
                    if not subsubsection.strip():
                        continue

                    # ### ヘッダーを抽出
                    subsubsec_match = re.search(r'^###\s+(.+?)(?:\n|$)', subsubsection, re.MULTILINE)
                    if not subsubsec_match:
                        # ### ヘッダーがない場合（##直下の最初のテキスト）
                        if idx == 0:
                            text = subsubsection.strip()
                            if text:
                                paragraphs = re.split(r'\n\n+', text)
                                paragraphs = [p.strip() for p in paragraphs if p.strip()]
                                for i, para in enumerate(paragraphs, 1):
                                    doc = Document(
                                        text=para,
                                        metadata={
                                            "section_name": subsec_name,
                                            "header_path": f"## {subsec_name}",
                                            "paragraph_number": i
                                        }
                                    )
                                    docs.append(doc)
                        continue

                    subsubsec_name = subsubsec_match.group(1).strip()
                    # ### ヘッダー行を削除
                    text = re.sub(r'^###[^\n]*\n', '', subsubsection, count=1, flags=re.MULTILINE)

                    # 二重改行で小段落に分割
                    paragraphs = re.split(r'\n\n+', text.strip())
                    paragraphs = [p.strip() for p in paragraphs if p.strip()]

                    # 各段落を Document に
                    for i, para in enumerate(paragraphs, 1):
                        doc = Document(
                            text=para,
                            metadata={
                                "section_name": subsec_name,
                                "header_path": f"## {subsec_name} > ### {subsubsec_name}",
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

    # メタデータの詳細確認（デバッグ用）
    metadata_file = Path.cwd() / f"debug_metadata_{paper_name}.txt"
    with open(metadata_file, 'w', encoding='utf-8') as f:
        f.write(f"=== メタデータ詳細確認 ===\n")
        f.write(f"論文: {paper_name}\n")
        f.write(f"総ノード数: {len(final_nodes)}\n\n")
        f.write("=" * 80 + "\n\n")

        for i, node in enumerate(final_nodes[:15]):  # 最初の15個を詳細表示
            f.write(f"【Node {i}】\n")
            f.write(f"  section_name: {node.metadata.get('section_name', 'N/A')}\n")
            f.write(f"  header_path: {node.metadata.get('header_path', 'N/A')}\n")
            f.write(f"  paragraph_number: {node.metadata.get('paragraph_number', 'N/A')}\n")
            f.write(f"  content length: {len(node.get_content())} chars\n")
            f.write(f"  content preview: {node.get_content()[:100].replace(chr(10), ' ')}...\n")
            f.write("\n")

        if len(final_nodes) > 15:
            f.write(f"... and {len(final_nodes) - 15} more nodes\n")

    print(f"[OK] メタデータ確認ファイル: {metadata_file}")

    # デバッグ出力をファイルに保存
    output_file = Path.cwd() / f"debug_nodes_{paper_name}.txt"

    with open(output_file, 'w', encoding='utf-8') as f:
        # 段落分けの分析（各セクション内で空行x2による分割）
        f.write(f"【段落分けの分析】{paper_name}\n")
        f.write("=" * 80 + "\n\n")

        # セクションごとにノードをカウント
        section_nodes = {}
        for node in final_nodes:
            section = node.metadata.get("section_name", "不明")
            if section not in section_nodes:
                section_nodes[section] = []
            section_nodes[section].append(node)

        # 結果を出力（自然ソート）
        def natural_sort_key(text):
            return [int(c) if c.isdigit() else c.lower() for c in re.split(r'(\d+)', text)]

        for section in sorted(section_nodes.keys(), key=natural_sort_key):
            node_list = section_nodes[section]
            f.write(f"\n【{section}】 段落数: {len(node_list)}\n")
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
        section = node.metadata.get("section_name", "不明")
        if section not in section_paragraphs:
            section_paragraphs[section] = 0
        section_paragraphs[section] += 1

    print("\n【段落分けのサマリー】")
    # 自然ソート（数字を数値として扱う）
    import re as regex_module
    def natural_sort_key(text):
        return [int(c) if c.isdigit() else c.lower() for c in regex_module.split(r'(\d+)', text)]

    for section in sorted(section_paragraphs.keys(), key=natural_sort_key):
        count = section_paragraphs[section]
        print(f"  {section}: {count} 段落")

if __name__ == "__main__":
    paper_name = sys.argv[1] if len(sys.argv) > 1 else "Nishimura2023"
    debug_nodes(paper_name)