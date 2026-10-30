// 表示用のモデル名。サーバ（保存する md）とクライアント（画面）で共有する。
const LABELS: Record<string, string> = {
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-opus-4-8": "Claude Opus 4.8",
};

export function modelLabel(id: string): string {
  return LABELS[id] ?? id;
}
