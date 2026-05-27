# GUI for 131_mdrag.py - Paper RAG Interactive Tool
import os
import re
import sys
import socket
import tkinter as tk
import tkinter.font as tkFont
from tkinter import ttk, scrolledtext, messagebox
from datetime import datetime
from pathlib import Path
from dotenv import load_dotenv
from llama_index.core import SimpleDirectoryReader, VectorStoreIndex, Settings, Document
from llama_index.core.node_parser import MarkdownNodeParser
from llama_index.llms.openai import OpenAI
from llama_index.embeddings.openai import OpenAIEmbedding
from openai import OpenAI as OpenAIClient

load_dotenv()

# フォントサイズ設定
FONT_SIZE = 12
DEFAULT_FONT = ("Arial", FONT_SIZE)
MONO_FONT = ("Courier", FONT_SIZE)

class PaperRAGGUI:
    def __init__(self, root):
        self.root = root
        self.root.title("Paper RAG - Interactive")
        self.root.geometry("1000x800")

        self.index = None
        self.query_engine = None
        self.final_nodes = None
        self.section_flag_map = {}
        self.flag_to_section = {}
        self.turn = 1
        self.output_file = None
        self.paper_name = None

        self.setup_ui()

    def setup_ui(self):
        """GUIのレイアウトを設定"""
        # 上部：文献名入力
        input_frame = ttk.Frame(self.root, padding="10")
        input_frame.pack(fill=tk.X)

        label = tk.Label(input_frame, text="文献名:", font=DEFAULT_FONT)
        label.pack(side=tk.LEFT, padx=5)

        self.paper_entry = tk.Entry(input_frame, width=30, font=DEFAULT_FONT)
        self.paper_entry.pack(side=tk.LEFT, padx=5)
        self.paper_entry.insert(0, "Naqvi2005")

        self.init_button = tk.Button(input_frame, text="RAG初期化", command=self.initialize_rag, font=DEFAULT_FONT)
        self.init_button.pack(side=tk.LEFT, padx=5)

        self.status_label = tk.Label(input_frame, text="準備中...", foreground="blue", font=DEFAULT_FONT)
        self.status_label.pack(side=tk.LEFT, padx=5)

        # セクション選択
        section_frame = tk.LabelFrame(self.root, text="検索セクション（複数選択可）", padx=10, pady=10, font=DEFAULT_FONT)
        section_frame.pack(fill=tk.X, padx=10, pady=5)

        self.section_vars = {}
        self.section_frame = section_frame

        # クエリ入力
        query_frame = tk.LabelFrame(self.root, text="クエリ入力", padx=10, pady=10, font=DEFAULT_FONT)
        query_frame.pack(fill=tk.X, padx=10, pady=5)

        query_label = tk.Label(query_frame, text="質問:", font=DEFAULT_FONT)
        query_label.pack(anchor=tk.W, padx=5)

        self.query_text = tk.Text(query_frame, height=3, width=80, font=DEFAULT_FONT)
        self.query_text.pack(fill=tk.X, padx=5, pady=5)

        button_frame = tk.Frame(query_frame)
        button_frame.pack(fill=tk.X, padx=5, pady=5)

        self.query_button = tk.Button(button_frame, text="質問を送信", command=self.send_query, state=tk.DISABLED, font=DEFAULT_FONT)
        self.query_button.pack(side=tk.LEFT, padx=5)

        # 回答表示
        output_frame = tk.LabelFrame(self.root, text="回答", padx=10, pady=10, font=DEFAULT_FONT)
        output_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)

        self.output_text = scrolledtext.ScrolledText(output_frame, height=15, width=100, state=tk.DISABLED, font=MONO_FONT)
        self.output_text.pack(fill=tk.BOTH, expand=True)

    def initialize_rag(self):
        """RAGエンジンを初期化"""
        self.paper_name = self.paper_entry.get().strip()
        if not self.paper_name:
            messagebox.showerror("エラー", "文献名を入力してください")
            return

        self.status_label.config(text="初期化中...", foreground="orange")
        self.root.update()

        try:
            # 設定
            Settings.llm = OpenAI(model="gpt-4o-mini", temperature=0.1)
            Settings.embed_model = OpenAIEmbedding(model="text-embedding-3-small")

            # ファイル読み込み
            file_path = self._find_paper(self.paper_name)
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()

            # クリーニング
            content = re.sub(r'%%.*?%%', '', content, flags=re.DOTALL)
            content = re.sub(r'(^#+)', r'\n\1', content, flags=re.MULTILINE)

            doc = Document(text=content, metadata={"file_name": os.path.basename(file_path)})

            # Main Textのみを抽出
            main_text_match = re.search(r'^#\s+4\s+Main\s+Text', content, re.MULTILINE)
            if not main_text_match:
                messagebox.showerror("エラー", "'# 4 Main Text' が見つかりません")
                return

            main_text_content = content[main_text_match.start():]
            doc_main_text = Document(
                text=main_text_content,
                metadata={"file_name": os.path.basename(file_path), "section": "Main Text"}
            )

            # ノード化
            md_parser = MarkdownNodeParser()
            nodes = md_parser.get_nodes_from_documents([doc_main_text])

            # フィルタリングと段落分割
            final_nodes = []
            for node in nodes:
                final_nodes.extend(self._split_by_paragraphs(node))

            # メタデータ設定
            for node in final_nodes:
                node.excluded_embed_metadata_keys = ["section_name", "header_path", "paragraph_number"]
                node.excluded_llm_metadata_keys = ["section_name", "header_path", "paragraph_number"]

            # インデックス構築
            self.index = VectorStoreIndex(final_nodes)
            self.final_nodes = final_nodes
            self.query_engine = self.index.as_query_engine(
                similarity_top_k=3,
                response_mode="compact",
                streaming=True
            )

            # セクション情報を取得
            self._setup_section_selectors()

            # 出力ファイルを作成
            output_dir = Path.home() / "Dropbox/obsidian/50_coding/llamaindex"
            output_dir.mkdir(parents=True, exist_ok=True)
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
            device_name = socket.gethostname()
            self.output_file = output_dir / f"{timestamp}_dialogue_{self.paper_name}_{device_name}_gui.md"

            self.status_label.config(text=f"準備完了: {self.paper_name} ({len(final_nodes)}ノード)", foreground="green")
            self.query_button.config(state=tk.NORMAL)
            self.append_output(f"=== {self.paper_name} で RAG を初期化しました ===\n総ノード数: {len(final_nodes)}\n\n")

        except Exception as e:
            messagebox.showerror("エラー", f"初期化に失敗: {str(e)}")
            self.status_label.config(text="エラー", foreground="red")

    def _find_paper(self, paper_name: str) -> str:
        """論文ファイルを検索"""
        base_path = Path.home() / "Dropbox/obsidian/10_article"
        for root, _, files in os.walk(base_path):
            for file in files:
                if file.startswith(paper_name) and file.endswith(".md"):
                    return os.path.join(root, file)
        raise FileNotFoundError(f"論文 '{paper_name}' が見つかりません")

    def _split_by_paragraphs(self, node):
        """ノードを段落ごとに分割"""
        def extract_section_name(text: str) -> str:
            match = re.search(r'^##\s+(.+?)(?:\n|$)', text, re.MULTILINE)
            return match.group(1).strip() if match else "Main Text"

        content = node.get_content()
        section = extract_section_name(content)

        if section.lower() in ["references", "abbreviations"]:
            return []

        has_h2 = re.search(r'^##(?!#)', content, re.MULTILINE)
        has_h3 = re.search(r'^###', content, re.MULTILINE)
        if not has_h2 and not has_h3:
            return []

        header_path = node.metadata.get("header_path", "")
        h2_section = None
        if header_path:
            parts = [p for p in header_path.strip('/').split('/') if p]
            if len(parts) >= 1:
                h2_section = parts[-1]

        if not has_h2:
            h3_match = re.search(r'^###\s+(.+?)(?:\n|$)', content, re.MULTILINE)
            if h3_match:
                h2_name = h2_section if h2_section else section
                h3_name = h3_match.group(1).strip()

                # ### タイトル行を保持（削除しない）
                paragraphs = [p.strip() for p in re.split(r'\n\n+', content.strip()) if p.strip()]

                docs = []
                for i, para in enumerate(paragraphs, 1):
                    doc = Document(
                        text=para,
                        metadata={
                            "section_name": h2_name,
                            "header_path": f"## {h2_name} > ### {h3_name}",
                            "paragraph_number": i
                        }
                    )
                    docs.append(doc)
                return docs
            else:
                return []

        subsections = re.split(r'(?=^##)', content, flags=re.MULTILINE)
        docs = []

        for subsection in subsections:
            if not subsection.strip():
                continue

            subsec_match = re.search(r'^##\s+(.+?)(?:\n|$)', subsection, re.MULTILINE)
            if not subsec_match:
                continue

            subsec_name = subsec_match.group(1).strip()
            content_without_header = re.sub(r'^##[^\n]*\n', '', subsection, count=1, flags=re.MULTILINE)

            subsubsections = re.split(r'(?=^###)', content_without_header, flags=re.MULTILINE)
            has_subsubsec = any(re.search(r'^###', s, re.MULTILINE) for s in subsubsections)

            if not has_subsubsec:
                text = content_without_header.strip()
                if text:
                    paragraphs = re.split(r'\n\n+', text)
                    paragraphs = [p.strip() for p in paragraphs if p.strip()]

                    for i, para in enumerate(paragraphs, 1):
                        doc = Document(
                            text=para,
                            metadata={
                                "section_name": subsec_name,
                                "header_path": f"## {subsec_name}",
                                "paragraph_number": i
                            }
                        )
                        docs.append(doc)
            else:
                for idx, subsubsection in enumerate(subsubsections):
                    if not subsubsection.strip():
                        continue

                    subsubsec_match = re.search(r'^###\s+(.+?)(?:\n|$)', subsubsection, re.MULTILINE)
                    if not subsubsec_match:
                        if idx == 0:
                            text = subsubsection.strip()
                            if text:
                                paragraphs = re.split(r'\n\n+', text)
                                paragraphs = [p.strip() for p in paragraphs if p.strip()]
                                for i, para in enumerate(paragraphs, 1):
                                    doc = Document(
                                        text=para,
                                        metadata={
                                            "section_name": subsec_name,
                                            "header_path": f"## {subsec_name}",
                                            "paragraph_number": i
                                        }
                                    )
                                    docs.append(doc)
                        continue

                    subsubsec_name = subsubsec_match.group(1).strip()
                    # ### ヘッダー行を保持（削除しない）
                    text = subsubsection.strip()

                    paragraphs = re.split(r'\n\n+', text)
                    paragraphs = [p.strip() for p in paragraphs if p.strip()]

                    for i, para in enumerate(paragraphs, 1):
                        doc = Document(
                            text=para,
                            metadata={
                                "section_name": subsec_name,
                                "header_path": f"## {subsec_name} > ### {subsubsec_name}",
                                "paragraph_number": i
                            }
                        )
                        docs.append(doc)

        return docs

    def _setup_section_selectors(self):
        """セクション選択チェックボタンを作成"""
        # 既存のセクションチェックボタンを削除
        for widget in self.section_frame.winfo_children():
            widget.destroy()

        # セクション一覧を取得
        seen = set()
        unique_sections = []
        for node in self.final_nodes:
            section = node.metadata.get("section_name", "Unknown")
            if section and section not in seen:
                unique_sections.append(section)
                seen.add(section)

        # マッピングを作成
        self.section_flag_map = {}
        self.flag_to_section = {}
        for section in unique_sections:
            flag = section[0].lower()
            self.section_flag_map[section] = flag
            self.flag_to_section[flag] = section

        # チェックボタンを作成
        self.section_vars = {}
        for section in unique_sections:
            var = tk.BooleanVar()
            cb = ttk.Checkbutton(
                self.section_frame,
                text=f"-{self.section_flag_map[section]}: {section}",
                variable=var
            )
            cb.pack(anchor=tk.W)
            self.section_vars[section] = var

    def _is_japanese(self, text: str) -> bool:
        """テキストが日本語を含むか判定"""
        for char in text:
            code = ord(char)
            if (0x3040 <= code <= 0x309F) or (0x30A0 <= code <= 0x30FF) or (0x4E00 <= code <= 0x9FFF):
                return True
        return False

    def _translate_to_english(self, text: str) -> str:
        """日本語テキストを英語に翻訳"""
        client = OpenAIClient()
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {
                    "role": "user",
                    "content": f"Translate the following Japanese text to English. Return only the English translation:\n\n{text}"
                }
            ],
            temperature=0.1
        )
        return response.choices[0].message.content.strip()

    def send_query(self):
        """クエリを送信して回答を得る"""
        original_query = self.query_text.get("1.0", tk.END).strip()
        if not original_query:
            messagebox.showwarning("警告", "クエリを入力してください")
            return

        self.query_text.delete("1.0", tk.END)
        self.query_button.config(state=tk.DISABLED)
        self.root.update()

        try:
            # 日本語判定と翻訳
            if self._is_japanese(original_query):
                self.append_output(f"[翻訳中...]\n")
                self.root.update()
                query = self._translate_to_english(original_query)
                self.append_output(f"→ {query}\n\n")
            else:
                query = original_query

            # 選択されたセクションを取得
            target_sections = [section for section, var in self.section_vars.items() if var.get()]

            # ノードをフィルタリング
            if target_sections:
                filtered_nodes = [
                    node for node in self.final_nodes
                    if node.metadata.get("section_name") in target_sections
                ]
                if filtered_nodes:
                    filtered_index = VectorStoreIndex(filtered_nodes)
                    query_engine = filtered_index.as_query_engine(
                        similarity_top_k=3,
                        response_mode="compact",
                        streaming=True
                    )
                else:
                    query_engine = self.query_engine
            else:
                query_engine = self.query_engine

            # クエリを実行
            response = query_engine.query(query)

            # 回答を表示
            full_response = ""
            for text in response.response_gen:
                full_response += text

            output = f"\n[Turn {self.turn}] Q: {query}\n"
            if target_sections:
                output += f"(Sections: {', '.join(target_sections)})\n"
            output += f"\nA: {full_response}\n\n"

            # 参照元を表示
            output += "【Source】\n"
            for i, node in enumerate(response.source_nodes, 1):
                path = node.node.metadata.get("header_path", "不明")
                para_num = node.node.metadata.get("paragraph_number", "?")
                score = node.score if hasattr(node, 'score') else 0.0
                content = node.get_content()[:100]
                output += f"{i}. {path} Para {para_num} (score: {score:.4f})\n   {content}...\n\n"

            self.append_output(output)

            # ファイルに書き込み（英語クエリのみを保存）
            self._save_to_file(query, full_response, response.source_nodes, target_sections)

            self.turn += 1

        except Exception as e:
            messagebox.showerror("エラー", f"クエリ実行に失敗: {str(e)}")

        finally:
            self.query_button.config(state=tk.NORMAL)

    def _save_to_file(self, query, response, source_nodes, target_sections):
        """対話履歴をファイルに保存（英語のみ）"""
        if not self.output_file:
            return

        with open(self.output_file, "a", encoding="utf-8") as f:
            if self.turn == 1:
                f.write(f"# Dialogue with {self.paper_name} (GUI mode)\nDate: {datetime.now().strftime('%Y%m%d_%H%M%S')}\n\n")

            f.write(f"## Q{self.turn}: {query}\n")
            if target_sections:
                f.write(f"*(Sections: {', '.join(target_sections)})*\n")
            f.write(f"\n**Answer**:\n{response}\n\n")

            f.write("**Source Details**:\n\n")
            for i, node in enumerate(source_nodes, 1):
                path = node.node.metadata.get("header_path", "Unknown")
                para_num = node.node.metadata.get("paragraph_number", "?")
                score = node.score if hasattr(node, 'score') else 0.0
                content = node.get_content()
                f.write(f"Source {i}: {path} Para {para_num} (score: {score:.4f})\n{content}\n\n")

            f.write("---\n\n")

    def append_output(self, text):
        """テキストを出力エリアに追加"""
        self.output_text.config(state=tk.NORMAL)
        self.output_text.insert(tk.END, text)
        self.output_text.see(tk.END)
        self.output_text.config(state=tk.DISABLED)

if __name__ == "__main__":
    root = tk.Tk()
    app = PaperRAGGUI(root)
    root.mainloop()
