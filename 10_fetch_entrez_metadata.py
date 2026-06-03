"""
Entrez (PubMed) API を使って各論文の MeSH, Keywords, ArticleType を取得する。

入力: MD ファイルディレクトリ（frontmatter の doi / citekey / tags を使用）
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
    match = re.match(r'^---\s*\n(.*?)\n---\s*\n', content, re.DOTALL)
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
            tags = fm.get("tags", [])
            if isinstance(tags, str):
                tags = [tags]
            elif not isinstance(tags, list):
                tags = []
            articles.append({
                "citekey": citekey,
                "doi": doi,
                "tags": tags,
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


def pmid_to_pmcid(pmid: str) -> str:
    """PMID から PMCID を取得する。PMCに登録がなければ空文字を返す。"""
    # 新しい公式エンドポイントURLに変更
    url = "https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/"
    params = {
        "ids": pmid,
        "idtype": "pmid",
        "format": "json",
        "tool": TOOL,
        "email": MAILTO,
    }
    # 403エラー（Forbidden）を回避するため、User-Agentを明示的に設定
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    try:
        r = requests.get(url, params=params, headers=headers, timeout=15)
        r.raise_for_status()
        records = r.json().get("records", [])
        if records and "pmcid" in records[0]:
            return records[0]["pmcid"]  # 例: "PMC11179965"
    except Exception as e:
        print(f"    [idconv エラー] {e}")
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

    # MeSH Heading（主語のみ、サブヘディングは除外）
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
    discrepancies = []

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
        current_tags = article["tags"]
        current_is_review = "review" in current_tags

        print(f"[{i:3}/{total}] {citekey}", end=" ")

        # 取得済みかつ DOI が変わっていなければスキップ
        if citekey in existing and existing[citekey].get("doi", "") == doi:
            rec = existing[citekey]
            rec["current_tags"] = current_tags
            rec["current_is_review"] = current_is_review
            results.append(rec)
            skip_count += 1
            print("→ スキップ（取得済み）")
            if rec.get("entrez_is_review") is not None and current_is_review != rec["entrez_is_review"]:
                discrepancies.append({
                    "citekey": citekey,
                    "current_is_review": current_is_review,
                    "entrez_is_review": rec["entrez_is_review"],
                    "entrez_article_types": rec.get("entrez_article_types", []),
                })
            continue

        record = {
            "citekey": citekey,
            "doi": doi,
            "pmid": "",
            "pmcid": "",
            "current_tags": current_tags,
            "current_is_review": current_is_review,
            "entrez_article_types": [],
            "entrez_is_review": None,
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
        time.sleep(0.4)  # NCBI レート制限対策

        if not pmid:
            print("→ PubMedに未登録（書籍章など）")
            results.append(record)
            continue

        record["pmid"] = pmid
        record["pubmed_found"] = True

        # Step2: PMID → PMCID
        pmcid = pmid_to_pmcid(pmid)
        record["pmcid"] = pmcid
        time.sleep(0.4)

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

        entrez_is_review = record["entrez_is_review"]
        pmcid_str = f" | PMCID: {pmcid}" if pmcid else ""
        print(f"→ PMID {pmid}{pmcid_str} | 種別: {meta.get('article_types', [])} | MeSH: {len(meta.get('mesh_terms', []))}件")

        if current_is_review != entrez_is_review:
            discrepancies.append({
                "citekey": citekey,
                "current_is_review": current_is_review,
                "entrez_is_review": entrez_is_review,
                "entrez_article_types": meta.get("article_types", []),
            })

        results.append(record)

    # 結果を保存
    output = {
        "total": total,
        "pubmed_found": sum(1 for r in results if r["pubmed_found"]),
        "discrepancies_count": len(discrepancies),
        "discrepancies": discrepancies,
        "articles": results,
    }
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    # サマリー表示
    print("\n" + "=" * 70)
    print(f"スキップ（取得済み）: {skip_count}件 / 新規取得: {total - skip_count}件")
    print(f"PubMed登録済み: {output['pubmed_found']}/{total}件")
    print(f"review判定の差異: {len(discrepancies)}件")
    if discrepancies:
        print("\n【差異のある記事】")
        for d in discrepancies:
            cur = "review" if d["current_is_review"] else "original"
            ent = "review" if d["entrez_is_review"] else "original"
            print(f"  {d['citekey']}: 現在={cur} → Entrez={ent} {d['entrez_article_types']}")
    print(f"\n結果保存: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
