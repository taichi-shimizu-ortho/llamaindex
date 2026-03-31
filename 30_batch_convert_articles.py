"""
[STEP 04] 10_article/RXFP1ディレクトリのマークダウンファイルを
LlamaIndex用の構造化JSONに一括変換して articles_all.json を生成する。

実行順: 10 → 20 → 30 → 40 → 50
前提: 20_update_md_properties.py を実行済みであること（MD frontmatter に entrez データが書き込まれている）

review判定: entrez_metadata.json の entrez_is_review を優先。
            PubMed未登録論文は frontmatter の tags にフォールバック。
"""
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml

SCRIPT_DIR = Path(__file__).parent
ENTREZ_PATH = SCRIPT_DIR / "entrez_metadata.json"

# JSON出力時に除外するセクションタイプ
# 注: 'other' は含めない（レビュー論文など独自構造を持つ記事の内容を保持）
EXCLUDE_SECTION_TYPES = ['references', 'acknowledgements', 'abstract', 'cited_by']


# ---------------------------------------------------------------------------
# MD パース関数（article_rag.py より移植）
# ---------------------------------------------------------------------------

def parse_frontmatter(content: str) -> tuple[Dict[str, Any], str]:
    """YAML frontmatter をパースして (dict, 残りコンテンツ) を返す。"""
    pattern = r'^---\s*\n(.*?)\n---\s*\n(.*)$'
    match = re.match(pattern, content, re.DOTALL)
    if match:
        try:
            fm = yaml.safe_load(match.group(1))
            return fm or {}, match.group(2)
        except yaml.YAMLError as e:
            print(f"Error parsing frontmatter YAML: {e}")
            return {}, content
    return {}, content


def extract_main_text_section(content: str) -> Optional[str]:
    """# 4 Main Text セクションを抽出する。"""
    pattern = r'# 4 Main Text\s*\n(.*?)(?=\n#(?![#\s])|$)'
    match = re.search(pattern, content, re.DOTALL | re.IGNORECASE)
    if match:
        return match.group(1).strip()
    return None


def parse_main_text_frontmatter(main_text: str) -> tuple[Dict[str, Any], str]:
    """Main Text セクション内の YAML frontmatter をパースする。"""
    pattern = r'^---\s*\n(.*?)\n---\s*\n(.*)$'
    match = re.match(pattern, main_text, re.DOTALL)
    if match:
        try:
            metadata = yaml.safe_load(match.group(1))
            return metadata or {}, match.group(2)
        except yaml.YAMLError as e:
            print(f"Error parsing main text frontmatter: {e}")
            return {}, main_text
    return {}, main_text


def classify_section_type(section_title: str) -> str:
    """セクションタイトルからセクションタイプを分類する。"""
    title_lower = section_title.lower()
    if 'abstract' in title_lower:
        return 'abstract'
    elif 'introduction' in title_lower or title_lower == 'intro' or 'background' in title_lower:
        return 'intro'
    elif 'keyword' in title_lower:
        return 'keywords'
    elif 'abbreviation' in title_lower:
        return 'abbreviations'
    elif 'method' in title_lower or 'material' in title_lower or 'patient' in title_lower:
        return 'materials|methods'
    elif 'result' in title_lower:
        return 'results'
    elif 'discussion' in title_lower:
        return 'discussion'
    elif 'conclusion' in title_lower:
        return 'conclusion'
    elif 'reference' in title_lower:
        return 'references'
    elif 'cited by' in title_lower or 'citing' in title_lower:
        return 'cited_by'
    elif 'acknowledgement' in title_lower or 'acknowledgment' in title_lower:
        return 'acknowledgements'
    else:
        return 'other'


def extract_subsections(section_content: str) -> List[Dict[str, Any]]:
    """h3 (###) ヘッダーからサブセクションを抽出する。"""
    subsections = []
    pattern = r'###\s+([^\n]+)\n(.*?)(?=\n###\s+|\n##\s+|$)'
    for match in re.finditer(pattern, section_content, re.DOTALL):
        subsections.append({
            'title': match.group(1).strip(),
            'content': match.group(2).strip(),
        })
    return subsections


def extract_sections_from_main_text(
    main_text_body: str, is_review: bool = False
) -> List[Dict[str, Any]]:
    """
    h2 (##) ヘッダーでセクションを分割する。
    is_review=True の場合、ack/references 以外は全て type='review' に分類。
    """
    sections = []
    pattern = r'##\s+([^\n]+)\n(.*?)(?=\n##\s+|$)'
    for match in re.finditer(pattern, main_text_body, re.DOTALL):
        section_title = match.group(1).strip()
        section_content = match.group(2).strip()

        if is_review:
            title_lower = section_title.lower()
            if 'acknowledgement' in title_lower or 'acknowledgment' in title_lower:
                section_type = 'acknowledgements'
            elif 'reference' in title_lower:
                section_type = 'references'
            else:
                section_type = 'review'
        else:
            section_type = classify_section_type(section_title)

        subsections = extract_subsections(section_content)
        if subsections:
            first_h3_pos = section_content.find('###')
            section_content = section_content[:first_h3_pos].strip() if first_h3_pos >= 0 else ''

        sections.append({
            'title': section_title,
            'type': section_type,
            'content': section_content,
            'subsections': subsections,
        })
    return sections


def extract_info_block_metadata(content: str) -> Dict[str, Any]:
    """>[!Info] ブロックからメタデータを抽出する。"""
    metadata = {
        'first_author': '', 'authors': [], 'title': '', 'year': '',
        'journal': '', 'volume': '', 'issue': '', 'doi': '', 'citekey': ''
    }
    info_match = re.search(r'>\[!Info\](.*?)(?=\n(?!>)|$)', content, re.DOTALL)
    if not info_match:
        return metadata

    info_block = info_match.group(1)

    def _find(pattern):
        m = re.search(pattern, info_block)
        return m.group(1).strip() if m else ''

    metadata['first_author'] = _find(r'\*\*FirstAuthor\*\*::\s*([^>]+?)(?:\s*>|$)')
    author_matches = re.findall(r'\*\*(?:First)?Author\*\*::\s*([^>]+?)(?:\s*>|$)', info_block)
    metadata['authors'] = [a.strip() for a in author_matches if a.strip()]
    metadata['title']   = _find(r'>\s*\*\*Title\*\*:\s*([^\n]+)')
    metadata['year']    = _find(r'>\s*\*\*Year\*\*:\s*(\d+)')
    metadata['citekey'] = _find(r'>\s*\*\*Citekey\*\*:\s*([^\n]+)')
    metadata['journal'] = _find(r'>\s*\*\*Journal\*\*:\s*\*?([^\n*]+)\*?')
    metadata['volume']  = _find(r'>\s*\*\*Volume\*\*:\s*([^\n]+)')
    metadata['issue']   = _find(r'>\s*\*\*Issue\*\*:\s*([^\n]+)')
    metadata['doi']     = _find(r'>\s*\*\*DOI\*\*:\s*([^\n]+)')
    return metadata


def md_to_structured_json(
    md_file_path: str, is_review: bool | None = None
) -> Dict[str, Any]:
    """
    MD ファイルを構造化 JSON に変換する。

    Args:
        md_file_path: MD ファイルパス
        is_review: review判定の上書き。None の場合は frontmatter の tags から判定。
    """
    with open(md_file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    frontmatter, remaining_content = parse_frontmatter(content)
    info_metadata = extract_info_block_metadata(content)
    main_text = extract_main_text_section(remaining_content)

    if not main_text:
        raise ValueError("# 4 Main Text section not found in markdown file")

    main_text_metadata, main_text_body = parse_main_text_frontmatter(main_text)

    tags = frontmatter.get('tags', [])
    if isinstance(tags, str):
        tags = [tags]
    elif not isinstance(tags, list):
        tags = []

    if is_review is None:
        is_review = 'review' in tags

    sections = extract_sections_from_main_text(main_text_body, is_review=is_review)

    published = main_text_metadata.get('published', '')
    if published and not isinstance(published, str):
        published = str(published)

    return {
        'citekey':   info_metadata.get('citekey') or frontmatter.get('citekey', ''),
        'title':     info_metadata.get('title') or main_text_metadata.get('title', frontmatter.get('title', '')),
        'authors':   info_metadata.get('authors') or main_text_metadata.get('author', []),
        'published': info_metadata.get('year') or published,
        'source':    info_metadata.get('journal') or main_text_metadata.get('source', ''),
        'volume':    info_metadata.get('volume', ''),
        'issue':     info_metadata.get('issue', ''),
        'doi':       info_metadata.get('doi', '') or frontmatter.get('doi', ''),
        'tags':      tags,
        'sections':  sections,
    }


# ---------------------------------------------------------------------------
# 変換処理
# ---------------------------------------------------------------------------

def load_entrez_review_lookup() -> dict[str, bool | None]:
    """entrez_metadata.json から citekey → entrez_is_review の辞書を返す。"""
    if not ENTREZ_PATH.exists():
        return {}
    try:
        with open(ENTREZ_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return {r["citekey"]: r.get("entrez_is_review") for r in data.get("articles", [])}
    except Exception:
        return {}


def remove_url_references(text: str) -> str:
    """(https://...) 形式の URL 参照と HTML タグを削除する。"""
    text = re.sub(r'\(https?://[^)]+\)', '', text)
    text = re.sub(r'<[^>]+>', '', text)
    return text


def filter_sections(article: Dict[str, Any]) -> Dict[str, Any]:
    """除外対象セクションを削除し、URL 参照をクリーニングする。"""
    filtered = []
    for section in article.get('sections', []):
        if section.get('type') in EXCLUDE_SECTION_TYPES:
            continue
        if 'content' in section:
            section['content'] = remove_url_references(section['content'])
        for sub in section.get('subsections', []):
            if 'content' in sub:
                sub['content'] = remove_url_references(sub['content'])
        filtered.append(section)
    article['sections'] = filtered
    return article


def batch_convert_articles(
    input_dir: str = "../../10_article/RXFP1",
    output_file: str = "articles_all.json"
) -> Dict[str, Any]:
    """10_article/RXFP1 の .md ファイルを構造化 JSON に一括変換する。"""
    input_path = Path(input_dir)
    if not input_path.exists():
        raise FileNotFoundError(f"ディレクトリが見つかりません: {input_dir}")

    md_files = sorted(input_path.glob("*.md"))
    if not md_files:
        raise FileNotFoundError(f"マークダウンファイルが見つかりません: {input_dir}")

    entrez_lookup = load_entrez_review_lookup()
    if entrez_lookup:
        print(f"[*] entrez_metadata.json から {len(entrez_lookup)} 件のreview判定を読み込みました")
    else:
        print("[!] entrez_metadata.json が見つかりません。tags によるreview判定にフォールバックします")

    print(f"[*] {len(md_files)} 個のファイルを処理します...")
    print("-" * 80)

    articles = []
    failed_files = []

    for i, md_file in enumerate(md_files, 1):
        try:
            print(f"[{i}/{len(md_files)}] 処理中: {md_file.name}")

            # frontmatter から citekey を取得して entrez の review 判定を決定
            raw_content = md_file.read_text(encoding="utf-8")
            fm, _ = parse_frontmatter(raw_content)
            citekey = fm.get("citekey", md_file.stem)
            entrez_is_review = entrez_lookup.get(citekey)  # bool or None

            # 構造化変換（entrez の review 判定を優先）
            structured_data = md_to_structured_json(str(md_file), is_review=entrez_is_review)
            structured_data['filename'] = md_file.name
            structured_data['is_review'] = (
                entrez_is_review if entrez_is_review is not None
                else ('review' in structured_data.get('tags', []))
            )

            # 20_update_md_properties.py が frontmatter に書き込んだメタデータを付与
            structured_data['pmid']              = str(fm.get('pmid', '') or '')
            structured_data['entrez_mesh_terms'] = fm.get('mesh_terms', []) or []
            structured_data['entrez_keywords']   = fm.get('keywords', []) or []

            structured_data = filter_sections(structured_data)
            articles.append(structured_data)

            section_count = len(structured_data.get('sections', []))
            review_label = "review" if structured_data['is_review'] else "original"
            src_label = "entrez" if citekey in entrez_lookup and entrez_lookup[citekey] is not None else "tags"
            print(f"    [OK] {section_count} セクション | {review_label}（{src_label}判定）")

        except Exception as e:
            failed_files.append({'filename': md_file.name, 'error': str(e)})
            print(f"    [!] エラー: {e}")

    print("-" * 80)
    print(f"\n[完了] 成功: {len(articles)} 個 / 失敗: {len(failed_files)} 個")

    if failed_files:
        print("\n失敗したファイル:")
        for item in failed_files:
            print(f"  - {item['filename']}: {item['error']}")

    result = {
        "articles": articles,
        "metadata": {
            "total_count": len(articles),
            "failed_count": len(failed_files),
            "source_directory": input_dir,
            "failed_files": failed_files,
        }
    }

    output_path = Path(output_file)
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"\n[保存完了] {output_path.absolute()}")
    print(f"合計サイズ: {output_path.stat().st_size / 1024 / 1024:.2f} MB")
    return result


def print_statistics(result: Dict[str, Any]):
    """変換結果の統計情報を表示する。"""
    articles = result.get('articles', [])
    if not articles:
        print("変換された論文がありません")
        return

    print("\n" + "=" * 80)
    print("統計情報")
    print("=" * 80)

    total_sections = sum(len(a.get('sections', [])) for a in articles)
    review_count = sum(1 for a in articles if a.get('is_review'))
    print(f"論文数: {len(articles)} （review: {review_count} / original: {len(articles) - review_count}）")
    print(f"総セクション数: {total_sections}")
    print(f"平均セクション数: {total_sections / len(articles):.1f}")

    section_types_count: Dict[str, int] = {}
    for article in articles:
        for section in article.get('sections', []):
            stype = section.get('type', 'unknown')
            section_types_count[stype] = section_types_count.get(stype, 0) + 1

    print("\nセクションタイプの分布:")
    for stype, count in sorted(section_types_count.items(), key=lambda x: -x[1]):
        print(f"  {stype}: {count} 件")

    years = [
        a.get('published', '')[:4]
        for a in articles
        if isinstance(a.get('published', ''), str) and len(a.get('published', '')) >= 4
        and a.get('published', '')[:4].isdigit()
    ]
    if years:
        print("\n出版年の分布:")
        for year, count in sorted(Counter(years).items()):
            print(f"  {year}: {count} 件")

    print("=" * 80)


def main():
    import sys

    input_dir  = sys.argv[1] if len(sys.argv) > 1 else "../../10_article/RXFP1"
    output_file = sys.argv[2] if len(sys.argv) > 2 else "articles_all3.json"

    print("=" * 80)
    print("一括変換ツール: MD ファイル → LlamaIndex 用 JSON")
    print("=" * 80)
    print(f"入力ディレクトリ: {input_dir}")
    print(f"出力ファイル: {output_file}")
    print("=" * 80 + "\n")

    try:
        result = batch_convert_articles(input_dir, output_file)
        print_statistics(result)
        print("\n次のステップ: python 40_build_all_articles_index.py")
    except Exception as e:
        print(f"\n[!] 致命的エラー: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
