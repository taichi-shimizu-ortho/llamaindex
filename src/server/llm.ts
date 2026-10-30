// LLM 呼び出し。回答生成は Claude、JA→EN 翻訳は OpenAI（config.ts の MODELS.llm / MODELS.translate）。
import Anthropic from "@anthropic-ai/sdk";
import OpenAIClient from "openai";
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

export function hasJapanese(s: string): boolean {
  return /[぀-ヿ㐀-鿿]/.test(s);
}

// 検索クエリの JA→EN 翻訳（OpenAI）。索引の本文が英語なので、埋め込みは英語クエリで引く。
export async function translateToEnglish(text: string): Promise<string> {
  const client = new OpenAIClient();
  const res = await (client as any).responses.create({
    model: MODELS.translate,
    reasoning: { effort: "low" },
    input: `Translate the following Japanese text to English. Return only the translation:\n\n${text}`,
  });
  return res.output_text?.trim() ?? text;
}
