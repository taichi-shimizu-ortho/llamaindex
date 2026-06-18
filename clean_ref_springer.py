"""
フロントマターの publisher が "Springer Science and Business Media LLC" の MD ファイルのみを対象とし、
References セクション内の不要なメタリンク（[Article], [CAS], [PubMed]等）を削除するスクリプト。
処理結果（ファイル名と削除したテキスト）をテキストファイルに出力します。
"""
import re
import sys
from pathlib import Path
import yaml

# デフォルトの MD ディレクトリ
DEFAULT_MD_DIR = Path(__file__).parent.parent.parent / "Dropbox" / "obsidian" / "10_article" / "RXFP1"
# ログの出力先
LOG_OUTPUT_PATH = Path(__file__).parent / "cleaned_references_log.txt"

# 削除対象となるマークダウンリンクのパターン
LINK_PATTERN = re.compile(
    r'\[(?:Article|CAS|PubMed|PubMed Central|Full size table)\]\([^)]+\)',
    re.IGNORECASE
)

# frontmatter 分割用
FM_PATTERN = re.compile(r'^---\s*\r?\n(.*?)\r?\n---\s*\r?\n', re.DOTALL)


def get_publisher(content: str) -> str:
    """フロントマターから publisher を取得する。"""
    match = FM_PATTERN.match(content)
    if not match:
        return ""
    try:
        fm = yaml.safe_load(match.group(1)) or {}
        return str(fm.get("publisher", "")).strip()
    except Exception:
        return ""


def clean_reference_links(content: str) -> tuple[str, list[str]]:
    """
    References セクション以降の不要なメタリンクを削除し、
    更新後のテキストと、削除されたリンク文字列のリストを返す。
    """
    ref_match = re.search(r'^##\s+(?:References?|Bibliography)\b', content, re.MULTILINE | re.IGNORECASE)
    if not ref_match:
        return content, []

    ref_start = ref_match.start()
    pre_content = content[:ref_start]
    ref_content = content[ref_start:]

    # 削除されるリンクを事前に抽出して記録する
    removed_links = LINK_PATTERN.findall(ref_content)
    if not removed_links:
        return content, []

    # リンクパターンを削除
    cleaned_ref = LINK_PATTERN.sub('', ref_content)

    # 行末のスペースを削除
    cleaned_ref = re.sub(r'[ \t]+$', '', cleaned_ref, flags=re.MULTILINE)
    # 3行以上連続する空行を1行にまとめる
    cleaned_ref = re.sub(r'\n{3,}', '\n\n', cleaned_ref)
    # 文献番号 [^1]: ... の直後の空行を詰める
    cleaned_ref = re.sub(r'(\[\^\d+\]:[^\n]+)\n\n+', r'\1\n', cleaned_ref)

    return pre_content + cleaned_ref, removed_links


def main():
    md_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_MD_DIR

    if md_dir.is_file():
        md_files = [md_dir]
    elif md_dir.exists():
        md_files = sorted(md_dir.glob("*.md"))
    else:
        print(f"[!] パスが見つかりません: {md_dir}")
        sys.exit(1)

    print(f"対象ディレクトリ: {md_dir}")
    print("=" * 70)

    log_lines = []
    processed_count = 0
    skipped_count = 0

    for md_file in md_files:
        try:
            content = md_file.read_text(encoding="utf-8")
            publisher = get_publisher(content)

            # Publisher が指定のものでなければスキップ
            if publisher != "Springer Science and Business Media LLC":
                skipped_count += 1
                continue

            cleaned_content, removed_links = clean_reference_links(content)

            if removed_links:
                md_file.write_text(cleaned_content, encoding="utf-8")
                print(f"  [Cleaned] {md_file.name} (削除数: {len(removed_links)}個)")
                
                # ログ用テキストの構築
                log_lines.append(f"■ File: {md_file.name}")
                log_lines.append(f"  Publisher: {publisher}")
                log_lines.append("  Removed Links:")
                for link in removed_links:
                    log_lines.append(f"    - {link}")
                log_lines.append("\n" + "-" * 50 + "\n")
                
                processed_count += 1
            else:
                # 該当 publisher だが、削除対象リンクがなかった場合
                pass

        except Exception as e:
            print(f"  [エラー] {md_file.name}: {e}")

    # ログファイルの書き出し
    if log_lines:
        log_content = f"=== References Cleanup Log ===\nProcessed: {processed_count} files\n\n" + "\n".join(log_lines)
        LOG_OUTPUT_PATH.write_text(log_content, encoding="utf-8")
        print("=" * 70)
        print(f"処理完了: {processed_count} 件の Springer 論文をクリーンアップしました。")
        print(f"ログを保存しました: {LOG_OUTPUT_PATH}")
    else:
        print("=" * 70)
        print("処理対象、または削除対象のリンクが存在するファイルはありませんでした。")


if __name__ == "__main__":
    main()
