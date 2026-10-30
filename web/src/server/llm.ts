// 回答生成の LLM 呼び出し（Claude）。article / reference の両 RAG で共有する。
// 埋め込みと JA→EN 翻訳は OpenAI のまま（config.ts の MODELS.embed / MODELS.translate）。
import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "./config.js";

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  // ANTHROPIC_API_KEY を環境変数（.env）から読む。
  if (!client) client = new Anthropic();
  return client;
}

export interface LlmAnswer {
  text: string;
  // 実際に回答したモデル。拒否時のフォールバックが走ると MODELS.llm と変わる。
  model: string;
}

export async function generateAnswer(system: string, user: string): Promise<LlmAnswer> {
  const res = await anthropic().beta.messages.create({
    model: MODELS.llm,
    max_tokens: 16000,
    output_config: { effort: "high" },
    // 安全分類器に断られたら、サーバ側で推奨の代替モデルに回す。
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    messages: [{ role: "user", content: user }],
  });
  if (res.stop_reason === "refusal") {
    const category = res.stop_details?.category ?? "unknown";
    throw new Error(`${res.model} declined to answer (refusal: ${category})`);
  }
  const text = res.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
  return { text, model: res.model };
}
