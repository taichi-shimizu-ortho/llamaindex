"""
[STEP 25b] PMC HTMLページから全文を取得し、MDファイルの # 4 Main Text に書き込む。

25_fetch_pmc_fulltext.py（Entrez XML）の代替。
出版社の方針でEntrez XMLが提供されない論文（例: PNAS）に使用する。

<section class="body main-article-body"> を対象に取得するため、
Introduction・Table を含む本文全体が得られる。

実行例:
    python 25b_fetch_pmc_html.py Blessing2019
    python 25b_fetch_pmc_html.py Blessing2019 --force
"""
import re
import sys
from pathlib import Path

import requests
import yaml
from bs4 import BeautifulSoup, NavigableString

DEFAULT_MD_DIR = Path(__file__).parent.parent.parent / "10_article" / "RXFP1"
PMC_ARTICLE_URL = "https://pmc.ncbi.nlm.nih.gov/articles/{pmcid}/"

# 除外するセクションタイトル（小文字で比較）
SKIP_SECTION_TITLES = {
    "abstract", "significance",
    "acknowledgements", "acknowledgments",
    "conflict of interest", "conflicts of interest", "funding",
    "author contributions", "supplementary material", "data availability",
    "footnotes", "associated data",
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
# PMC HTML 取得
# ---------------------------------------------------------------------------

def fetch_pmc_html(pmcid: str) -> str:
    """PMC記事HTMLページを取得して返す。"""
    url = PMC_ARTICLE_URL.format(pmcid=pmcid)
    print(f"  PMC HTMLページ取得中: {url} ...")
    r = requests.get(url, timeout=30, headers={"User-Agent": "Mozilla/5.0"})
    r.raise_for_status()
    return r.text


def extract_figure_cdn_urls(html: str) -> dict[str, str]:
    """HTML文字列から図のCDN URL を {ファイル名: URL} で返す。"""
    cdn_urls = re.findall(
        r'https://cdn\.ncbi\.nlm\.nih\.gov/pmc/blobs/[^\s"\']+\.jpg',
        html,
    )
    url_map: dict[str, str] = {}
    for cdn_url in cdn_urls:
        filename = cdn_url.split("/")[-1]
        if filename not in url_map:
            url_map[filename] = cdn_url
    print(f"  取得した図URL数: {len(url_map)}")
    return url_map


# ---------------------------------------------------------------------------
# HTML → Markdown 変換
# ---------------------------------------------------------------------------

def bs_inline_text(tag) -> str:
    """BeautifulSoupタグからインライン変換付きでテキストを再帰取得する。"""
    parts = []
    for child in tag.children:
        if isinstance(child, NavigableString):
            parts.append(str(child))
        elif child.name in ("em", "i"):
            parts.append(f"*{bs_inline_text(child)}*")
        elif child.name in ("strong", "b"):
            parts.append(f"**{bs_inline_text(child)}**")
        elif child.name == "sup":
            inner = bs_inline_text(child).replace("*", "\\*").replace("_", "\\_")
            parts.append(f"^{inner}^")
        elif child.name == "sub":
            parts.append(f"~{bs_inline_text(child)}~")
        else:
            parts.append(bs_inline_text(child))
    text = "".join(parts)
    text = re.sub(r'\(([^)]*)\)', lambda m: '(' + m.group(1).replace('\n', ' ') + ')', text)
    return text


def table_to_html(tbl_elem) -> str:
    """<table> 要素を HTML のまま返す（Obsidian は HTML テーブルを直接レンダリング可能）。"""
    return str(tbl_elem)


def fig_elem_to_markdown(fig, fig_url_map: dict[str, str]) -> str:
    """<figure> 要素を Markdown に変換する。"""
    lines = []
    img = fig.find("img")
    figcaption = fig.find("figcaption")
    if img:
        src = img.get("src", "")
        filename = src.split("/")[-1]
        img_url = fig_url_map.get(filename, src)
        alt = figcaption.get_text(strip=True)[:40] if figcaption else "Figure"
        lines.append(f"![{alt}]({img_url})")
    if figcaption:
        caption = figcaption.get_text(strip=True)
        if caption:
            lines.append(f"*{caption}*")
    return "\n".join(lines)


def section_to_markdown(sec, fig_url_map: dict[str, str]) -> str:
    """<section> 要素を Markdown に変換する（再帰なし・直下要素のみ処理）。"""
    h = sec.find(["h2", "h3", "h4"], recursive=False)
    level = int(h.name[1]) if h else 2
    title = h.get_text(strip=True) if h else ""

    if title.lower() in SKIP_SECTION_TITLES:
        return ""

    lines = []
    if title:
        lines.append(f"{'#' * level} {title}\n")

    for elem in sec.children:
        if isinstance(elem, NavigableString):
            continue
        if elem.name in ("h2", "h3", "h4"):
            continue  # ヘッダーは処理済み
        if elem.name == "p":
            text = bs_inline_text(elem).strip()
            if text:
                lines.append(f"{text}\n")
        elif elem.name == "figure":
            md = fig_elem_to_markdown(elem, fig_url_map)
            if md:
                lines.append(md + "\n")
        elif elem.name == "section":
            # ネストしたサブセクション
            sub_md = section_to_markdown(elem, fig_url_map)
            if sub_md:
                lines.append(sub_md)
        elif elem.name in ("ul", "ol"):
            for li in elem.find_all("li", recursive=False):
                text = bs_inline_text(li).strip()
                if text:
                    lines.append(f"- {text}")
            lines.append("")
        elif elem.name == "table":
            lines.extend(["", table_to_html(elem), ""])
        elif elem.name == "div":
            # table wrapper の場合、内部のtableを処理
            tbl = elem.find("table")
            if tbl:
                lines.extend(["", table_to_html(tbl), ""])

    return "\n".join(lines) + "\n"


def parse_html_to_markdown(html: str, fig_url_map: dict[str, str]) -> str:
    """<section class='body main-article-body'> から本文を Markdown 形式で返す。"""
    soup = BeautifulSoup(html, "html.parser")
    body = soup.find("section", class_="body main-article-body")
    if not body:
        print("  [!] <section class='body main-article-body'> が見つかりません")
        return ""

    md_parts = []
    pending_paras = []   # セクション間の直下 <p>
    intro_written = False  # Introduction を一度だけ出力するフラグ

    for elem in body.children:
        if isinstance(elem, NavigableString):
            continue
        if elem.name == "p":
            text = bs_inline_text(elem).strip()
            if text:
                pending_paras.append(text)
        elif elem.name == "section":
            if pending_paras:
                if not intro_written:
                    # 最初のバッチのみ Introduction として出力
                    md_parts.append("## Introduction\n\n" + "\n\n".join(pending_paras) + "\n")
                    intro_written = True
                else:
                    # 以降のセクション間段落はヘッダーなしで出力
                    md_parts.append("\n\n".join(pending_paras) + "\n")
                pending_paras = []
            sec_md = section_to_markdown(elem, fig_url_map)
            if sec_md.strip():
                md_parts.append(sec_md)

    # 末尾に残った段落
    if pending_paras:
        md_parts.append("\n\n".join(pending_paras) + "\n")

    return "\n".join(md_parts)


# ---------------------------------------------------------------------------
# MD ファイルへの書き込み
# ---------------------------------------------------------------------------

def write_main_text(md_path: Path, main_text: str, force: bool = False) -> None:
    """MDファイルの # 4 Main Text 以降を main_text で置き換える。"""
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
        print("使い方: python 25b_fetch_pmc_html.py <citekey> [md_dir] [--force]")
        print("例:     python 25b_fetch_pmc_html.py Blessing2019")
        print("        python 25b_fetch_pmc_html.py Blessing2019 --force")
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

    html = fetch_pmc_html(pmcid)
    fig_url_map = extract_figure_cdn_urls(html)
    main_text = parse_html_to_markdown(html, fig_url_map)

    if not main_text:
        print("[!] 本文テキストの取得に失敗しました。")
        sys.exit(1)

    section_count = main_text.count("\n## ")
    print(f"  取得セクション数: {section_count}")
    write_main_text(md_path, main_text, force=force)


if __name__ == "__main__":
    main()
