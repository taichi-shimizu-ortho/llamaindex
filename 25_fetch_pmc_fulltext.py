"""
[STEP 25] PMCから全文テキストを取得し、MDファイルの # 4 Main Text セクションに書き込む。
（PMCIDが存在する論文のみ。省略可能なオプションステップ）

実行順: 10 → 20 → [25] → 30 → 40 → 50
前提: 20_update_md_properties.py を実行済みで frontmatter に pmcid が書き込まれていること

実行例:
    python 25_fetch_pmc_fulltext.py Parker2022
    python 25_fetch_pmc_fulltext.py Parker2022 ../../10_article/RXFP1

画像は PMC の URL を直接 Markdown に埋め込む（ローカル保存なし）。
"""
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import requests
import yaml

DEFAULT_MD_DIR = Path(__file__).parent.parent.parent / "10_article" / "RXFP1"
ENTREZ_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
PMC_ARTICLE_URL = "https://www.ncbi.nlm.nih.gov/pmc/articles/{pmcid}/"
MAILTO = "taichi_shimizu@med.uoeh-u.ac.jp"
TOOL = "llamaindex-rag"
XLINK_NS = "http://www.w3.org/1999/xlink"

# 除外するセクションタイトル（小文字で比較）
# ※ references は MD 直接閲覧用に含める（JSON変換時は 30_ スクリプト側で除外）
SKIP_SECTION_TITLES = {
    "abstract", "acknowledgements", "acknowledgments",
    "conflict of interest", "conflicts of interest", "funding",
    "author contributions", "supplementary material", "data availability",
}


# ---------------------------------------------------------------------------
# MD パース
# ---------------------------------------------------------------------------

def parse_frontmatter(content: str) -> dict:
    """YAML frontmatter をパースして dict を返す。"""
    match = re.match(r'^---\s*\n(.*?)\n---\s*\n', content, re.DOTALL)
    if match:
        try:
            return yaml.safe_load(match.group(1)) or {}
        except yaml.YAMLError:
            return {}
    return {}


# ---------------------------------------------------------------------------
# PMC HTML から図のCDN URLを取得
# ---------------------------------------------------------------------------

def fetch_figure_cdn_urls(pmcid: str) -> dict[str, str]:
    """PMC記事ページをフェッチし、図のCDN URL を {ファイル名: URL} で返す。"""
    url = PMC_ARTICLE_URL.format(pmcid=pmcid)
    print(f"  PMC 図URL 取得中: {url} ...")
    try:
        r = requests.get(url, timeout=30, headers={"User-Agent": "Mozilla/5.0"})
        r.raise_for_status()
    except Exception as e:
        print(f"  [!] PMC HTMLページ取得エラー: {e}")
        return {}

    # cdn.ncbi.nlm.nih.gov/pmc/blobs/... のURLをすべて抽出
    cdn_urls = re.findall(
        r'https://cdn\.ncbi\.nlm\.nih\.gov/pmc/blobs/[^\s"\']+\.jpg',
        r.text,
    )
    # ファイル名をキーにしたマップを構築（重複は最初のものを使用）
    url_map: dict[str, str] = {}
    for cdn_url in cdn_urls:
        filename = cdn_url.split("/")[-1]
        if filename not in url_map:
            url_map[filename] = cdn_url

    print(f"  取得した図URL数: {len(url_map)}")
    return url_map


# ---------------------------------------------------------------------------
# XML → Markdown 変換
# ---------------------------------------------------------------------------

def inline_text(elem) -> str:
    """XML要素からテキストをインライン変換付きで再帰取得する。
    - <italic> → *text*
    - <bold>   → **text**
    - <sup>    → ^text^  (Obsidian上付き)
    - <sub>    → ~text~  (Obsidian下付き)
    - <xref>   → 除去（引用番号・文献番号）
    """
    parts = []
    if elem.text:
        parts.append(elem.text)
    for child in elem:
        tag = child.tag.lower()
        inner = inline_text(child)
        if tag == "italic":
            parts.append(f"*{inner}*")
        elif tag == "bold":
            parts.append(f"**{inner}**")
        elif tag == "sup":
            parts.append(f"^{inner}^")
        elif tag == "sub":
            parts.append(f"~{inner}~")
        elif tag == "xref":
            if inner:
                parts.append(inner)  # 引用番号をそのまま表示（前後の括弧は元テキストに依存）
        else:
            parts.append(inner)
        if child.tail:
            parts.append(child.tail)
    text = "".join(parts)
    # 括弧内の改行を空白に置換
    text = re.sub(r'\(([^)]*)\)', lambda m: '(' + m.group(1).replace('\n', ' ') + ')', text)
    return text


def fig_to_markdown(fig_elem, fig_url_map: dict[str, str]) -> str:
    """<fig> 要素を Markdown に変換する。fig_url_map から CDN URL を解決する。"""
    label = fig_elem.findtext("label", "").replace("\xa0", " ").strip()

    g = fig_elem.find("graphic")
    href = g.get(f"{{{XLINK_NS}}}href", "") if g is not None else ""

    # キャプション取得
    caption_parts = []
    cap = fig_elem.find("caption")
    if cap is not None:
        title = cap.findtext("title", "").strip()
        if title:
            caption_parts.append(title)
        for p in cap.findall("p"):
            caption_parts.append(inline_text(p).strip())
    caption = " ".join(caption_parts)

    lines = []
    if href:
        filename = Path(href).name
        img_url = fig_url_map.get(filename, "")
        if img_url:
            alt = label or "Figure"
            lines.append(f"![{alt}]({img_url})")
        else:
            print(f"    [!] CDN URL が見つかりません: {filename}")

    if label and caption:
        lines.append(f"*{label}: {caption}*")
    elif label:
        lines.append(f"*{label}*")
    elif caption:
        lines.append(f"*{caption}*")

    return "\n".join(lines) + "\n"


def section_to_markdown(sec_elem, level: int = 2, fig_url_map: dict[str, str] | None = None) -> str:
    """<sec> 要素を Markdown 文字列に再帰変換する。"""
    title_elem = sec_elem.find("title")
    title = inline_text(title_elem).strip() if title_elem is not None else ""

    # 除外セクション判定
    if title.lower() in SKIP_SECTION_TITLES:
        return ""

    lines = []
    if title:
        lines.append(f"{'#' * level} {title}\n")

    for child in sec_elem:
        if child.tag == "p":
            text = inline_text(child).strip()
            if text:
                lines.append(f"{text}\n")
        elif child.tag == "sec":
            sub = section_to_markdown(child, level + 1, fig_url_map=fig_url_map)
            if sub:
                lines.append(sub)
        elif child.tag == "fig":
            fig_md = fig_to_markdown(child, fig_url_map=fig_url_map or {})
            if fig_md.strip():
                lines.append(fig_md)
        elif child.tag == "list":
            for item in child.findall("list-item"):
                for p in item.findall("p"):
                    text = inline_text(p).strip()
                    if text:
                        lines.append(f"- {text}")
            lines.append("")

    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# References（<back> / <ref-list>）変換
# ---------------------------------------------------------------------------

def ref_list_to_markdown(root) -> str:
    """<ref-list> 内の <ref> 要素を番号付きリスト形式の Markdown に変換する。"""
    ref_list = root.find(".//ref-list")
    if ref_list is None:
        return ""

    lines = ["## References\n"]
    for ref in ref_list.findall("ref"):
        label_elem = ref.find("label")
        label = label_elem.text.strip() if label_elem is not None else ""
        citation = ref.find("mixed-citation") or ref.find("citation")
        if citation is None:
            continue
        # 全テキストを結合（改行・余分な空白を整理）
        text = " ".join(citation.itertext()).strip()
        text = re.sub(r'\s+', ' ', text)
        if label:
            lines.append(f"{label}. {text}")
        else:
            lines.append(text)

    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# PMC API
# ---------------------------------------------------------------------------

def fetch_pmc_fulltext(pmcid: str) -> str:
    """PMCID から PMC XML を取得し、本文を Markdown 形式で返す。abstract は含まない。"""
    pmc_num = pmcid.replace("PMC", "").strip()
    url = f"{ENTREZ_BASE}/efetch.fcgi"
    params = {
        "db": "pmc",
        "id": pmc_num,
        "rettype": "xml",
        "retmode": "xml",
        "tool": TOOL,
        "email": MAILTO,
    }
    print(f"  PMC XML 取得中: {pmcid} ...")
    r = requests.get(url, params=params, timeout=30)
    r.raise_for_status()

    root = ET.fromstring(r.content)
    body = root.find(".//body")
    if body is None:
        print("  [!] <body> が見つかりません（OAでない可能性）")
        return ""

    # 図のCDN URLマップを取得
    fig_url_map = fetch_figure_cdn_urls(pmcid)

    md_parts = []
    for sec in body.findall("sec"):
        md = section_to_markdown(sec, level=2, fig_url_map=fig_url_map)
        if md.strip():
            md_parts.append(md)

    # <back> の ref-list を追加
    refs_md = ref_list_to_markdown(root)
    if refs_md:
        md_parts.append(refs_md)

    return "\n".join(md_parts)


# ---------------------------------------------------------------------------
# MD ファイルへの書き込み
# ---------------------------------------------------------------------------

def write_main_text(md_path: Path, main_text: str, force: bool = False) -> None:
    """MDファイルの # 4 Main Text 以降を main_text で置き換える。
    force=True の場合は既存コンテンツを上書きする。
    """
    content = md_path.read_text(encoding="utf-8")

    match = re.search(r'^(# 4 Main Text[^\n]*\n?)', content, re.MULTILINE)
    if not match:
        print(f"  [!] '# 4 Main Text' が見つかりません: {md_path.name}")
        return

    cut_pos = match.end()
    existing_after = content[cut_pos:].strip()
    if existing_after and not force:
        print(f"  [スキップ] # 4 Main Text に既にコンテンツがあります: {md_path.name}")
        return

    new_content = content[:cut_pos] + "\n" + main_text
    md_path.write_text(new_content, encoding="utf-8")
    print(f"  書き込み完了: {md_path.name}")


# ---------------------------------------------------------------------------
# メイン
# ---------------------------------------------------------------------------

def main():
    if len(sys.argv) < 2:
        print("使い方: python 25_fetch_pmc_fulltext.py <citekey> [md_dir] [--force]")
        print("例:     python 25_fetch_pmc_fulltext.py Parker2022")
        print("        python 25_fetch_pmc_fulltext.py Parker2022 --force  # 既存コンテンツを上書き")
        sys.exit(1)

    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    force = "--force" in sys.argv

    citekey = args[0]
    md_dir = Path(args[1]) if len(args) > 1 else DEFAULT_MD_DIR
    md_path = md_dir / f"{citekey}.md"

    if not md_path.exists():
        print(f"[!] MDファイルが見つかりません: {md_path}")
        sys.exit(1)

    content = md_path.read_text(encoding="utf-8")
    fm = parse_frontmatter(content)
    pmcid = str(fm.get("pmcid", "")).strip()

    if not pmcid:
        print(f"[!] frontmatter に pmcid がありません: {md_path.name}")
        sys.exit(1)

    print(f"対象: {citekey} | PMCID: {pmcid}")

    main_text = fetch_pmc_fulltext(pmcid)
    if not main_text:
        print("[!] 本文テキストの取得に失敗しました。")
        sys.exit(1)

    section_count = main_text.count("\n## ")
    print(f"  取得セクション数: {section_count}")
    write_main_text(md_path, main_text, force=force)


if __name__ == "__main__":
    main()
