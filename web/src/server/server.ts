// Express API サーバ + 本番時は静的配信
import path from "node:path";
import fs from "node:fs";
import express from "express";
import { runQuery, reloadIndex, indexExists } from "./rag.js";
import { PATHS } from "./config.js";
import type { QueryResult } from "../shared/types.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT ?? 5174);

// 状態確認
app.get("/api/status", (_req, res) => {
  res.json({
    indexReady: indexExists(),
    storageDir: PATHS.storageAll,
    hasApiKey: Boolean(process.env.OPENAI_API_KEY),
  });
});

// 検索
app.post("/api/query", async (req, res) => {
  const { query, topK, translate } = req.body ?? {};
  if (!query || typeof query !== "string" || !query.trim()) {
    return res.status(400).json({ error: "クエリを入力してください" });
  }
  try {
    const result = await runQuery(query.trim(), { topK, translate });
    res.json(result);
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// インデックス再読み込み
app.post("/api/reload", async (_req, res) => {
  try {
    await reloadIndex();
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// 対話ログを Markdown に保存（Python版 _save_to_file 相当）
app.post("/api/save", (req, res) => {
  const result = req.body as QueryResult;
  if (!result?.original_query) return res.status(400).json({ error: "保存データが不正です" });
  try {
    const ts = new Date();
    const stamp = ts.toISOString().slice(0, 19).replace(/[:T]/g, "").replace(/-/g, "");
    const file = path.join(PATHS.outputDir, `${stamp}_rxfp1_web.md`);
    let md = `# RXFP1 RAG Dialogue (Web)\nDate: ${ts.toLocaleString()}\n\n`;
    md += `## Q: ${result.original_query}\n*(EN: ${result.en_query})*\n\n`;
    md += `**Answer**: ${result.answer}\n\n**Sources**:\n\n`;
    result.sources.forEach((s, i) => {
      md += `Source ${i + 1}: [${s.source}] ${s.citekey} (score: ${s.score.toFixed(4)})\n`;
      md += `- Title: ${s.title}\n`;
      const cite = [s.journal, s.published, s.volume && `${s.volume}${s.issue ? `(${s.issue})` : ""}`]
        .filter(Boolean)
        .join(", ");
      if (cite) md += `- Journal: ${cite}\n`;
      const sec = s.subsection ? `${s.section} > ${s.subsection}` : s.section;
      md += `- Section: ${sec} (paragraph ${s.paragraph_index}/${s.total_paragraphs})\n`;
      md += `- DOI: ${s.doi}\n- MeSH: ${s.mesh_terms}\n\n${s.text}\n\n`;
    });
    md += "---\n\n";
    fs.writeFileSync(file, md, "utf-8");
    res.json({ ok: true, file });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// 本番: ビルド済みクライアントを配信
const clientDist = path.resolve(import.meta.dirname, "../../dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
}

app.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}`);
  console.log(`[server] index ready: ${indexExists()}`);
});
