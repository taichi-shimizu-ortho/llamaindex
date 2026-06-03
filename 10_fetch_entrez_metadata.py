"""
Entrez (PubMed) API を使って各論文の MeSH, Keywords, ArticleType を取得する。

入力: MD ファイルディレクトリ（frontmatter の doi / citekey を使用）
出力: entrez_metadata.json

実行例:
    python 10_fetch_entrez_metadata.py
    python 10_fetch_entrez_metadata.py ../../10_article/RXFP1
"""
import json
import re
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import requests
import yaml

# デフォルトの MD ディレクトリ（スクリプトから見た相対パス）
DEFAULT_MD_DIR = Path(__file__).parent.parent.parent / "Dropbox" / "obsidian" /"10_article" / "RXFP1"
OUTPUT_PATH = Path(__file__).parent.parent.parent / "Dropbox" / "obsidian" / "50_coding" / "llamaindex" / "entrez_metadata.json"

ENTREZ_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
# NCBI の利用規約: 毎秒3リクエスト以下。メールを設定すると10リクエスト/秒に緩和
MAILTO = "taichi_shimizu@med.uoeh-u.ac.jp"
TOOL = "llamaindex-rag"


# ---------------------------------------------------------------------------
# MD パース
# ---------------------------------------------------------------------------

def parse_frontmatter(content: str) -> dict:
    """YAML frontmatter をパースして dict を返す。"""
    # \r? を追加して、CRLF と LF の両方に対応
    match = re.match(r'^---\s*\r?\n(.*?)\r?\n---\s*\r?\n', content, re.DOTALL)
    if match:
        try:
            return yaml.safe_load(match.group(1)) or {}
        except yaml.YAMLError:
            return {}
    return {}


def extract_doi_from_info_block(content: str) -> str:
    """>[!Info] ブロックから DOI を抽出する（frontmatter にない場合のフォールバック）。"""
    m = re.search(r'>\s*\*\*DOI\*\*:\s*([^\n]+)', content)
    return m.group(1).strip() if m else ""


def load_articles_from_md(md_dir: Path) -> list[dict]:
    """MD ファイルの frontmatter から記事リストを生成する。"""
    articles = []
    for md_file in sorted(md_dir.glob("*.md")):
        try:
            content = md_file.read_text(encoding="utf-8")
            fm = parse_frontmatter(content)
            raw = str(fm.get("citekey", "") or md_file.stem).strip()
            citekey = raw[0].upper() + raw[1:] if raw else raw
            # doi: frontmatter 優先 → >[!Info] ブロックにフォールバック
            doi = str(fm.get("doi", "") or extract_doi_from_info_block(content) or "").strip()
            articles.append({
                "citekey": citekey,
                "doi": doi,
                "filename": md_file.name,
            })
        except Exception as e:
            print(f"[!] {md_file.name} の読み込みエラー: {e}")
    return articles


# ---------------------------------------------------------------------------
# Entrez API
# ---------------------------------------------------------------------------

def doi_to_pmid(doi: str) -> str:
    """DOI から PMID を検索する。見つからなければ空文字を返す。"""
    url = f"{ENTREZ_BASE}/esearch.fcgi"
    params = {
        "db": "pubmed",
        "term": f"{doi}[doi]",
        "retmode": "json",
        "retmax": 1,
        "tool": TOOL,
        "email": MAILTO,
    }
    try:
        r = requests.get(url, params=params, timeout=15)
        r.raise_for_status()
        ids = r.json().get("esearchresult", {}).get("idlist", [])
        return ids[0] if ids else ""
    except Exception as e:
        print(f"    [esearch エラー] {e}")
        return ""



def fetch_pubmed_record(pmid: str) -> dict:
    """
    PMID から PubMed XML を取得し、以下を返す:
      - article_types: list[str]  例 ["Journal Article", "Review"]
      - is_review: bool
      - mesh_terms: list[str]
      - keywords: list[str]
    """
    url = f"{ENTREZ_BASE}/efetch.fcgi"
    params = {
        "db": "pubmed",
        "id": pmid,
        "rettype": "xml",
        "retmode": "xml",
        "tool": TOOL,
        "email": MAILTO,
    }
    try:
        r = requests.get(url, params=params, timeout=15)
        r.raise_for_status()
        root = ET.fromstring(r.content)
    except Exception as e:
        print(f"    [efetch エラー] {e}")
        return {}

    # PublicationType
    article_types = [
        pt.text for pt in root.findall(".//PublicationType") if pt.text
    ]
    is_review = any(
        t in ["Review", "Systematic Review", "Meta-Analysis"] for t in article_types
    )

    # MeSH Heading
    mesh_terms = [
        dname.text
        for dname in root.findall(".//MeshHeading/DescriptorName")
        if dname.text
    ]

    # AuthorKeyword
    keywords = [
        kw.text for kw in root.findall(".//Keyword") if kw.text
    ]

    return {
        "article_types": article_types,
        "is_review": is_review,
        "mesh_terms": mesh_terms,
        "keywords": keywords,
    }


# ---------------------------------------------------------------------------
# キャッシュ
# ---------------------------------------------------------------------------

def load_existing_results() -> dict:
    """既存の entrez_metadata.json を読み込み、citekey をキーとした辞書を返す。"""
    if not OUTPUT_PATH.exists():
        return {}
    try:
        with open(OUTPUT_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return {r["citekey"]: r for r in data.get("articles", [])}
    except Exception:
        return {}


# ---------------------------------------------------------------------------
# メイン
# ---------------------------------------------------------------------------

def main():
    md_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_MD_DIR

    if not md_dir.exists():
        print(f"[!] ディレクトリが見つかりません: {md_dir}")
        sys.exit(1)

    articles = load_articles_from_md(md_dir)
    total = len(articles)
    results = []

    existing = load_existing_results()
    skip_count = 0

    print(f"MD ディレクトリ: {md_dir}")
    print(f"対象記事数: {total}")
    if existing:
        print(f"取得済み（キャッシュ）: {len(existing)}件")
    print("=" * 70)

    for i, article in enumerate(articles, 1):
        citekey = article["citekey"]
        doi = article["doi"]

        print(f"[{i:3}/{total}] {citekey}", end=" ")

        # 取得済みかつ DOI が変わっていなければスキップ
        if citekey in existing and existing[citekey].get("doi", "") == doi:
            rec = existing[citekey]
            results.append(rec)
            skip_count += 1
            print("→ スキップ（取得済み）")
            continue

        record = {
            "citekey": citekey,
            "doi": doi,
            "pmid": "",
            "entrez_article_types": [],
            "entrez_is_review": False,  # デフォルトは False
            "entrez_mesh_terms": [],
            "entrez_keywords": [],
            "pubmed_found": False,
        }

        if not doi:
            print("→ DOIなし、スキップ")
            results.append(record)
            continue

        # Step1: DOI → PMID
        pmid = doi_to_pmid(doi)
        time.sleep(0.4)

        if not pmid:
            print("→ PubMedに未登録（書籍章など）")
            results.append(record)
            continue

        record["pmid"] = pmid
        record["pubmed_found"] = True



        # Step3: PMID → メタデータ取得
        meta = fetch_pubmed_record(pmid)
        time.sleep(0.4)

        if not meta:
            print(f"→ PMID {pmid} 取得失敗")
            results.append(record)
            continue

        record.update({
            "entrez_article_types": meta.get("article_types", []),
            "entrez_is_review": meta.get("is_review", False),
            "entrez_mesh_terms": meta.get("mesh_terms", []),
            "entrez_keywords": meta.get("keywords", []),
        })

        review_label = "Review" if record["entrez_is_review"] else "Original"
        print(f"→ PMID {pmid} | 判定: {review_label} | MeSH: {len(meta.get('mesh_terms', []))}件")

        results.append(record)

    # 結果を保存
    output = {
            "total": total,
            "pubmed_found": sum(1 for r in results if r["pubmed_found"]),
            "review_count": sum(1 for r in results if r["entrez_is_review"]),
            "articles": results,
        }
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    # PubMed未登録（データなし）の論文を抽出
    unregistered_articles = [r for r in results if not r["pubmed_found"]]

    # サマリー表示
    print("\n" + "=" * 70)
    print(f"スキップ（取得済み）: {skip_count}件 / 新規取得: {total - skip_count}件")
    print(f"PubMed登録済み: {output['pubmed_found']}/{total}件")
    print(f"Review論文数 (Entrez判定): {output['review_count']}/{total}件")
    
    if unregistered_articles:
        print(f"\n【⚠️ PubMed未登録・データなしの論文: {len(unregistered_articles)}件】")
        for r in unregistered_articles:
            reason = "DOIなし" if not r["doi"] else "PubMedにID未登録"
            print(f"  - {r['citekey']} ({reason})")
            
    print(f"\n結果保存: {OUTPUT_PATH}")


if __name__ == "__main__":
   main()
