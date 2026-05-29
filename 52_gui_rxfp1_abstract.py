# GUI for 51_search_rxfp1_abstract.py - RXFP1 Abstract RAG Interactive Tool
import socket
import tkinter as tk
import tkinter.font as tkFont
from tkinter import ttk, scrolledtext, messagebox
from datetime import datetime
from pathlib import Path
from dotenv import load_dotenv
from llama_index.core import Settings, StorageContext, load_index_from_storage
from llama_index.embeddings.openai import OpenAIEmbedding
from llama_index.llms.openai import OpenAI
from openai import OpenAI as OpenAIClient

load_dotenv()

FONT_SIZE = 12
DEFAULT_FONT = ("Segoe UI", FONT_SIZE)
MONO_FONT = ("Consolas", FONT_SIZE)

STORAGE_DIR = Path.home() / "Dropbox" / "obsidian" / "50_coding" / "llamaindex" / "storage_rxfp1_abstract"
OUTPUT_DIR = Path.home() / "Dropbox" / "obsidian" / "50_coding" / "llamaindex"


class RxfpAbstractRAGGUI:
    def __init__(self, root):
        self.root = root
        self.root.title("RXFP1 Abstract RAG")
        self.root.geometry("1000x820")

        self.index = None
        self.turn = 1
        self.output_file = None

        self.setup_ui()
        self.initialize_rag()

    def setup_ui(self):
        # 上部：ステータス＋設定
        top_frame = ttk.Frame(self.root, padding="10")
        top_frame.pack(fill=tk.X)

        self.status_label = tk.Label(top_frame, text="インデックス読み込み中...", foreground="orange", font=DEFAULT_FONT)
        self.status_label.pack(side=tk.LEFT, padx=5)

        tk.Label(top_frame, text="  Top-K:", font=DEFAULT_FONT).pack(side=tk.LEFT, padx=(20, 2))
        self.topk_var = tk.IntVar(value=5)
        topk_spin = tk.Spinbox(top_frame, from_=1, to=20, textvariable=self.topk_var, width=4, font=DEFAULT_FONT)
        topk_spin.pack(side=tk.LEFT)

        self.reload_button = tk.Button(top_frame, text="再読み込み", command=self.initialize_rag, font=DEFAULT_FONT)
        self.reload_button.pack(side=tk.LEFT, padx=10)

        # クエリ入力
        query_frame = tk.LabelFrame(self.root, text="クエリ入力（日本語可）", padx=10, pady=8, font=DEFAULT_FONT)
        query_frame.pack(fill=tk.X, padx=10, pady=5)

        self.query_text = tk.Text(query_frame, height=3, width=80, font=DEFAULT_FONT)
        self.query_text.pack(fill=tk.X, padx=5, pady=5)
        self.query_text.bind("<Control-Return>", lambda e: self.send_query())

        btn_frame = tk.Frame(query_frame)
        btn_frame.pack(fill=tk.X, padx=5, pady=(0, 5))

        self.query_button = tk.Button(
            btn_frame, text="質問を送信 (Ctrl+Enter)",
            command=self.send_query, state=tk.DISABLED, font=DEFAULT_FONT
        )
        self.query_button.pack(side=tk.LEFT, padx=5)

        self.clear_button = tk.Button(btn_frame, text="出力クリア", command=self.clear_output, font=DEFAULT_FONT)
        self.clear_button.pack(side=tk.LEFT, padx=5)

        # 回答表示
        output_frame = tk.LabelFrame(self.root, text="回答・引用元", padx=10, pady=10, font=DEFAULT_FONT)
        output_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)

        self.output_text = scrolledtext.ScrolledText(
            output_frame, height=20, width=100,
            state=tk.DISABLED, font=MONO_FONT, wrap=tk.WORD
        )
        self.output_text.pack(fill=tk.BOTH, expand=True)

    def initialize_rag(self):
        self.status_label.config(text="インデックス読み込み中...", foreground="orange")
        self.query_button.config(state=tk.DISABLED)
        self.root.update()

        try:
            Settings.llm = OpenAI(model="gpt-4o-mini", temperature=0.1)
            Settings.embed_model = OpenAIEmbedding(model="text-embedding-3-large")

            if not STORAGE_DIR.exists():
                messagebox.showerror(
                    "エラー",
                    f"インデックスが見つかりません:\n{STORAGE_DIR}\n\n"
                    "先に 41_build_rxfp1_abstract_index.py を実行してください"
                )
                self.status_label.config(text="インデックスなし", foreground="red")
                return

            storage_context = StorageContext.from_defaults(persist_dir=str(STORAGE_DIR))
            self.index = load_index_from_storage(storage_context)

            # 出力ファイルを準備
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            device = socket.gethostname()
            self.output_file = OUTPUT_DIR / f"{timestamp}_rxfp1_abstract_{device}_gui.md"
            self.turn = 1

            self.status_label.config(text="準備完了: RXFP1 Abstract インデックス", foreground="green")
            self.query_button.config(state=tk.NORMAL)
            self.append_output("=== RXFP1 Abstract RAG 初期化完了 ===\n")
            self.append_output(f"インデックス: {STORAGE_DIR.name}/\n")
            self.append_output(f"出力ファイル: {self.output_file.name}\n\n")

        except Exception as e:
            messagebox.showerror("エラー", f"初期化に失敗:\n{e}")
            self.status_label.config(text="エラー", foreground="red")

    def _translate_to_english(self, text: str) -> str:
        client = OpenAIClient()
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{
                "role": "user",
                "content": f"Translate the following Japanese text to English. Return only the translation:\n\n{text}"
            }],
            temperature=0.1
        )
        return response.choices[0].message.content.strip()

    def send_query(self):
        if self.index is None:
            messagebox.showwarning("警告", "インデックスが読み込まれていません")
            return

        original_query = self.query_text.get("1.0", tk.END).strip()
        if not original_query:
            messagebox.showwarning("警告", "クエリを入力してください")
            return

        self.query_text.delete("1.0", tk.END)
        self.query_button.config(state=tk.DISABLED)
        self.root.update()

        try:
            # 常に英語に翻訳
            self.append_output(f"[翻訳中...]\n")
            self.root.update()
            query = self._translate_to_english(original_query)
            self.append_output(f"→ {query}\n\n")

            top_k = self.topk_var.get()
            query_engine = self.index.as_query_engine(
                similarity_top_k=top_k,
                response_mode="compact",
            )
            response = query_engine.query(query)

            # 出力
            output = f"[Turn {self.turn}] Q: {original_query}\n"
            output += f"(EN: {query})\n"
            output += f"\nA: {response.response}\n\n"

            output += "【引用元】\n"
            for i, node_with_score in enumerate(response.source_nodes, 1):
                node = node_with_score.node
                score = node_with_score.score
                meta = node.metadata
                citekey = meta.get("citekey", "?")
                title = meta.get("title", "")
                tags = meta.get("tags", "")
                mesh = meta.get("mesh_terms", "")
                abstract_preview = node.text[:120].replace("\n", " ")

                output += f"{i}. {citekey}  (score: {score:.4f})\n"
                if title:
                    output += f"   Title: {title[:80]}\n"
                if tags:
                    output += f"   Tags: {tags}\n"
                if mesh:
                    output += f"   MeSH: {mesh[:80]}\n"
                output += f"   {abstract_preview}...\n\n"

            output += "─" * 60 + "\n\n"
            self.append_output(output)

            self._save_to_file(original_query, query, response)
            self.turn += 1

        except Exception as e:
            messagebox.showerror("エラー", f"クエリ実行に失敗:\n{e}")

        finally:
            self.query_button.config(state=tk.NORMAL)
            self.query_text.focus_set()

    def _save_to_file(self, original_query, en_query, response):
        if not self.output_file:
            return

        with open(self.output_file, "a", encoding="utf-8") as f:
            if self.turn == 1:
                f.write(f"# RXFP1 Abstract RAG Dialogue (GUI)\n")
                f.write(f"Date: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n")

            f.write(f"## Q{self.turn}: {original_query}\n")
            f.write(f"*(EN: {en_query})*\n")
            f.write(f"\n**Answer**: {response.response}\n\n")

            f.write("**Sources**:\n\n")
            for i, node_with_score in enumerate(response.source_nodes, 1):
                node = node_with_score.node
                score = node_with_score.score
                meta = node.metadata
                f.write(f"Source {i}: {meta.get('citekey', '?')} (score: {score:.4f})\n")
                f.write(f"- Title: {meta.get('title', '')}\n")
                f.write(f"- DOI: {meta.get('doi', '')}\n")
                f.write(f"- Tags: {meta.get('tags', '')}\n")
                f.write(f"- MeSH: {meta.get('mesh_terms', '')}\n")
                f.write(f"\n{node.text}\n\n")

            f.write("---\n\n")

    def clear_output(self):
        self.output_text.config(state=tk.NORMAL)
        self.output_text.delete("1.0", tk.END)
        self.output_text.config(state=tk.DISABLED)

    def append_output(self, text):
        self.output_text.config(state=tk.NORMAL)
        self.output_text.insert(tk.END, text)
        self.output_text.see(tk.END)
        self.output_text.config(state=tk.DISABLED)


if __name__ == "__main__":
    root = tk.Tk()
    app = RxfpAbstractRAGGUI(root)
    root.mainloop()
