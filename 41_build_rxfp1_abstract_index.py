"""
abstract_rxfp1.json から abstract 単位でベクトルインデックスを構築・永続化保存

入力: abstract_rxfp1.json (Obsidian RXFP1フォルダのfrontmatter + abstract)
出力: storage_rxfp1_abstract/ にインデックスを保存

実行: uv run 41_build_rxfp1_abstract_index.py
検索: uv run 51_search_rxfp1_abstract.py
"""

import json
from pathlib import Path

from llama_index.core import Document, VectorStoreIndex, Settings, StorageContext
from llama_index.core.node_parser import SentenceSplitter
from llama_index.embeddings.openai import OpenAIEmbedding
from llama_index.llms.openai import OpenAI

Settings.llm = OpenAI(model="gpt-4o-mini", temperature=0.1)
Settings.embed_model = OpenAIEmbedding(model="text-embedding-3-large")
Settings.text_splitter = SentenceSplitter(chunk_size=8192, chunk_overlap=0)

SCRIPT_DIR = Path(__file__).resolve().parent
JSON_FILE = Path.home() / "Dropbox" / "obsidian" / "50_coding" / "llamaindex" / "abstract_rxfp1.json"
STORAGE_DIR = Path.home() / "Dropbox" / "obsidian" / "50_coding" / "llamaindex" / "storage_rxfp1_abstract"


def build_documents(files: list[dict]) -> list[Document]:
    documents = []

    for entry in files:
        props = entry.get("properties", {})
        abstract = entry.get("abstract", "").strip()

        if not abstract:
            continue

        # tags / mesh_terms / keywords はリストの場合もあるので文字列化
        def to_str(val):
            if isinstance(val, list):
                return ", ".join(str(v) for v in val if v)
            return str(val) if val else ""

        metadata = {
            "citekey": props.get("citekey", ""),
            "title": props.get("title", ""),
            "doi": props.get("doi", ""),
            "pmid": props.get("pmid", ""),
            "pmcid": props.get("pmcid", ""),
            "dateread": props.get("dateread", ""),
            "tags": to_str(props.get("tags", "")),
            "mesh_terms": to_str(props.get("mesh_terms", "")),
            "keywords": to_str(props.get("keywords", "")),
            "filename": entry.get("filename", ""),
        }

        doc = Document(text=abstract, metadata=metadata)
        documents.append(doc)

    return documents


def build_and_save_index(json_file: Path, storage_dir: Path) -> VectorStoreIndex:
    print(f"[*] JSONを読み込み中: {json_file}")
    with open(json_file, "r", encoding="utf-8") as f:
        data = json.load(f)

    files = data.get("files", [])
    print(f"[OK] {len(files)} 件のエントリを読み込みました")

    print("[*] Document を作成中...")
    documents = build_documents(files)
    print(f"[OK] {len(documents)} 件の Document を作成 (abstract なしはスキップ)")

    print("[*] ベクトルインデックスを構築中 (OpenAI embedding)...")
    index = VectorStoreIndex.from_documents(documents, show_progress=True)
    print("[OK] インデックス構築完了")

    storage_dir.mkdir(parents=True, exist_ok=True)
    print(f"[*] 保存中: {storage_dir}")
    index.storage_context.persist(persist_dir=str(storage_dir))

    saved_files = list(storage_dir.iterdir())
    total_kb = sum(f.stat().st_size for f in saved_files if f.is_file()) / 1024
    print(f"[OK] 保存完了 ({len(saved_files)} ファイル, {total_kb:.1f} KB)")

    return index


def main():
    print("=" * 70)
    print("RXFP1 Abstract インデックス構築")
    print("=" * 70)
    print(f"入力: {JSON_FILE}")
    print(f"保存先: {STORAGE_DIR}")
    print("=" * 70)

    if not JSON_FILE.exists():
        print(f"[!] エラー: {JSON_FILE} が見つかりません")
        print("    先に build_rxfp1_json.py を実行して abstract_rxfp1.json を生成してください")
        return

    if STORAGE_DIR.exists():
        print(f"\n[!] 既存インデックスが見つかりました: {STORAGE_DIR}")
        response = input("    上書きしますか？ (y/N): ").strip().lower()
        if response != "y":
            print("    処理を中断しました")
            return
        import shutil
        shutil.rmtree(STORAGE_DIR)
        print("    既存インデックスを削除しました")

    build_and_save_index(JSON_FILE, STORAGE_DIR)

    print("\n" + "=" * 70)
    print("完了！次のコマンドで検索を実行できます:")
    print("  uv run 51_search_rxfp1_abstract.py")
    print("=" * 70)


if __name__ == "__main__":
    main()
