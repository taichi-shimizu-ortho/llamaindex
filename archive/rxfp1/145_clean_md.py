"""
論文MDファイルのクリーニングスクリプト
除去対象：
  1. 本文中の図URL：![alt](url) → 除去（後続のFigureキャプションは残る）
  2. References内のリンク：[[Google Scholar](url)] [[CrossRef](url)] [[PubMed](url)]

使い方：
  uv run 145_clean_md.py Hart2025
  uv run 145_clean_md.py /full/path/to/file.md
"""

import os
import re
import sys
import shutil
from pathlib import Path


def find_paper(paper_name: str) -> Path:
    base_path = Path.home() / "Dropbox/obsidian/10_article"
    for root, _, files in os.walk(base_path):
        for file in files:
            if file.lower().startswith(paper_name.lower()) and file.endswith(".md"):
                return Path(root) / file
    raise FileNotFoundError(f"論文 '{paper_name}' が見つかりません")


def clean_content(content: str) -> tuple[str, dict]:
    """クリーニングを実行して、変更統計とともに返す"""
    stats = {}

    # 1. 本文中の図URL：![alt text](url "title") を除去
    #    後続のFigureキャプション（**Figure 1.** ...）は残る
    before = len(re.findall(r'!\[[^\]]*\]\([^)]*\)', content))
    content = re.sub(r'!\[[^\]]*\]\([^)]*\)\s*', '', content)
    stats['figure_urls'] = before

    # 2. [[Google Scholar](url)] [[CrossRef](url)] [[PubMed](url)] などを除去
    #    形式：[[label](url)] または [label](url) のリンク（References内）
    before = len(re.findall(r'\[\[[^\]]+\]\([^)]*\)\]', content))
    content = re.sub(r'\s*\[\[[^\]]+\]\([^)]*\)\]', '', content)
    stats['ref_links'] = before

    return content, stats


def main():
    if len(sys.argv) < 2:
        print("使い方: uv run 145_clean_md.py <論文名またはフルパス>")
        print("例:     uv run 145_clean_md.py Hart2025")
        sys.exit(1)

    arg = sys.argv[1]

    # フルパスかcitekeyかを判定
    if arg.endswith(".md") and Path(arg).exists():
        file_path = Path(arg)
    else:
        try:
            file_path = find_paper(arg)
        except FileNotFoundError as e:
            print(f"Error: {e}")
            sys.exit(1)

    print(f"対象ファイル: {file_path}")

    # バックアップ作成
    backup_path = file_path.with_suffix(".md.bak")
    shutil.copy2(file_path, backup_path)
    print(f"バックアップ: {backup_path}")

    # 読み込み
    with open(file_path, 'r', encoding='utf-8') as f:
        original = f.read()

    # クリーニング
    cleaned, stats = clean_content(original)

    # 確認表示
    print(f"\n【除去件数】")
    print(f"  図URL（![...](...) ）: {stats['figure_urls']} 件")
    print(f"  参考文献リンク（[[...](url)]）: {stats['ref_links']} 件")

    if cleaned == original:
        print("\n変更なし。クリーニング対象がありませんでした。")
        backup_path.unlink()  # バックアップ不要なので削除
        return

    # 上書き保存
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(cleaned)

    print(f"\n保存完了: {file_path}")
    print(f"元に戻す場合: cp '{backup_path}' '{file_path}'")


if __name__ == "__main__":
    main()
