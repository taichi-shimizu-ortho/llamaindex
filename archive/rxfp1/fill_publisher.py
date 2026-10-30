"""
既存の entrez_metadata.json を読み込み、
publisher キーがない、または空のレコードに対して Crossref API から出版社情報を取得して補完するスクリプト。
"""
import json
import time
from pathlib import Path
import requests

# JSONファイルのパス（環境に合わせて調整してください）
JSON_PATH = Path(__file__).parent.parent.parent / "Dropbox" / "obsidian" / "50_coding" / "llamaindex" / "entrez_metadata.json"
# もしスクリプトと同じフォルダにある場合は以下を有効にしてください
# JSON_PATH = Path("entrez_metadata.json")

MAILTO = "taichi_shimizu@med.uoeh-u.ac.jp"


def get_publisher_by_doi(doi: str) -> str:
    """Crossref API を使って DOI から出版社名（publisher）を取得する。"""
    if not doi:
        return ""
    url = f"https://api.crossref.org/works/{doi}"
    headers = {
        "User-Agent": f"llamaindex-rag/1.0 (mailto:{MAILTO})"
    }
    try:
        response = requests.get(url, headers=headers, timeout=10)
        if response.status_code == 200:
            data = response.json()
            return data.get("message", {}).get("publisher") or ""
    except Exception as e:
        print(f"    [Crossref エラー] {doi}: {e}")
    return ""


def main():
    if not JSON_PATH.exists():
        print(f"[エラー] ファイルが見つかりません: {JSON_PATH}")
        return

    print(f"JSONファイルを読み込み中: {JSON_PATH}")
    with open(JSON_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    articles = data.get("articles", [])
    total = len(articles)
    updated_count = 0

    print(f"全 {total} 件の論文データを処理します...")
    print("=" * 60)

    for i, article in enumerate(articles, 1):
        citekey = article.get("citekey")
        doi = article.get("doi", "")
        
        # すでに publisher が存在し、空でない場合はスキップ
        if "publisher" in article and article["publisher"]:
            continue

        print(f"[{i:3}/{total}] {citekey} の出版社情報を取得中...", end="", flush=True)
        
        if not doi:
            article["publisher"] = ""
            print(" → DOIなし（スキップ）")
            continue

        # Crossref から取得
        publisher = get_publisher_by_doi(doi)
        article["publisher"] = publisher
        updated_count += 1
        
        print(f" → {publisher or '取得失敗'}")
        
        # API負荷軽減のためのウェイト
        time.sleep(0.3)

    # データを上書き保存
    if updated_count > 0:
        with open(JSON_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print("=" * 60)
        print(f"処理完了: {updated_count} 件のデータを更新し、JSONを上書き保存しました。")
    else:
        print("=" * 60)
        print("すべての論文にすでに publisher 情報が存在するため、更新はありませんでした。")


if __name__ == "__main__":
    main()
