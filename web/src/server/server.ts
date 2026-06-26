// Express API サーバ + 本番時は静的配信
import path from "node:path";
import fs from "node:fs";
import express from "express";
import { harvestReferences, listReferenceSets, loadReferenceSet } from "./referenceHarvester.js";
import { runReferenceQuery } from "./referenceRag.js";
import { harvestArticle, listArticleSets, loadArticleSet } from "./articleHarvester.js";
import { runArticleQuery } from "./articleRag.js";
import { runIntegratedQuery } from "./integratedRag.js";
import { PATHS } from "./config.js";

const app = express();
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network");
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

function safeSessionId(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  const id = raw.replace(/[^0-9A-Za-z_.-]/g, "");
  return /^\d{6}_\d{6}/.test(id) ? id : new Date().toISOString().slice(2, 19).replace(/[-:T]/g, "");
}

function sourceMarkdown(source: any, index: number): string {
  const scope = source.scope === "reference_abstract" ? "Reference Abstract" : source.scope === "main_article" ? "Main Article" : "Source";
  const heading = source.label || source.section || source.title || `Source ${index}`;
  const cite = [source.journal, source.year || source.published].filter(Boolean).join(" · ");
  const links = [
    source.pmid ? `[PubMed](https://pubmed.ncbi.nlm.nih.gov/${source.pmid})` : "",
    source.doi ? `[DOI](https://doi.org/${source.doi})` : "",
  ].filter(Boolean).join(" ");
  return [
    `#### ${index}. ${scope}: ${heading}`,
    source.score != null ? `- Score: ${Number(source.score).toFixed(4)}` : "",
    source.title ? `- Title: ${source.title}` : "",
    cite ? `- Journal: ${cite}` : "",
    source.authors ? `- Authors: ${source.authors}` : "",
    links ? `- Links: ${links}` : "",
    "",
    source.text || source.abstract || "",
  ].filter((line) => line !== "").join("\n");
}

function resultMarkdown(result: any): string {
  const parts = [
    "---",
    "",
    `## Q: ${result.originalQuery || result.original_query || ""}`,
  ];
  if (result.enQuery && result.enQuery !== result.originalQuery) {
    parts.push("", `*EN: ${result.enQuery}*`);
  }

  if ("articleAnswer" in result) {
    parts.push("", "### Main Article", "", result.articleAnswer || "", "", "### Reference Abstracts", "", result.referenceAnswer || "");
  } else {
    parts.push("", "### Answer", "", result.answer || "");
  }

  const sources = Array.isArray(result.sources) ? result.sources : [];
  if (sources.length) {
    parts.push("", "### Sources", "", sources.map((source: any, i: number) => sourceMarkdown(source, i + 1)).join("\n\n"));
  }
  parts.push("");
  return parts.join("\n");
}

app.post("/api/session/save", (req, res) => {
  const { sessionId, result } = req.body ?? {};
  if (!result) return res.status(400).json({ error: "保存する検索結果がありません" });
  try {
    fs.mkdirSync(PATHS.outputDir, { recursive: true });
    const id = safeSessionId(sessionId);
    const file = path.join(PATHS.outputDir, `${id}_rag.md`);
    if (!fs.existsSync(file)) {
      const title = result.articleId || result.referenceSetId || result.setId || "RAG session";
      fs.writeFileSync(file, `# RAG Session\n\n- Session: ${id}\n- Target: ${title}\n\n`, "utf-8");
    }
    fs.appendFileSync(file, resultMarkdown(result), "utf-8");
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
  console.log(`[server] api ready: ${Boolean(process.env.OPENAI_API_KEY) ? "with OPENAI_API_KEY" : "missing OPENAI_API_KEY"}`);
});
