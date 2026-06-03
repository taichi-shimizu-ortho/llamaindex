"""
[STEP 03] 10_article/RXFP1/ 内の MD ファイルを更新するスクリプト。

処理内容:
  1. # 4 Main Text 内の最初の ## ヘッダーより前に本文があれば ## Introduction を自動付与
  2. YAML frontmatter に doi, pmid, mesh_terms, keywords を追加

前提: 10_fetch_entrez_metadata.py を先に実行して entrez_metadata.json を生成しておくこと

データソース: entrez_metadata.json（fetch_entrez_metadata.py で取得済み）
対象: RXFP1 フォルダのみ
"""
import json
import re
from pathlib import Path

import yaml

SCRIPT_DIR   = Path(__file__).parent
ENTREZ_PATH  = SCRIPT_DIR / "entrez_metadata.json"
RXFP1_DIR    = Path.home() / "Dropbox" / "obsidian" / "10_article" / "RXFP1"

# frontmatter を分割する正規表現
FM_PATTERN = re.compile(r'^---\s*\n(.*?)\n---\s*\n(.*)', re.DOTALL)


def split_frontmatter(content: str) -> tuple[dict, str] | tuple[None, str]:
    """frontmatter と本文を分離。frontmatter がなければ (None, content) を返す。"""
    m = FM_PATTERN.match(content)
    if not m:
        return None, content
    try:
        fm = yaml.safe_load(m.group(1)) or {}
    except yaml.YAMLError:
        return None, content
    return fm, m.group(2)


def to_yaml_str(fm: dict) -> str:
    """frontmatter dict を YAML 文字列に変換。"""
    return yaml.dump(
        fm,
        allow_unicode=True,
        default_flow_style=False,
        sort_keys=False,
    )


def insert_intro_header_if_missing(content: str) -> tuple[str, bool]:
    """
    # 4 Main Text 内で最初の ## ヘッダーより前に本文があれば
    ## Introduction を自動挿入する。

    Returns: (new_content, was_modified)
    """
    main_text_match = re.search(r'^# 4 Main Text\s*\n', content, re.MULTILINE)
    if not main_text_match:
        return content, False

    section_start = main_text_match.end()

    # # 4 Main Text 以降の内容（次の h1 または末尾まで）
    rest = content[section_start:]

    # ## Introduction または ## Background が既に存在する場合はスキップ（重複防止・Background はIntro相当として扱う）
    if re.search(r'^##\s+(Introduction|Background)\b', rest, re.MULTILINE | re.IGNORECASE):
        return content, False

    # 最初の ## ヘッダーを探す
    first_h2 = re.search(r'^##\s+', rest, re.MULTILINE)
    if not first_h2:
        return content, False

    pre_content = rest[:first_h2.start()]

    # 先頭の水平線 (---) と空白行を取り除いて内容があるか確認
    pre_clean = re.sub(r'^-{3,}\s*$', '', pre_content, flags=re.MULTILINE).strip()
    if not pre_clean:
        return content, False

    # 先頭の --- 行を除去して intro 本文を整形
    intro_body = re.sub(r'^(?:-{3,}\s*\n)+', '', pre_content).strip('\n')

    # ## Introduction を挿入
    new_pre = '\n## Introduction\n\n' + intro_body + '\n\n'
    new_content = content[:section_start] + new_pre + rest[first_h2.start():]
    return new_content, True


def handle_background_section(content: str) -> tuple[str, list[str]]:
    """
    # 4 Main Text 内の ## Background を処理する。
    - Background と Introduction が両方ある場合: アラートを返す（変更なし）
    - Background のみある場合: ## Introduction に改名する

    Returns: (new_content, alerts)
    """
    main_text_match = re.search(r'^# 4 Main Text\s*\n', content, re.MULTILINE)
    if not main_text_match:
        return content, []

    section_start = main_text_match.end()
    rest = content[section_start:]
    has_background = bool(re.search(r'^##\s+Background\b', rest, re.MULTILINE | re.IGNORECASE))
    has_introduction = bool(re.search(r'^##\s+Introduction\b', rest, re.MULTILINE | re.IGNORECASE))

    if has_background and has_introduction:
        return content, ["⚠ Background と Introduction が両方存在します"]

    # ## Background は Introduction 相当として扱うが、ヘッダー名は変更しない
    return content, []


def insert_keywords_section(content: str, keywords: list[str]) -> tuple[str, bool]:
    """
    entrez keywords が存在し、## Keywords セクションが未存在の場合、
    References/Acknowledgements より前（なければ Main Text 末尾）に挿入する。

    Returns: (new_content, was_inserted)
    """
    if not keywords:
        return content, False

    main_text_match = re.search(r'^# 4 Main Text\s*\n', content, re.MULTILINE)
    if not main_text_match:
        return content, False

    section_start = main_text_match.end()
    rest = content[section_start:]

    # 既に ## Keywords セクションがあればスキップ
    if re.search(r'^##\s+Keywords?\b', rest, re.MULTILINE | re.IGNORECASE):
        return content, False

    kw_section = "\n## Keywords\n\n" + ", ".join(keywords) + "\n"

    # References/Acknowledgements の前に挿入
    ref_match = re.search(
        r'^##\s+(?:References?|Acknowledgements?|Acknowledgments?)\b',
        rest, re.MULTILINE | re.IGNORECASE,
    )
    if ref_match:
        insert_pos = section_start + ref_match.start()
        new_content = content[:insert_pos] + kw_section + "\n" + content[insert_pos:]
    else:
        # 次の h1 の直前、なければ末尾
        next_h1 = re.search(r'^#(?!#)\s+', rest, re.MULTILINE)
        if next_h1:
            insert_pos = section_start + next_h1.start()
            new_content = content[:insert_pos] + kw_section + "\n" + content[insert_pos:]
        else:
            new_content = content.rstrip('\n') + kw_section

    return new_content, True


def build_entrez_lookup(entrez_path: Path) -> dict:
    """citekey → entrez レコードの辞書を作成。"""
    with open(entrez_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return {r["citekey"]: r for r in data.get("articles", [])}


def main():
    import sys

    if not RXFP1_DIR.exists():
        print(f"[エラー] ディレクトリが見つかりません: {RXFP1_DIR}")
        return

    entrez_lookup = build_entrez_lookup(ENTREZ_PATH)

    # 引数でファイル名を指定した場合はそのファイルのみ対象
    if len(sys.argv) > 1:
        target = sys.argv[1]
        if not target.endswith(".md"):
            target += ".md"
        md_files = [RXFP1_DIR / target]
        if not md_files[0].exists():
            print(f"[エラー] ファイルが見つかりません: {md_files[0]}")
            return
    else:
        md_files = sorted(RXFP1_DIR.glob("*.md"))

    print(f"対象ファイル数: {len(md_files)}")
    print("=" * 60)

    updated = 0
    intro_added = 0
    skipped_no_fm = 0
    skipped_no_entrez = 0

    for md_file in md_files:
        content = md_file.read_text(encoding="utf-8")
        fm, body = split_frontmatter(content)

        if fm is None:
            print(f"  [スキップ] {md_file.name}（frontmatter なし）")
            skipped_no_fm += 1
            continue

        file_modified = False
        alerts = []

        # 1. ## Introduction の自動付与
        content, intro_inserted = insert_intro_header_if_missing(content)
        if intro_inserted:
            file_modified = True
            intro_added += 1
            alerts.append("## Introduction 自動付与")
            _, body = split_frontmatter(content)

        # 2. ## Background の処理
        content, bg_alerts = handle_background_section(content)
        if bg_alerts:
            alerts.extend(bg_alerts)
            if any("改名" in a for a in bg_alerts):
                file_modified = True
                _, body = split_frontmatter(content)

        # 3. entrez メタデータ更新
        citekey = fm.get("citekey", "")
        rec = entrez_lookup.get(citekey)

        if not rec:
            # citekey が大文字小文字違いの可能性があるので case-insensitive で再検索
            ck_lower = citekey.lower()
            rec = next(
                (r for r in entrez_lookup.values() if r["citekey"].lower() == ck_lower),
                None,
            )

        if rec:
            fm["doi"]        = rec.get("doi", "") or fm.get("doi", "")
            fm["pmid"]       = rec.get("pmid", "") or fm.get("pmid", "")
            fm["pmcid"]      = rec.get("pmcid", "") or fm.get("pmcid", "")
            fm["mesh_terms"] = rec.get("entrez_mesh_terms", [])
            fm["keywords"]   = rec.get("entrez_keywords", [])
            # --- 追加：review 判定を boolean (True/False) でヘッダーに書き込む ---
            # JSON 内の "entrez_is_review" (True/False/None) をそのまま反映
            # データがない場合は、既存の tags に "review" があるかでフォールバック
            entrez_is_review = rec.get("entrez_is_review")
            if entrez_is_review is not None:
                fm["review"] = entrez_is_review
            else:
                fm["review"] = "review" in fm.get("tags", [])
            # -----------------------------------------------------------------

            new_fm_str = to_yaml_str(fm)
            
            content = f"---\n{new_fm_str}---\n{body}"
            file_modified = True
            updated += 1

            # 4. ## Keywords セクションの挿入
            entrez_kw = rec.get("entrez_keywords", [])
            content, kw_inserted = insert_keywords_section(content, entrez_kw)
            if kw_inserted:
                file_modified = True
                alerts.append(f"## Keywords 挿入（{len(entrez_kw)}件）")

            review_str = "review" if rec.get("entrez_is_review") else "original"
            alert_str = f" | {'、'.join(alerts)}" if alerts else ""
            print(f"  [OK] {md_file.name} ({review_str}) | MeSH:{len(fm['mesh_terms'])}件{alert_str}")
        else:
            if alerts:
                print(f"  [追加] {md_file.name} | {'、'.join(alerts)}（entrez データなし）")
            else:
                print(f"  [スキップ] {md_file.name}（entrez データなし: {citekey}）")
            skipped_no_entrez += 1

        if file_modified:
            md_file.write_text(content, encoding="utf-8")

    print("\n" + "=" * 60)
    print(f"frontmatter更新: {updated}件 / ## Introduction付与: {intro_added}件")
    print(f"frontmatterなし: {skipped_no_fm}件 / entrezデータなし: {skipped_no_entrez}件")
    print("\n次のステップ: python 04_batch_convert_articles.py")


if __name__ == "__main__":
    main()
