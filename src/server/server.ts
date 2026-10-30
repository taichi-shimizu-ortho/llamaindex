// Express API サーバ + 本番時は静的配信
import path from "node:path";
import fs from "node:fs";
import express from "express";
import { harvestReferences, listReferenceSets, loadReferenceSet } from "./referenceHarvester.js";
import { harvestArticle, listArticleSets, loadArticleSet } from "./articleHarvester.js";
import { prepareCorpus, runCorpusQuery, type CorpusQueryResult, type CorpusSource } from "./corpusRag.js";
import { assignDocument, createFolder, deleteFolder, moveFolder, readLibrary, renameFolder } from "./library.js";
import { syncZotero, zoteroStatus } from "./zotero.js";
import { MODELS, PATHS } from "./config.js";
import { modelLabel } from "../shared/modelLabel.js";

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
app.use(express.json({ limit: "128mb" }));

const PORT = Number(process.env.PORT ?? 5174);

// Article figure assets saved under the shared raw_html directory.
if (fs.existsSync(PATHS.rawHtmlDir)) {
  app.use("/raw_html", express.static(PATHS.rawHtmlDir));
}

// 状態確認
app.get("/api/status", (_req, res) => {
  res.json({
    // 回答生成は Anthropic、埋め込みと翻訳は OpenAI なので両方の鍵が要る。
    hasApiKey: Boolean(process.env.OPENAI_API_KEY && process.env.ANTHROPIC_API_KEY),
    missingKeys: [
      process.env.OPENAI_API_KEY ? "" : "OPENAI_API_KEY",
      process.env.ANTHROPIC_API_KEY ? "" : "ANTHROPIC_API_KEY",
    ].filter(Boolean),
    llmModel: MODELS.llm,
    llmLabel: modelLabel(MODELS.llm),
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

function errorText(e: unknown): string {
  return String((e as any)?.message ?? e);
}

function articleSummary(article: Awaited<ReturnType<typeof harvestArticle>>) {
  return {
    id: article.id,
    title: article.title,
    sourceUrl: article.sourceUrl,
    chunkCount: article.chunkCount,
    extractionSource: article.extractionSource,
    createdAt: article.createdAt,
  };
}

function referenceSummary(ref: Awaited<ReturnType<typeof harvestReferences>>) {
  return {
    id: ref.id,
    title: ref.title,
    sourceUrl: ref.sourceUrl,
    totalReferences: ref.totalReferences,
    pubmedFound: ref.pubmedFound,
    abstractFound: ref.abstractFound,
    extractionSource: ref.extractionSource,
    createdAt: ref.createdAt,
  };
}

app.post("/api/import/ors", async (req, res) => {
  const { sourceUrl, html, title, limit, jatsXml } = req.body ?? {};
  if (!sourceUrl && !html) return res.status(400).json({ error: "Enter a URL or HTML" });

  const result: {
    ok: boolean;
    article?: ReturnType<typeof articleSummary>;
    reference?: ReturnType<typeof referenceSummary>;
    articleError?: string;
    referenceError?: string;
  } = { ok: false };

  try {
    result.article = articleSummary(await harvestArticle({ sourceUrl, html, title, jatsXml }));
  } catch (e) {
    result.articleError = errorText(e);
  }

  try {
    result.reference = referenceSummary(await harvestReferences({ sourceUrl, html, title, limit, jatsXml }));
  } catch (e) {
    result.referenceError = errorText(e);
  }

  // Save XML if present and article/reference extraction succeeded (or even if it failed partially)
  const id = result.article?.id || result.reference?.id;
  if (id && jatsXml) {
    const xmlPath = path.join(PATHS.rawHtmlDir, `${id}.source.xml`);
    fs.mkdirSync(PATHS.rawHtmlDir, { recursive: true });
    fs.writeFileSync(xmlPath, jatsXml, "utf-8");
  }

  result.ok = Boolean(result.article || result.reference);
  if (!result.ok) {
    return res.status(500).json({
      ...result,
      error: [result.articleError, result.referenceError].filter(Boolean).join(" / ") || "Import failed",
    });
  }
  res.json(result);
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

// ---- 複数論文 RAG（corpus） ----
// prepare は埋め込みを先に用意するだけ（初回の検索待ちを減らす）。
app.post("/api/corpus/prepare", async (req, res) => {
  try {
    res.json(await prepareCorpus(req.body?.articleIds));
  } catch (e: any) {
    console.error(e);
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

app.post("/api/corpus/query", async (req, res) => {
  const { articleIds, query, topK, perPaper, sectionGroups, translate } = req.body ?? {};
  if (!query) return res.status(400).json({ error: "Enter a question" });
  try {
    res.json(await runCorpusQuery(articleIds, String(query).trim(), { topK, perPaper, sectionGroups, translate }));
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// ---- ドキュメント選択画面のフォルダ管理 ----
// 更新系はすべて新しいライブラリ全体を返すので、クライアントは差分計算をしなくてよい。
function libraryRoute(handler: (body: any) => ReturnType<typeof readLibrary>) {
  return (req: express.Request, res: express.Response) => {
    try {
      res.json({ library: handler(req.body ?? {}) });
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  };
}

app.get("/api/library", (_req, res) => {
  try {
    res.json({ library: readLibrary() });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.post("/api/library/folders/create", libraryRoute((body) => createFolder(body.name, body.parentId)));
app.post("/api/library/folders/rename", libraryRoute((body) => renameFolder(body.id, body.name)));
app.post("/api/library/folders/move", libraryRoute((body) => moveFolder(body.id, body.parentId)));
app.post("/api/library/folders/delete", libraryRoute((body) => deleteFolder(body.id)));
app.post("/api/library/assign", libraryRoute((body) => assignDocument(body.documentId, body.folderId)));

// ---- Zotero ローカルAPI 連携 ----
// dryRun=true なら library.json を書かず、同期したらどうなるかだけ返す。
app.get("/api/zotero/status", async (_req, res) => {
  try {
    res.json(await zoteroStatus());
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.post("/api/zotero/sync", async (req, res) => {
  try {
    res.json(await syncZotero({ dryRun: Boolean(req.body?.dryRun) }));
  } catch (e: any) {
    console.error(e);
    res.status(502).json({ error: String(e?.message ?? e) });
  }
});

function safeSessionId(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  const id = raw.replace(/[^0-9A-Za-z_.-]/g, "");
  return /^\d{6}_\d{6}/.test(id) ? id : new Date().toISOString().slice(2, 19).replace(/[-:T]/g, "");
}

function sourceMarkdown(source: CorpusSource): string {
  const section = source.subsection ? `${source.section} > ${source.subsection}` : source.section;
  const cite = [source.journal, source.year].filter(Boolean).join(" · ");
  const links = [
    source.doi ? `[DOI](https://doi.org/${source.doi})` : "",
    source.sourceUrl ? `[Source](${source.sourceUrl})` : "",
  ].filter(Boolean).join(" ");
  return [
    `#### S${source.n}. ${source.label} — ${section}${source.cited ? " (cited)" : ""}`,
    `- Score: ${source.score.toFixed(4)} · Paragraph ${source.paragraphIndex}/${source.totalParagraphs} · ${source.sectionGroup}`,
    source.title ? `- Title: ${source.title}` : "",
    cite ? `- Journal: ${cite}` : "",
    links ? `- Links: ${links}` : "",
    "",
    source.text,
  ].filter((line) => line !== "").join("\n");
}

function resultMarkdown(result: CorpusQueryResult): string {
  const parts = ["---", "", `## Q: ${result.originalQuery}`];
  if (result.enQuery && result.enQuery !== result.originalQuery) parts.push("", `*EN: ${result.enQuery}*`);
  if (result.model) {
    const ids = String(result.model).split(/,\s*/);
    parts.push("", `*Model: ${ids.map((id) => `${modelLabel(id)} (${id})`).join(", ")}*`);
  }
  const settings = [
    `Top-K ${result.topK}`,
    result.perPaper ? `max ${result.perPaper}/paper` : "",
    result.sectionGroups?.length ? `sections: ${result.sectionGroups.join(", ")}` : "",
  ].filter(Boolean).join(" · ");
  parts.push("", `*Papers (${result.papers.length}): ${result.papers.map((p) => p.label).join(", ")} — ${settings}*`);
  parts.push("", "### Answer", "", result.answer || "");
  if (result.sources.length) {
    parts.push("", `### Sources (${result.sources.length})`, "", result.sources.map(sourceMarkdown).join("\n\n"));
  }
  parts.push("");
  return parts.join("\n");
}

// 1回の画面セッション（タブ）ごとに 1つの md へ追記する。論文の組み合わせは各回の見出しに残す。
app.post("/api/session/save", (req, res) => {
  const { sessionId, result } = req.body ?? {};
  if (!result) return res.status(400).json({ error: "No search result to save" });
  try {
    fs.mkdirSync(PATHS.outputDir, { recursive: true });
    const id = safeSessionId(sessionId);
    const file = path.join(PATHS.outputDir, `${id}_corpus_rag.md`);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, `# Corpus RAG Session\n\n- Session: ${id}\n\n`, "utf-8");
    }
    fs.appendFileSync(file, resultMarkdown(result), "utf-8");
    res.json({ ok: true, file });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});


// 図の画像など raw_html 配下のファイルを配信（<img src="/raw_html/..."> 用）
app.use("/raw_html", express.static(PATHS.rawHtmlDir));

// 本番: ビルド済みクライアントを配信
const clientDist = path.resolve(import.meta.dirname, "../../dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
}

app.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}`);
  const missing = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"].filter((key) => !process.env[key]);
  console.log(`[server] answer model: ${modelLabel(MODELS.llm)} (${MODELS.llm})`);
  console.log(`[server] api ready: ${missing.length ? `missing ${missing.join(", ")}` : "with OPENAI_API_KEY and ANTHROPIC_API_KEY"}`);
});
