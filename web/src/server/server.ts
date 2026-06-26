// Express API サーバ + 本番時は静的配信
import path from "node:path";
import fs from "node:fs";
import express from "express";
import { harvestReferences, listReferenceSets, loadReferenceSet } from "./referenceHarvester.js";
import { runReferenceQuery } from "./referenceRag.js";
import { harvestArticle, listArticleSets, loadArticleSet } from "./articleHarvester.js";
import { runArticleQuery } from "./articleRag.js";
import { runIntegratedQuery } from "./integratedRag.js";

const app = express();
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "32mb" }));

const PORT = Number(process.env.PORT ?? 5174);

// 状態確認
app.get("/api/status", (_req, res) => {
  res.json({
    hasApiKey: Boolean(process.env.OPENAI_API_KEY),
  });
});

app.get("/api/reference/sets", (_req, res) => {
  try {
    res.json({ sets: listReferenceSets() });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.get("/api/reference/sets/:id", (req, res) => {
  try {
    res.json(loadReferenceSet(req.params.id));
  } catch (e: any) {
    res.status(404).json({ error: String(e?.message ?? e) });
  }
});

app.post("/api/reference/harvest", async (req, res) => {
  const { sourceUrl, html, title, limit } = req.body ?? {};
  try {
    const result = await harvestReferences({ sourceUrl, html, title, limit });
    res.json(result);
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.post("/api/reference/query", async (req, res) => {
  const { setId, query, topK, translate } = req.body ?? {};
  if (!setId || !query) return res.status(400).json({ error: "データセットとクエリを指定してください" });
  try {
    const result = await runReferenceQuery(String(setId), String(query).trim(), { topK, translate });
    res.json(result);
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.get("/api/article/sets", (_req, res) => {
  try {
    res.json({ sets: listArticleSets() });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.get("/api/article/sets/:id", (req, res) => {
  try {
    res.json(loadArticleSet(req.params.id));
  } catch (e: any) {
    res.status(404).json({ error: String(e?.message ?? e) });
  }
});

app.post("/api/article/harvest", async (req, res) => {
  const { sourceUrl, html, title } = req.body ?? {};
  try {
    const result = await harvestArticle({ sourceUrl, html, title });
    res.json(result);
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.post("/api/article/query", async (req, res) => {
  const { articleId, query, topK, translate } = req.body ?? {};
  if (!articleId || !query) return res.status(400).json({ error: "主論文JSONとクエリを指定してください" });
  try {
    const result = await runArticleQuery(String(articleId), String(query).trim(), { topK, translate });
    res.json(result);
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.post("/api/integrated/query", async (req, res) => {
  const { articleId, referenceSetId, query, topK, translate } = req.body ?? {};
  if (!articleId || !referenceSetId || !query) {
    return res.status(400).json({ error: "主論文JSON、reference set、クエリを指定してください" });
  }
  try {
    const result = await runIntegratedQuery(String(articleId), String(referenceSetId), String(query).trim(), { topK, translate });
    res.json(result);
  } catch (e: any) {
    console.error(e);
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
  console.log(`[server] api ready: ${Boolean(process.env.OPENAI_API_KEY) ? "with OPENAI_API_KEY" : "missing OPENAI_API_KEY"}`);
});
