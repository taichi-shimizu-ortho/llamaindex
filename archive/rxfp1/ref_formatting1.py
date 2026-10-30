import re
from pathlib import Path

def format_references_in_file(file_path: Path):
    """
    指定された Markdown ファイルの ## References セクションを解析し、
    文献を1件ずつ改行して番号付きリスト (1. , 2. ...) に整形する。
    ※数字の太字 (例: **12**) には反応しないよう対策済み。
    """
    if not file_path.exists():
        print(f"[エラー] ファイルが見つかりません: {file_path}")
        return

    content = file_path.read_text(encoding="utf-8")

    # ## References セクションを探す (大文字小文字を区別しない)
    ref_pattern = re.compile(r'(##\s+References\s*\n)(.*)', re.DOTALL | re.IGNORECASE)
    match = ref_pattern.search(content)

    if not match:
        print(f"[スキップ] {file_path.name} に ## References セクションが見つかりません。")
        return

    header_part = match.group(1)  # "## References\n"
    references_part = match.group(2)  # References以降の全テキスト

    # Referencesの後に別の大見出し (#) がある場合は、そこまでを対象とする
    next_h_match = re.search(r'\n#(?!#)\s+', references_part)
    if next_h_match:
        ref_body = references_part[:next_h_match.start()]
        remaining_part = references_part[next_h_match.start():]
    else:
        ref_body = references_part
        remaining_part = ""

    # --- 文献の抽出と整形ロジック ---
    # 太字の開始 `**` の直後が「アルファベット（A-Z, a-z）」で始まる場合のみ、文献の区切りとして分割する。
    # これにより、巻数などの数字の太字（例: **12**）を完全に除外します。
    split_pattern = re.compile(r'\s*(?=\*\*([A-Za-z])[^*]+\*\*)')
    
    # 分割して、空行を除外
    raw_items = split_pattern.split(ref_body)
    
    # re.split にグループ () を使うとマッチした文字（ここでは頭文字のアルファベット）もリストに入ってしまうため、
    # 偶数番目の要素（分割された本文）のみを抽出して結合を復元する
    items = []
    # split_pattern.split は [テキスト, 頭文字, テキスト, 頭文字...] のようになるため、
    # 適切にパースするために finditer を使った安全な分割に切り替えます。
    
    # 著者太字の開始位置をすべて特定する
    matches = list(split_pattern.finditer(ref_body))
    
    if matches:
        items = []
        # 最初のマッチより前のテキスト（通常は空か、ゴミデータ）
        first_part = ref_body[:matches[0].start()].strip()
        if first_part:
            items.append(first_part)
            
        for i in range(len(matches)):
            start = matches[i].start()
            end = matches[i+1].start() if i+1 < len(matches) else len(ref_body)
            items.append(ref_body[start:end].strip())
    else:
        # マッチがない場合はそのまま
        items = [ref_body.strip()]

    # 空の要素を除外
    items = [item for item in items if item]

    # 番号付きリストに整形
    formatted_items = []
    for idx, item in enumerate(items, 1):
        # 既に "1. " などの番号がついている場合は、重複しないように除去
        cleaned_item = re.sub(r'^\d+\.\s*', '', item)
        formatted_items.append(f"{idx}. {cleaned_item}")

    # 整形したReferencesセクションを組み立て
    new_ref_body = "\n".join(formatted_items) + "\n"
    
    # ファイル全体のテキストを再構築
    new_content = content[:match.start()] + header_part + new_ref_body + remaining_part

    # 上書き保存
    file_path.write_text(new_content, encoding="utf-8")
    print(f"[完了] {file_path.name} の References を整形しました（計 {len(formatted_items)} 件）")


if __name__ == "__main__":
    # テスト実行用
    target_file = Path.home() / "Dropbox" / "obsidian" / "10_article" / "RXFP1" / "Kronemberger2020.md"
    format_references_in_file(target_file)