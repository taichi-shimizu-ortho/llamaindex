import os

def generate_ps_link_command():
    print("=== PowerShell用 .venvリンク作成ツール ===")
    
    # 実体: C:\Users\a2189\uv envs\in_situ\.venv
    source = input("1. 実体(.venv)のパスを入力: ").strip().strip('"').strip("'")
    
    # プロジェクトフォルダ: C:\Users\a2189\OneDrive\デスクトップ\in situ hybridization\ISH_palette
    project_dir = input("2. プロジェクトフォルダのパスを入力: ").strip().strip('"').strip("'")

    if not source or not project_dir:
        return

    # リンクの作成先を「プロジェクトフォルダ\.venv」に固定する
    link_full_path = os.path.join(project_dir, ".venv")
    
    print("\n--- 以下のコマンドをコピーしてPowerShell(管理者)で実行 ---")
    print(f"cd \"{project_dir}\"")
    print(f"if (Test-Path \".venv\") {{ Remove-Item \".venv\" -Force -Recurse }}")
    print(f"New-Item -ItemType SymbolicLink -Path \".venv\" -Target \"{source}\"")
    print("----------------------------------------------------------")

if __name__ == "__main__":
    generate_ps_link_command()