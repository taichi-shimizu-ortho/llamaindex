import re
from pathlib import Path

def remove_urls_from_md(file_path: Path, output_log_name: str = "deleted_urls.txt"):
    """
    Markdownファイルから http(s):// で始まるURLを削除する。
    ただし、https://ars. で始まるURLは除外する（消さない）。
    また、空になった [Google Scholar](), [Crossref](), [View in Scopus](), [View PDF](), [View article]() はテキストごと削除する。
    """
    if not file_path.exists():
        print(f"[エラー] ファイルが見つかりません: {file_path}")
        return

    original_content = file_path.read_text(encoding="utf-8")
    deleted_urls = []

    # --- 1. マークダウンリンク [text](url) の置換処理 ---
    # (?!ars\.) を使うことで、"ars." で始まるURLをマッチ対象から除外
    markdown_link_pattern = re.compile(r'\[([^\]]*)\]\((https?://(?!ars\.)[^\s)]+)\)')
    
    def replace_markdown_link(match):
        text = match.group(1)
        url = match.group(2)
        deleted_urls.append(f"Markdown Link [{text}]: {url}")
        return f"[{text}]()"

    content_step1 = markdown_link_pattern.sub(replace_markdown_link, original_content)

    # --- 2. 生のURL (マークダウンリンク外) の置換処理 ---
    raw_url_pattern = re.compile(r'(https?://(?!ars\.)[^\s)\"\'<>]+)')
    
    def replace_raw_url(match):
        url = match.group(1)
        deleted_urls.append(f"Raw URL: {url}")
        return ""

    content_step2 = raw_url_pattern.sub(replace_raw_url, content_step1)

    # --- 3. 特定の空リンクの完全削除 ---
    # [Google Scholar](), [Crossref](), [View in Scopus](), [View PDF](), [View article]() を削除
    # 前後のタブ(\t)やスペースも含めてきれいに消去します
    targets_to_remove = [
        r'\t?\[Google Scholar\]\(\)',
        r'\t?\[Crossref\]\(\)',
        r'\t?\[View in Scopus\]\(\)',
        r'\t?\[View PDF\]\(\)',
        r'\t?\[View article\]\(\)'
    ]
    
    final_content = content_step2
    for target in targets_to_remove:
        final_content = re.sub(target, '', final_content)

    # --- 4. 保存判定の修正 ---
    # URLが新しく削除された、もしくは、空リンクのクリーンアップによって内容が変化した場合に保存する
    if final_content != original_content:
        file_path.write_text(final_content, encoding="utf-8")
        print(f"[完了] {file_path.name} のクリーンアップが完了しました（不要な空リンクを削除しました）。")
        
        # 削除ログの出力（新規に削除したURLがある場合のみ）
        if deleted_urls:
            log_file_path = Path(__file__).parent / output_log_name
            log_file_path.write_text("\n".join(deleted_urls), encoding="utf-8")
            print(f"[ログ出力] 新規に削除したURL一覧を保存しました: {log_file_path}")
    else:
        print(f"[情報] {file_path.name} はすでにクリーンアップ済みです（変更はありません）。")


if __name__ == "__main__":
    # 処理したいファイルを指定
    target_file = Path(r"C:\Users\a2189\Dropbox\obsidian\10_article\RXFP1\Alam2023.md")
    
    remove_urls_from_md(target_file)