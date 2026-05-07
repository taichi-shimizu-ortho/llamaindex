"""
[Mac版] 全論文JSONからセクション単位でベクトルインデックスを構築・永続化保存
Dropbox内の articles_all3.json → セクション単位 Document → VectorStoreIndex → storage_all/ に保存

実行順: 40_build_articles_index_mac.py → 50_search_all_mac.py
"""

import json
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path.home() / "uv-envs/llamaindex/.env")

from llama_index.core import Document, VectorStoreIndex, Settings, StorageContext
from llama_index.core.node_parser import SentenceSplitter
from llama_index.embeddings.openai import OpenAIEmbedding
from llama_index.llms.openai import OpenAI

# 設定
Settings.llm = OpenAI(model="gpt-5-nano-2025-08-07", temperature=0.1)
Settings.embed_model = OpenAIEmbedding(model="text-embedding-3-large")
Settings.text_splitter = SentenceSplitter(chunk_size=8192, chunk_overlap=0)

# パス設定（Mac: Dropboxから読み込む）
SCRIPT_DIR = Path(__file__).resolve().parent
JSON_FILE = Path.home() / "Library/CloudStorage/Dropbox/obsidian/50_coding/llamaindex/articles_all3.json"
STORAGE_DIR = SCRIPT_DIR / "storage_all"

EXCLUDE_SECTION_TYPES = ['references', 'acknowledgements']


def is_review(article: dict) -> bool:
    if 'is_review' in article:
        return bool(article['is_review'])
    return 'review' in article.get('tags', [])


def should_exclude_paragraph(text: str) -> bool:
    text_lower = text.lower()
    return 'references' in text_lower or 'cited by' in text_lower


def create_section_documents_regular(articles: list[dict]) -> list[Document]:
    documents = []

    for article in articles:
        citekey = article.get('citekey', 'Unknown')
        title = article.get('title', '')
        authors = article.get('authors', [])
        published = article.get('published', '')
        source = article.get('source', '')
        volume = article.get('volume', '')
        issue = article.get('issue', '')

        if isinstance(authors, list) and authors:
            first_author = authors[0].split(',')[0].strip() if authors else ''
            authors_str = ', '.join(authors)
        else:
            first_author = ''
            authors_str = str(authors)

        citation = f"{first_author} {published}".strip() if first_author or published else citekey

        base_metadata = {
            'citekey': citekey,
            'title': title,
            'authors': authors_str,
            'first_author': first_author,
            'published': published,
            'source': source,
            'volume': volume,
            'issue': issue,
            'doi': article.get('doi', ''),
            'pmid': article.get('pmid', ''),
            'citation': citation,
            'article_type': 'regular',
            'mesh_terms': ', '.join(article.get('entrez_mesh_terms', [])),
            'keywords': ', '.join(article.get('entrez_keywords', [])),
        }

        for section in article.get('sections', []):
            section_title = section.get('title', 'Untitled')
            section_type = section.get('type', 'unknown')
            section_content = section.get('content', '')

            if section_type in EXCLUDE_SECTION_TYPES:
                continue

            for para_idx, paragraph in enumerate(section_content.split('\n\n')):
                paragraph = paragraph.strip()
                if paragraph and not should_exclude_paragraph(paragraph):
                    doc = Document(
                        text=paragraph,
                        metadata={
                            **base_metadata,
                            'section': section_title,
                            'section_type': section_type,
                            'subsection': '',
                            'paragraph_index': para_idx,
                        }
                    )
                    documents.append(doc)

            for subsection in section.get('subsections', []):
                subsection_title = subsection.get('title', 'Untitled')
                subsection_content = subsection.get('content', '')

                for para_idx, paragraph in enumerate(subsection_content.split('\n\n')):
                    paragraph = paragraph.strip()
                    if paragraph and not should_exclude_paragraph(paragraph):
                        doc = Document(
                            text=paragraph,
                            metadata={
                                **base_metadata,
                                'section': section_title,
                                'section_type': section_type,
                                'subsection': subsection_title,
                                'paragraph_index': para_idx,
                            }
                        )
                        documents.append(doc)

    return documents


def create_section_documents_review(articles: list[dict]) -> list[Document]:
    documents = []

    for article in articles:
        citekey = article.get('citekey', 'Unknown')
        title = article.get('title', '')
        authors = article.get('authors', [])
        published = article.get('published', '')
        source = article.get('source', '')
        volume = article.get('volume', '')
        issue = article.get('issue', '')

        if isinstance(authors, list) and authors:
            first_author = authors[0].split(',')[0].strip() if authors else ''
            authors_str = ', '.join(authors)
        else:
            first_author = ''
            authors_str = str(authors)

        citation = f"{first_author} {published}".strip() if first_author or published else citekey

        base_metadata = {
            'citekey': citekey,
            'title': title,
            'authors': authors_str,
            'first_author': first_author,
            'published': published,
            'source': source,
            'volume': volume,
            'issue': issue,
            'doi': article.get('doi', ''),
            'pmid': article.get('pmid', ''),
            'citation': citation,
            'article_type': 'review',
            'mesh_terms': ', '.join(article.get('entrez_mesh_terms', [])),
            'keywords': ', '.join(article.get('entrez_keywords', [])),
        }

        for section in article.get('sections', []):
            section_title = section.get('title', 'Untitled')
            section_type = section.get('type', 'unknown')
            section_content = section.get('content', '')

            if section_type in EXCLUDE_SECTION_TYPES:
                continue

            combined_content = section_content
            for subsection in section.get('subsections', []):
                subsection_content = subsection.get('content', '')
                if subsection_content.strip():
                    combined_content += '\n\n' + subsection_content

            if combined_content.strip():
                for para_idx, paragraph in enumerate(combined_content.split('\n\n')):
                    paragraph = paragraph.strip()
                    if paragraph and not should_exclude_paragraph(paragraph):
                        doc = Document(
                            text=paragraph,
                            metadata={
                                **base_metadata,
                                'section': section_title,
                                'section_type': section_type,
                                'paragraph_index': para_idx,
                            }
                        )
                        documents.append(doc)

    return documents


def create_section_documents(articles: list[dict]) -> list[Document]:
    review_articles = [a for a in articles if is_review(a)]
    regular_articles = [a for a in articles if not is_review(a)]

    documents = []
    documents.extend(create_section_documents_regular(regular_articles))
    documents.extend(create_section_documents_review(review_articles))

    return documents


def build_and_save_index(json_file: Path, storage_dir: Path) -> VectorStoreIndex:
    print(f"[*] JSONファイルを読み込み中: {json_file}")
    with open(json_file, 'r', encoding='utf-8') as f:
        data = json.load(f)

    articles = data.get('articles', [])
    print(f"[OK] {len(articles)}件の論文を読み込みました")

    print(f"\n[*] セクション単位でDocumentを作成中...")
    print(f"    除外セクション: {', '.join(EXCLUDE_SECTION_TYPES)}")
    review_articles = [a for a in articles if is_review(a)]
    regular_articles = [a for a in articles if not is_review(a)]
    print(f"    regular: {len(regular_articles)}件 / review: {len(review_articles)}件")

    documents = create_section_documents(articles)
    print(f"[OK] {len(documents)}個のDocumentを作成（段落単位）")

    section_types = {}
    for doc in documents:
        st = doc.metadata.get('section_type', 'unknown')
        section_types[st] = section_types.get(st, 0) + 1

    print("\nセクションタイプ分布（Document数）:")
    for st, count in sorted(section_types.items(), key=lambda x: -x[1]):
        print(f"  {st}: {count}件")

    print(f"\n[*] ベクトルインデックスを構築中...")
    print("    (OpenAI APIでembeddingを生成します。しばらくお待ちください...)")
    index = VectorStoreIndex.from_documents(documents, show_progress=True)
    print("[OK] インデックス構築完了")

    storage_dir.mkdir(exist_ok=True)
    print(f"\n[*] インデックスを保存中: {storage_dir}")
    index.storage_context.persist(persist_dir=str(storage_dir))
    print(f"[OK] 保存完了")

    saved_files = list(storage_dir.iterdir())
    total_size = sum(f.stat().st_size for f in saved_files if f.is_file()) / 1024
    print(f"\n保存ファイル ({len(saved_files)}件, 合計 {total_size:.1f} KB):")
    for f in sorted(saved_files):
        print(f"  {f.name} ({f.stat().st_size / 1024:.1f} KB)")

    return index


def main():
    print("=" * 80)
    print("全論文インデックス構築ツール [Mac版 - articles_all3.json]")
    print("=" * 80)
    print(f"入力JSON: {JSON_FILE}")
    print(f"保存先: {STORAGE_DIR.name}/")
    print("=" * 80)

    if not JSON_FILE.exists():
        print(f"[!] エラー: articles_all3.json が見つかりません")
        print(f"    パス: {JSON_FILE}")
        return

    if STORAGE_DIR.exists():
        print(f"\n[!] 既存のインデックスが見つかりました: {STORAGE_DIR}")
        response = input("    上書きしますか？ (y/N): ").strip().lower()
        if response != 'y':
            print("    処理を中断しました")
            return
        import shutil
        shutil.rmtree(STORAGE_DIR)
        print("    既存インデックスを削除しました")

    build_and_save_index(JSON_FILE, STORAGE_DIR)

    print("\n" + "=" * 80)
    print("完了！次のコマンドで検索を実行できます:")
    print("  python 50_search_all_mac.py")
    print("=" * 80)


if __name__ == "__main__":
    main()
