"""
Markdownファイルの図（Figure）とlegendを1つの段落にまとめる
**Figure N** → ![Figure](...) → [Full size image](...) → legend テキスト
の間の空行をすべて削除する
"""
import re
from pathlib import Path

def clean_figure_legend(content: str) -> str:
    """figureとlegendの間の空行を削除"""

    # パターン：**Figure N** で始まり、legendテキストまで続くブロック内の空行を削除
    # **Figure N** の直下の空行を削除
    content = re.sub(r'(\*\*Figure \d+\*\*)\n+', r'\1\n', content)

    # ![Figure ...](URL) の直下の空行を削除
    content = re.sub(r'(!\[Figure [^\]]*\]\([^)]+\))\n+', r'\1\n', content)

    # [Full size image](...) の直下の空行を削除
    content = re.sub(r'(\[Full size image\]\([^)]+\))\n+', r'\1\n', content)

    return content

def main():
    # ファイル読み込み
    file_path = Path.home() / "Dropbox/obsidian/10_article/RXFP1/Naqvi2005.md"

    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # 処理前のサイズを記録
    original_size = len(content)

    # 処理実行
    cleaned_content = clean_figure_legend(content)

    # 処理後のサイズを記録
    cleaned_size = len(cleaned_content)

    # バックアップを作成
    backup_path = file_path.with_suffix('.md.bak')
    with open(backup_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"[OK] バックアップを作成: {backup_path}")

    # ファイルに書き込み
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(cleaned_content)

    print(f"[OK] ファイルを更新: {file_path}")
    print(f"  元のサイズ: {original_size} 文字")
    print(f"  処理後: {cleaned_size} 文字")
    print(f"  削除: {original_size - cleaned_size} 文字（空行）")

if __name__ == "__main__":
    main()
