"""
abstractの取得状況を確認するスクリプト
Nishimura2023.mdから参考文献を抽出し、
各ファイルのabstract取得状況を確認
"""

import re
from pathlib import Path
from typing import Optional

REFERENCE_DIR = Path.home() / "Dropbox/obsidian/10_article/hamstrings"


def extract_references(paper_path: Path) -> list:
    """元論文から[[AuthorYear]]形式の参考文献を抽出"""
    with open(paper_path, 'r', encoding='utf-8') as f:
        content = f.read()
    refs = re.findall(r'\[\[(.*?)\]\]', content)
    return list(set(refs))


def extract_abstract(content: str) -> str:
    """Markdownから [!Abstract] セクションを抽出"""
    # > [!Abstract] で始まるセクションを検索
    # 複数行の > で始まるテキストに対応
    pattern = r'>\s*\[!Abstract\]\s*\n((?:>.*\n?)*)'
    match = re.search(pattern, content, re.DOTALL)

    if match:
        abstract_text = match.group(1).strip()
        # 先頭の > と余分なスペースを削除
        abstract_text = re.sub(r'^>\s*', '', abstract_text, flags=re.MULTILINE)
        # 複数の空行を1行に統一
        abstract_text = re.sub(r'\n\s*\n+', '\n\n', abstract_text)
        return abstract_text

    return ""


def main():
    main_paper_path = REFERENCE_DIR / "Nishimura2023.md"

    # 参考文献を抽出
    print("参考文献リストを抽出中...")
    ref_list = extract_references(main_paper_path)
    print(f"参考文献総数: {len(ref_list)} 件\n")

    # 各ファイルをチェック
    with_abstract = []
    without_abstract = []

    for ref in sorted(ref_list):
        ref_file = REFERENCE_DIR / f"{ref}.md"

        if not ref_file.exists():
            print(f"  ✗ {ref}: ファイルが見つかりません")
            continue

        with open(ref_file, 'r', encoding='utf-8') as f:
            content = f.read()

        abstract = extract_abstract(content)

        if abstract:
            with_abstract.append(ref)
            print(f"  OK {ref}: Abstract取得 ({len(abstract)} 文字)")
        else:
            without_abstract.append(ref)
            print(f"  -- {ref}: Abstract取得失敗")

    # サマリー
    print(f"\n{'='*60}")
    print(f"Abstract取得成功: {len(with_abstract)} 件")
    print(f"Abstract取得失敗: {len(without_abstract)} 件")

    if without_abstract:
        print(f"\n【Abstract取得失敗リスト】")
        for ref in sorted(without_abstract):
            print(f"  - {ref}")

        print(f"\n【ファイルの確認】")
        for ref in without_abstract:
            ref_file = REFERENCE_DIR / f"{ref}.md"
            if ref_file.exists():
                print(f"\n{ref}.md:")
                with open(ref_file, 'r', encoding='utf-8') as f:
                    content = f.read()
                    # 最初の500文字を表示
                    print(content[:500])
                    print("...\n")


if __name__ == "__main__":
    main()
