"""
単一論文精読RAGシステム
MDファイルを直接読み込み、段落レベルのRAG検索結果をMarkdownファイルに出力
"""

import re
import yaml
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
load_dotenv(Path.home() / "uv-envs/llamaindex/.env")

from llama_index.core import Document, Settings, VectorStoreIndex
from llama_index.embeddings.openai import OpenAIEmbedding
from llama_index.llms.openai import OpenAI

# ══════════════════════════════════════════════════════════════════════════════
# ここを編集する
# ══════════════════════════════════════════════════════════════════════════════

# 対象MDファイル（obsidian/10_article/ 以下の任意のパス）
MD_FILE = Path.home() / "Dropbox/obsidian/10_article/general/Fujii2026.md"

# 検索対象セクションタイプ（ここに含まれないセクションはコンテキストに入らない）
# 選択肢: "intro" / "materials|methods" / "results" / "discussion" / "conclusion" / "other" / "review" / "references"
TARGET_SECTION_TYPES = [
    "intro",
    "materials|methods",
    "results",
    "discussion",
    "conclusion",
]

# JSONに出力するセクション（TARGET_SECTION_TYPESと独立して固定）
JSON_SECTION_TYPES = [
    "intro",
    "materials|methods",
    "results",
    "discussion",
    "conclusion",
]

# 検索クエリ
QUERIES = [
    "骨微細構造は皮質骨と海綿骨のどちらを評価しているか？",
    
]

# 各クエリで取得する引用元の数
TOP_K = 3

# HTMLテーブルをコンテキストに含めるか（False で除外）
INCLUDE_TABLES = False

# ══════════════════════════════════════════════════════════════════════════════

Settings.llm = OpenAI(model="gpt-5.4-nano", temperature=0.1)
Settings.embed_model = OpenAIEmbedding(model="text-embedding-3-large")


# ── MDパース関数 (article_rag.py より) ────────────────────────────────────────

def parse_frontmatter(content: str) -> tuple[Dict[str, Any], str]:
    """YAMLフロントマターをパース。(frontmatter_dict, 残りのコンテンツ) を返す"""
    pattern = r'^---\s*\n(.*?)\n---\s*\n(.*)$'
    match = re.match(pattern, content, re.DOTALL)
    if match:
        try:
            frontmatter = yaml.safe_load(match.group(1))
            return frontmatter or {}, match.group(2)
        except yaml.YAMLError as e:
            print(f"フロントマターのパースエラー: {e}")
            return {}, content
    return {}, content


def extract_info_block_metadata(content: str) -> Dict[str, Any]:
    """>[!Info] ブロックからメタデータを抽出"""
    metadata: Dict[str, Any] = {
        'first_author': '', 'authors': [], 'title': '', 'year': '',
        'journal': '', 'volume': '', 'issue': '', 'doi': '', 'citekey': ''
    }

    info_match = re.search(r'>\[!Info\](.*?)(?=\n(?!>)|$)', content, re.DOTALL)
    if not info_match:
        return metadata
    block = info_match.group(1)

    def find(pattern: str) -> str:
        m = re.search(pattern, block)
        return m.group(1).strip() if m else ''

    metadata['first_author'] = find(r'\*\*FirstAuthor\*\*::\s*([^>]+?)(?:\s*>|$)')
    metadata['authors'] = [
        a.strip()
        for a in re.findall(r'\*\*(?:First)?Author\*\*::\s*([^>]+?)(?:\s*>|$)', block)
        if a.strip()
    ]
    metadata['title']   = find(r'>\s*\*\*Title\*\*:\s*([^\n]+)')
    metadata['year']    = find(r'>\s*\*\*Year\*\*:\s*(\d+)')
    metadata['citekey'] = find(r'>\s*\*\*Citekey\*\*:\s*([^\n]+)')
    metadata['journal'] = find(r'>\s*\*\*Journal\*\*:\s*\*?([^\n*]+)\*?')
    metadata['volume']  = find(r'>\s*\*\*Volume\*\*:\s*([^\n]+)')
    metadata['issue']   = find(r'>\s*\*\*Issue\*\*:\s*([^\n]+)')
    metadata['doi']     = find(r'>\s*\*\*DOI\*\*:\s*([^\n]+)')
    return metadata


def extract_main_text_section(content: str) -> Optional[str]:
    """# 4 Main Text セクションを抽出"""
    match = re.search(
        r'# 4 Main Text\s*\n(.*?)(?=\n#(?![#\s])|$)',
        content, re.DOTALL | re.IGNORECASE
    )
    return match.group(1).strip() if match else None


def parse_main_text_frontmatter(main_text: str) -> tuple[Dict[str, Any], str]:
    """Main Text 内のYAMLフロントマターをパース"""
    pattern = r'^---\s*\n(.*?)\n---\s*\n(.*)$'
    match = re.match(pattern, main_text, re.DOTALL)
    if match:
        try:
            metadata = yaml.safe_load(match.group(1))
            return metadata or {}, match.group(2)
        except yaml.YAMLError as e:
            print(f"Main Textフロントマターのパースエラー: {e}")
            return {}, main_text
    return {}, main_text


def classify_section_type(section_title: str) -> str:
    """セクションタイトルからタイプを分類"""
    t = section_title.lower()
    if 'abstract'     in t: return 'abstract'
    if 'introduction' in t or t == 'intro': return 'intro'
    if 'method'       in t or 'material' in t or 'patient' in t: return 'materials|methods'
    if 'result'       in t: return 'results'
    if 'discussion'   in t: return 'discussion'
    if 'conclusion'   in t: return 'conclusion'
    if 'reference'    in t: return 'references'
    if 'acknowledgement' in t or 'acknowledgment' in t: return 'other'
    if 'conflict'     in t: return 'other'
    if 'funding'      in t: return 'other'
    if 'availability' in t: return 'other'
    return 'other'


def extract_subsections(section_content: str) -> List[Dict[str, Any]]:
    """h3ヘッダー(###)をサブセクションとして抽出"""
    subsections = []
    pattern = r'###\s+([^\n]+)\n(.*?)(?=\n###\s+|\n##\s+|$)'
    for match in re.finditer(pattern, section_content, re.DOTALL):
        subsections.append({
            'title': match.group(1).strip(),
            'content': match.group(2).strip(),
        })
    return subsections


def extract_sections_from_main_text(
    main_text_body: str,
    is_review: bool = False
) -> List[Dict[str, Any]]:
    """Main Text 本文からセクション一覧を抽出"""
    sections = []
    pattern = r'##\s+([^\n]+)\n(.*?)(?=\n##\s+|$)'
    for match in re.finditer(pattern, main_text_body, re.DOTALL):
        section_title   = match.group(1).strip()
        section_content = match.group(2).strip()

        if is_review:
            t = section_title.lower()
            if 'acknowledgement' in t or 'acknowledgment' in t:
                section_type = 'acknowledgements'
            elif 'reference' in t:
                section_type = 'references'
            else:
                section_type = 'review'
        else:
            section_type = classify_section_type(section_title)

        subsections = extract_subsections(section_content)
        if subsections:
            first_h3 = section_content.find('###')
            section_content = section_content[:first_h3].strip() if first_h3 >= 0 else ''

        sections.append({
            'title': section_title,
            'type': section_type,
            'content': section_content,
            'subsections': subsections,
        })
    return sections


def md_to_structured_data(md_file_path: str) -> Dict[str, Any]:
    """MDファイルを読み込み、構造化dictに変換"""
    with open(md_file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    frontmatter, remaining = parse_frontmatter(content)
    info_metadata = extract_info_block_metadata(content)
    main_text = extract_main_text_section(remaining)

    if not main_text:
        raise ValueError("# 4 Main Text セクションが見つかりません")

    main_text_metadata, main_text_body = parse_main_text_frontmatter(main_text)

    tags = frontmatter.get('tags', [])
    if isinstance(tags, str):
        tags = [tags]
    elif not isinstance(tags, list):
        tags = []

    is_review = 'review' in tags
    sections = extract_sections_from_main_text(main_text_body, is_review=is_review)

    published = main_text_metadata.get('published', '')
    if published and not isinstance(published, str):
        published = str(published)

    return {
        'citekey':   info_metadata.get('citekey')  or frontmatter.get('citekey', ''),
        'title':     info_metadata.get('title')    or main_text_metadata.get('title', frontmatter.get('title', '')),
        'authors':   info_metadata.get('authors')  or main_text_metadata.get('author', []),
        'published': info_metadata.get('year')     or published,
        'source':    info_metadata.get('journal')  or main_text_metadata.get('source', ''),
        'volume':    info_metadata.get('volume', ''),
        'issue':     info_metadata.get('issue', ''),
        'doi':       info_metadata.get('doi', ''),
        'tags':      tags,
        'sections':  sections,
    }


# ── RAG関数 (01_structured_rag_file_output.py より) ──────────────────────────

def clean_text(text: str) -> str:
    """インデックス化前のテキストクリーニング（URLリンクを除去）"""
    # \[[text](url)\] 形式の引用リンクを除去（例: \[[6](https://...)\]）
    text = re.sub(r'\\\[.*?\]\(https?://[^\)]+\)\\\]', '', text)
    # 残った [text](url) 形式のリンクも除去
    text = re.sub(r'\[([^\]]*)\]\(https?://[^\)]+\)', r'\1', text)
    return text.strip()

def split_into_paragraphs(text: str) -> List[str]:
    """テキストを段落に分割（\\n\\nで分割）"""
    return [p.strip() for p in re.split(r'\n\s*\n', text) if p.strip()]


def remove_table_blocks(section_content: str) -> str:
    """テーブルタイトル・テーブル本体・直後の1段落（凡例）を除去。
    INCLUDE_TABLES=True の場合はテーブル本体のみ残す。"""
    paragraphs = re.split(r'\n\s*\n', section_content)
    result = []
    skip_next = 0  # あと何段落スキップするか

    for para in paragraphs:
        s = para.strip()

        # テーブルタイトル（**Table N. ...** 形式）→ 除去 + テーブル本体・凡例をスキップ予約
        if re.match(r'^\*\*[Tt]able\s+\d+', s):
            skip_next = 2  # テーブル本体 + 凡例1段落
            continue

        if skip_next > 0:
            skip_next -= 1
            if s.startswith('<table') and INCLUDE_TABLES:
                result.append(para)
            continue

        result.append(para)

    return '\n\n'.join(result)


def split_references_into_items(text: str) -> List[str]:
    """Referencesセクションを1参考文献=1チャンクに分割（Fujii2026形式: `- N\\.` または `- [N\\.` で始まる行）"""
    items = []
    for line in text.splitlines():
        stripped = line.strip()
        if re.match(r'^-\s+\[?\d+\\?\.', stripped):
            # URLリンク形式 [N\. ...](url) → テキスト部分を抽出
            cleaned = re.sub(r'^\-\s+', '', stripped)
            cleaned = re.sub(r'^\[(\d+\\?\..+?)\]\(https?://[^\)]+\)', r'\1', cleaned)
            items.append(cleaned.strip())
    return [item for item in items if item]


def structured_data_to_documents(
    data: Dict[str, Any],
    target_section_types: List[str] | None = None,
) -> List[Document]:
    """構造化dictを段落ごとのDocumentリストに変換。target_section_typesに含まれるセクションのみ対象。"""
    if target_section_types is None:
        target_section_types = TARGET_SECTION_TYPES

    citekey   = data.get('citekey', 'Unknown')
    title     = data.get('title', 'Unknown')
    authors   = ', '.join(data.get('authors', [])) if isinstance(data.get('authors'), list) else data.get('authors', '')
    published = data.get('published', '')
    source    = data.get('source', '')

    documents = []
    for section in data.get('sections', []):
        section_title   = section.get('title', 'Unknown Section')
        section_type    = section.get('type', 'unknown')
        section_content = section.get('content', '')

        if section_type not in target_section_types:
            continue

        base_meta = {
            'citekey': citekey, 'title': title, 'authors': authors,
            'published': published, 'source': source,
            'section': section_title, 'section_type': section_type,
        }

        def add_paragraphs(paragraphs: List[str], subsection: str | None) -> None:
            for idx, para in enumerate(paragraphs, 1):
                content_type = 'table' if para.lstrip().startswith('<table') else 'text'
                if content_type == 'table' and not INCLUDE_TABLES:
                    continue
                documents.append(Document(
                    text=clean_text(para),
                    metadata={**base_meta, 'subsection': subsection,
                               'content_type': content_type,
                               'paragraph_index': idx, 'total_paragraphs': len(paragraphs)}
                ))

        # メインセクションを分割（referencesは1件=1チャンク、それ以外はテーブルブロック除去後に段落分割）
        if section_content.strip():
            if section_type == 'references':
                add_paragraphs(split_references_into_items(section_content), None)
            else:
                cleaned = remove_table_blocks(section_content)
                add_paragraphs(split_into_paragraphs(cleaned), None)

        # サブセクションを段落分割（同様にテーブルブロック除去）
        for subsection in section.get('subsections', []):
            sub_content = subsection.get('content', '')
            if sub_content.strip():
                cleaned = remove_table_blocks(sub_content)
                add_paragraphs(split_into_paragraphs(cleaned), subsection.get('title', 'Unknown Subsection'))

    return documents


def create_index(documents: List[Document]) -> VectorStoreIndex:
    """DocumentリストからVectorStoreIndexを作成"""
    return VectorStoreIndex.from_documents(documents)


def search_with_citation_to_file(
    query: str,
    index: VectorStoreIndex,
    output_file,
    top_k: int = 3,
) -> None:
    """引用付きRAG検索を実行し、Markdown形式でファイルに書き出す"""
    output_file.write(f"\n---\n\n## 検索クエリ\n\n{query}\n\n")

    query_engine = index.as_query_engine(similarity_top_k=top_k, response_mode="compact")
    response = query_engine.query(query)

    output_file.write("### 回答\n\n")
    output_file.write(f"{response.response}\n\n")

    output_file.write("### 引用元\n\n")
    for i, node in enumerate(response.source_nodes, 1):
        meta = node.node.metadata
        section_label = (
            f"{meta.get('section', 'N/A')} > {meta.get('subsection')}"
            if meta.get('subsection')
            else meta.get('section', 'N/A')
        )
        output_file.write(f"#### [{i}] {section_label}\n\n")
        output_file.write(f"- **段落位置**: {meta.get('paragraph_index', '?')}/{meta.get('total_paragraphs', '?')}\n")
        output_file.write(f"- **類似度スコア**: {node.score:.4f}\n\n")
        node_text = node.get_text() if hasattr(node, 'get_text') else node.text
        output_file.write(f"**内容:**\n\n> {node_text}\n\n")


# ── メイン ────────────────────────────────────────────────────────────────────

def main():
    md_file = Path(MD_FILE).resolve()
    if not md_file.exists():
        raise FileNotFoundError(f"MDファイルが見つかりません: {md_file}")

    # MDをパース
    print(f"MDファイルをパース中: {md_file}")
    data = md_to_structured_data(str(md_file))
    citekey = data.get('citekey') or md_file.stem
    print(f"  Citekey: {citekey}  /  セクション数: {len(data.get('sections', []))}")

    # JSON出力用（JSON_SECTION_TYPES固定）
    import json
    json_documents = structured_data_to_documents(data, target_section_types=JSON_SECTION_TYPES)

    # チャンク内容をJSONに出力（確認用）
    chunks_path = Path.home() / f"Dropbox/obsidian/50_coding/llamaindex/{citekey}_chunks.json"
    chunks_data = [
        {
            "index": i,
            "section": doc.metadata.get("section"),
            "section_type": doc.metadata.get("section_type"),
            "subsection": doc.metadata.get("subsection"),
            "paragraph_index": doc.metadata.get("paragraph_index"),
            "total_paragraphs": doc.metadata.get("total_paragraphs"),
            "char_count": len(doc.text),
            "text": doc.text,
        }
        for i, doc in enumerate(json_documents, 1)
    ]

    with open(chunks_path, 'w', encoding='utf-8') as f:
        json.dump(chunks_data, f, ensure_ascii=False, indent=2)
    print(f"チャンク一覧を保存しました: {chunks_path}（{len(chunks_data)}件）")

    # Referencesを別ファイルに出力
    ref_chunks = []
    for section in data.get('sections', []):
        if section.get('type') == 'references':
            items = split_references_into_items(section.get('content', ''))
            ref_chunks = [
                {
                    "index": j,
                    "section": section.get('title', 'References'),
                    "char_count": len(item),
                    "text": item,
                }
                for j, item in enumerate(items, 1)
            ]
            break
    ref_path = Path.home() / f"Dropbox/obsidian/50_coding/llamaindex/{citekey}_ref.json"
    with open(ref_path, 'w', encoding='utf-8') as f:
        json.dump(ref_chunks, f, ensure_ascii=False, indent=2)
    print(f"References を保存しました: {ref_path}（{len(ref_chunks)}件）")

    # ベクトル用（TARGET_SECTION_TYPESのみ）
    print(f"検索対象セクション: {', '.join(TARGET_SECTION_TYPES)}")
    documents = structured_data_to_documents(data)
    print(f"{len(documents)} 個の段落チャンクをベクトル化します")

    # インデックス作成
    print("ベクトルインデックス構築中...")
    index = create_index(documents)
    print("インデックス作成完了")

    # 検索 → ファイル出力
    date_str = datetime.now().strftime('%m%d')
    output_path = Path.home() / f"Dropbox/obsidian/50_coding/llamaindex/{citekey}_{date_str}.md"

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write("# 論文RAG検索結果（段落レベル）\n\n")
        f.write(f"**論文**: {data.get('title', md_file.stem)}\n\n")
        f.write(f"**Citekey**: {citekey}\n\n")
        f.write(f"**検索日時**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n")
        f.write(f"**検索クエリ数**: {len(QUERIES)} 件\n\n")
        f.write(f"**検索対象セクション**: {', '.join(TARGET_SECTION_TYPES)}\n\n")

        for query in QUERIES:
            search_with_citation_to_file(query, index, f, top_k=TOP_K)

    print(f"\n検索完了！結果を保存しました: {output_path}")


if __name__ == "__main__":
    main()
