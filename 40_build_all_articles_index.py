"""
[STEP 05] 全論文JSONからセクション単位でベクトルインデックスを構築・永続化保存
articles_all.json → セクション単位 Document → VectorStoreIndex → storage_all/ に保存

実行順: 10 → 20 → 30 → 40 → 50
前提: 30_batch_convert_articles.py を実行して articles_all.json を生成しておくこと
"""

import json
from pathlib import Path

from llama_index.core import Document, VectorStoreIndex, Settings, StorageContext
from llama_index.core.node_parser import SentenceSplitter
from llama_index.embeddings.openai import OpenAIEmbedding
from llama_index.llms.openai import OpenAI

# 設定
Settings.llm = OpenAI(model="gpt-5-nano-2025-08-07", temperature=0.1)
Settings.embed_model = OpenAIEmbedding(model="text-embedding-3-large")
# 段落単位でDocument化済みのため、LlamaIndexの自動チャンク分割を抑制
Settings.text_splitter = SentenceSplitter(chunk_size=8192, chunk_overlap=0)

# パス設定
SCRIPT_DIR = Path(__file__).resolve().parent
JSON_FILE = SCRIPT_DIR / "articles_all.json"
STORAGE_DIR = SCRIPT_DIR / "storage_all"

# 検索対象から除外するセクションタイプ
# 注: 'other' は含めない (レビュー論文など独自構造を持つ記事の内容を保持)
EXCLUDE_SECTION_TYPES = ['references', 'acknowledgements']


def is_review(article: dict) -> bool:
    """
    記事がreview論文かどうかを判定。
    is_review フィールドを優先し、なければ tags にフォールバック。
    """
    if 'is_review' in article:
        return bool(article['is_review'])
    # フォールバック: 旧来の tags ベース判定
    return 'review' in article.get('tags', [])


def should_exclude_paragraph(text: str) -> bool:
    """
    段落が除外対象かどうかを判定

    Args:
        text: 段落テキスト

    Returns:
        "references" または "cited by" を含む場合True
    """
    text_lower = text.lower()
    return 'references' in text_lower or 'cited by' in text_lower


def create_section_documents_regular(articles: list[dict]) -> list[Document]:
    """
    通常の論文のセクション/サブセクションをDocumentに変換

    Args:
        articles: review以外の論文データのリスト

    Returns:
        Documentのリスト（セクション/サブセクション単位）
    """
    documents = []

    for article in articles:
        citekey = article.get('citekey', 'Unknown')
        title = article.get('title', '')
        authors = article.get('authors', [])
        published = article.get('published', '')
        source = article.get('source', '')
        volume = article.get('volume', '')
        issue = article.get('issue', '')

        # 著者リストを文字列に変換
        if isinstance(authors, list) and authors:
            first_author = authors[0].split(',')[0].strip() if authors else ''
            authors_str = ', '.join(authors)
        else:
            first_author = ''
            authors_str = str(authors)

        # 引用形式（例: "Sato 2014"）
        citation = f"{first_author} {published}".strip() if first_author or published else citekey

        # 基本メタデータ
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

            # 除外対象はスキップ
            if section_type in EXCLUDE_SECTION_TYPES:
                continue

            # メインセクションのコンテンツ（段落単位）
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

            # サブセクション（段落単位）
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
    """
    review論文のセクション内容を段落単位でDocumentに変換

    Args:
        articles: review論文データのリスト

    Returns:
        Documentのリスト（段落単位）
    """
    documents = []

    for article in articles:
        citekey = article.get('citekey', 'Unknown')
        title = article.get('title', '')
        authors = article.get('authors', [])
        published = article.get('published', '')
        source = article.get('source', '')
        volume = article.get('volume', '')
        issue = article.get('issue', '')

        # 著者リストを文字列に変換
        if isinstance(authors, list) and authors:
            first_author = authors[0].split(',')[0].strip() if authors else ''
            authors_str = ', '.join(authors)
        else:
            first_author = ''
            authors_str = str(authors)

        # 引用形式（例: "Sato 2014"）
        citation = f"{first_author} {published}".strip() if first_author or published else citekey

        # 基本メタデータ
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

            # 除外対象はスキップ
            if section_type in EXCLUDE_SECTION_TYPES:
                continue

            # セクション + すべてのサブセクションのコンテンツをまとめる
            combined_content = section_content
            for subsection in section.get('subsections', []):
                subsection_content = subsection.get('content', '')
                if subsection_content.strip():
                    combined_content += '\n\n' + subsection_content

            # セクション内容を段落で分割（\n\n で区切られた部分）
            if combined_content.strip():
                paragraphs = combined_content.split('\n\n')
                for para_idx, paragraph in enumerate(paragraphs):
                    paragraph = paragraph.strip()
                    # 空でない段落で、references/cited by を含まないものをDocument化
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
    """
    全論文をreviewと通常の論文に分類して処理

    Args:
        articles: 論文データのリスト

    Returns:
        Documentのリスト
    """
    # review と regular に分類
    review_articles = [a for a in articles if is_review(a)]
    regular_articles = [a for a in articles if not is_review(a)]

    # 各タイプの論文を処理
    documents = []
    documents.extend(create_section_documents_regular(regular_articles))
    documents.extend(create_section_documents_review(review_articles))

    return documents


def build_and_save_index(json_file: Path, storage_dir: Path) -> VectorStoreIndex:
    """
    全論文インデックスを構築してディスクに保存

    Args:
        json_file: 全論文JSONファイルパス
        storage_dir: インデックス保存先ディレクトリ

    Returns:
        VectorStoreIndex
    """
    # JSON読み込み
    print(f"[*] JSONファイルを読み込み中: {json_file.name}")
    with open(json_file, 'r', encoding='utf-8') as f:
        data = json.load(f)

    articles = data.get('articles', [])
    print(f"[OK] {len(articles)}件の論文を読み込みました")

    # Document作成
    print(f"\n[*] セクション単位でDocumentを作成中...")
    print(f"    除外セクション: {', '.join(EXCLUDE_SECTION_TYPES)}")
    documents = create_section_documents(articles)
    print(f"[OK] {len(documents)}個のDocumentを作成")

    # 統計表示
    section_types = {}
    article_types = {}
    for doc in documents:
        st = doc.metadata.get('section_type', 'unknown')
        section_types[st] = section_types.get(st, 0) + 1
        at = doc.metadata.get('article_type', 'unknown')
        article_types[at] = article_types.get(at, 0) + 1

    print("\n論文タイプ分布:")
    for at, count in sorted(article_types.items(), key=lambda x: -x[1]):
        print(f"  {at}: {count}件")

    print("\nセクションタイプ分布:")
    for st, count in sorted(section_types.items(), key=lambda x: -x[1]):
        print(f"  {st}: {count}件")

    # インデックス構築
    print(f"\n[*] ベクトルインデックスを構築中...")
    print("    (OpenAI APIでembeddingを生成します。しばらくお待ちください...)")
    index = VectorStoreIndex.from_documents(documents, show_progress=True)
    print("[OK] インデックス構築完了")

    # 永続化保存
    storage_dir.mkdir(exist_ok=True)
    print(f"\n[*] インデックスを保存中: {storage_dir}")
    index.storage_context.persist(persist_dir=str(storage_dir))
    print(f"[OK] 保存完了")

    # 保存ファイル一覧
    saved_files = list(storage_dir.iterdir())
    total_size = sum(f.stat().st_size for f in saved_files if f.is_file()) / 1024
    print(f"\n保存ファイル ({len(saved_files)}件, 合計 {total_size:.1f} KB):")
    for f in sorted(saved_files):
        print(f"  {f.name} ({f.stat().st_size / 1024:.1f} KB)")

    return index


def main():
    print("=" * 80)
    print("全論文インデックス構築ツール")
    print("=" * 80)
    print(f"入力JSON: {JSON_FILE.name}")
    print(f"保存先: {STORAGE_DIR.name}/")
    print("=" * 80)

    if not JSON_FILE.exists():
        print(f"[!] エラー: {JSON_FILE} が見つかりません")
        print("    先に 04_batch_convert_articles.py を実行してください")
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
    print("  python 50_search_all_articles.py")
    print("=" * 80)


if __name__ == "__main__":
    main()
