# Master GUI: 30 (JSON再生成) → 40 (インデックス再構築) → 52 (検索GUI) をワンクリック実行
import os
import sys
import queue
import threading
import subprocess
import tkinter as tk
from pathlib import Path
from tkinter import ttk, scrolledtext, messagebox

FONT_SIZE = 12
DEFAULT_FONT = ("Segoe UI", FONT_SIZE)
MONO_FONT = ("Consolas", FONT_SIZE)

SCRIPT_DIR = Path(__file__).resolve().parent
PYTHON = sys.executable

STEP_30 = "30_batch_convert_articles.py"
STEP_40 = "40_build_all_articles_index.py"
STEP_52 = "52_gui_rxfp1.py"


class MasterGUI:
    def __init__(self, root):
        self.root = root
        self.root.title("RXFP1 パイプライン マスター (30 → 40 → 52)")
        self.root.geometry("900x640")

        self.worker = None
        self.log_queue: queue.Queue[str] = queue.Queue()

        self.run30_var = tk.BooleanVar(value=True)
        self.run40_var = tk.BooleanVar(value=True)
        self.run52_var = tk.BooleanVar(value=True)

        self.setup_ui()
        self.root.after(100, self._drain_log)

    def setup_ui(self):
        # 上部: ステップ選択
        top = ttk.Frame(self.root, padding="10")
        top.pack(fill=tk.X)

        tk.Label(top, text="実行ステップ:", font=DEFAULT_FONT).pack(side=tk.LEFT, padx=(0, 8))
        tk.Checkbutton(top, text="30 JSON再生成", variable=self.run30_var, font=DEFAULT_FONT).pack(side=tk.LEFT, padx=4)
        tk.Checkbutton(top, text="40 インデックス再構築", variable=self.run40_var, font=DEFAULT_FONT).pack(side=tk.LEFT, padx=4)
        tk.Checkbutton(top, text="52 検索GUI起動", variable=self.run52_var, font=DEFAULT_FONT).pack(side=tk.LEFT, padx=4)

        # 実行ボタン
        btn_frame = ttk.Frame(self.root, padding=(10, 0))
        btn_frame.pack(fill=tk.X)

        self.run_button = tk.Button(
            btn_frame, text="▶ 一括実行 (30 → 40 → 52)",
            command=self.run_all, font=DEFAULT_FONT, height=2
        )
        self.run_button.pack(side=tk.LEFT, padx=5, pady=5)

        self.clear_button = tk.Button(btn_frame, text="ログクリア", command=self.clear_log, font=DEFAULT_FONT)
        self.clear_button.pack(side=tk.LEFT, padx=5)

        self.status_label = tk.Label(btn_frame, text="待機中", foreground="gray", font=DEFAULT_FONT)
        self.status_label.pack(side=tk.LEFT, padx=15)

        # ログ表示
        log_frame = tk.LabelFrame(self.root, text="実行ログ", padx=10, pady=10, font=DEFAULT_FONT)
        log_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)

        self.log_text = scrolledtext.ScrolledText(
            log_frame, state=tk.DISABLED, font=MONO_FONT, wrap=tk.WORD
        )
        self.log_text.pack(fill=tk.BOTH, expand=True)

    # ---- ログ処理（スレッド安全） ----
    def log(self, text: str):
        self.log_queue.put(text)

    def _drain_log(self):
        while not self.log_queue.empty():
            line = self.log_queue.get_nowait()
            self.log_text.config(state=tk.NORMAL)
            self.log_text.insert(tk.END, line)
            self.log_text.see(tk.END)
            self.log_text.config(state=tk.DISABLED)
        self.root.after(100, self._drain_log)

    def clear_log(self):
        self.log_text.config(state=tk.NORMAL)
        self.log_text.delete("1.0", tk.END)
        self.log_text.config(state=tk.DISABLED)

    # ---- 実行制御 ----
    def run_all(self):
        if self.worker and self.worker.is_alive():
            messagebox.showwarning("実行中", "現在処理が実行中です。完了までお待ちください。")
            return

        if not (self.run30_var.get() or self.run40_var.get() or self.run52_var.get()):
            messagebox.showwarning("警告", "実行するステップを1つ以上選択してください。")
            return

        if self.run40_var.get():
            ok = messagebox.askyesno(
                "確認",
                "40 は既存の storage_all インデックスを上書き再構築します。\n"
                "再embeddingのため時間とAPIコストがかかります。\n\n続行しますか？"
            )
            if not ok:
                return

        self.run_button.config(state=tk.DISABLED)
        self.status_label.config(text="実行中...", foreground="orange")
        self.worker = threading.Thread(target=self._run_sequence, daemon=True)
        self.worker.start()

    def _run_sequence(self):
        try:
            if self.run30_var.get():
                if self._run_script(STEP_30) != 0:
                    self._finish("30 が失敗したため中断しました", "red")
                    return

            if self.run40_var.get():
                # 40 は既存インデックスがあると上書き確認 input() を出すため "y" を自動投入
                if self._run_script(STEP_40, stdin_input="y\n") != 0:
                    self._finish("40 が失敗したため中断しました", "red")
                    return

            if self.run52_var.get():
                self._launch_gui()

            self._finish("完了しました", "green")
        except Exception as e:
            self.log(f"\n[!] 予期しないエラー: {e}\n")
            self._finish("エラーが発生しました", "red")

    def _run_script(self, script: str, stdin_input: str | None = None) -> int:
        self.log(f"\n{'=' * 60}\n=== {script} 開始 ===\n{'=' * 60}\n")

        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"

        proc = subprocess.Popen(
            [PYTHON, "-u", script],
            cwd=str(SCRIPT_DIR),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env=env,
        )

        # 入力（上書き確認など）を先に渡してEOFを通知
        try:
            if stdin_input is not None:
                proc.stdin.write(stdin_input)
                proc.stdin.flush()
            proc.stdin.close()
        except Exception:
            pass

        for line in proc.stdout:
            self.log(line)

        proc.wait()
        self.log(f"\n=== {script} 終了 (exit={proc.returncode}) ===\n")
        return proc.returncode

    def _launch_gui(self):
        self.log(f"\n=== {STEP_52} を起動します（別ウィンドウ） ===\n")
        subprocess.Popen([PYTHON, STEP_52], cwd=str(SCRIPT_DIR))

    def _finish(self, message: str, color: str):
        self.log(f"\n[{message}]\n")
        # UI更新はメインスレッドで
        self.root.after(0, lambda: self._on_done(message, color))

    def _on_done(self, message: str, color: str):
        self.status_label.config(text=message, foreground=color)
        self.run_button.config(state=tk.NORMAL)


if __name__ == "__main__":
    root = tk.Tk()
    app = MasterGUI(root)
    root.mainloop()
