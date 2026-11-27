// Express API サーバ + 本番時は静的配信
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import express from "express";
import { harvestReferences, listReferenceSets, loadReferenceSet } from "./referenceHarvester.js";
import { harvestArticle, listArticleSets, loadArticleSet, resolveArticleId, type ArticleSet } from "./articleHarvester.js";
import { classifyArticle, classifyUncheckedArticles } from "./articleClassifier.js";
import { prepareCorpus, runCorpusQuery, type CorpusQueryResult, type CorpusSource } from "./corpusRag.js";
import { assignDocument, createFolder, deleteFolder, moveFolder, readLibrary, renameFolder } from "./library.js";
import { syncZotero, zoteroStatus } from "./zotero.js";
import { MODELS, PATHS } from "./config.js";
import { modelLabel } from "../shared/modelLabel.js";
import { listRxfp1Articles } from "./rxfp1Corpus.js";
import { readManuscript } from "./manuscriptDocx.js";
import { parseReviewRequest, ReviewInputError, runManuscriptReview } from "./manuscriptReview.js";

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

// 取り込んだ主論文を PubMed で Original / Review に分類する。
// 失敗しても取り込みは成功扱いにする（未確認のまま残り、次のサーバ起動で再試行される）。
async function withArticleType(set: ArticleSet): Promise<ArticleSet> {
  try {
    return await classifyArticle(set.id);
  } catch (e) {
    console.warn(`[classify] ${set.id}: ${errorText(e)}`);
    return set;
  }
}

function articleSummary(article: ArticleSet) {
  return {
    id: article.id,
    title: article.title,
    authors: article.authors,
    year: article.year,
    sourceUrl: article.sourceUrl,
    articleType: article.articleType ?? null,
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
    result.article = articleSummary(await withArticleType(await harvestArticle({ sourceUrl, html, title, jatsXml })));
  } catch (e) {
    result.articleError = errorText(e);
  }

  try {
    result.reference = referenceSummary(await harvestReferences({ sourceUrl, html, title, limit, jatsXml, articleId: result.article?.id }));
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

app.get("/api/rxfp1/articles", (_req, res) => {
  res.json({ sets: listRxfp1Articles() });
});

app.get("/api/article/sets/:id", (req, res) => {
  try {
    res.json(loadArticleSet(resolveArticleId(req.params.id)));
  } catch (e: any) {
    res.status(404).json({ error: String(e?.message ?? e) });
  }
});

app.post("/api/article/harvest", async (req, res) => {
  const { sourceUrl, html, title } = req.body ?? {};
  try {
    const result = await withArticleType(await harvestArticle({ sourceUrl, html, title }));
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
  const { articleIds, scopeLabel, query, topK, perPaper, articleTypes, sectionGroups, translate } = req.body ?? {};
  if (!query) return res.status(400).json({ error: "Enter a question" });
  try {
    res.json(
      await runCorpusQuery(articleIds, String(query).trim(), {
        topK,
        perPaper,
        articleTypes,
        sectionGroups,
        translate,
        scopeLabel,
      }),
    );
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.post("/api/manuscript/read", express.raw({ type: "application/octet-stream", limit: "12mb" }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Choose a .docx file." });
  try {
    res.json(await readManuscript(req.body));
  } catch (error) {
    res.status(400).json({ error: errorText(error) });
  }
});

app.post("/api/manuscript/review", async (req, res) => {
  try {
    res.json(await runManuscriptReview(parseReviewRequest(req.body)));
  } catch (error) {
    res.status(error instanceof ReviewInputError ? 400 : 502).json({ error: errorText(error) });
  }
});

app.post("/api/manuscript/save", (req, res) => {
  const markdown = req.body?.markdown;
  if (typeof markdown !== "string" || !markdown.trim() || markdown.length > 4_000_000) {
    return res.status(400).json({ error: "No valid Markdown report to save." });
  }
  try {
    fs.mkdirSync(PATHS.manuscriptReviewDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const file = path.join(PATHS.manuscriptReviewDir, `${date}_manuscript_review_${randomUUID()}.md`);
    fs.writeFileSync(file, markdown, { encoding: "utf8", flag: "wx" });
    res.json({ file });
  } catch (error) {
    res.status(500).json({ error: errorText(error) });
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

// フォルダ（Zotero コレクション）の最上位名を文献セット名として解決する。
// - Scope が "Folder: MSC-OXT (with subfolders)" や "Folder: MSC-OXT / Reference" なら最上位の "MSC-OXT"
// - 手動選択（"Custom selection"）でも、選んだ論文の半数以上が同じ最上位フォルダに属していればそのフォルダ名にする
function resolveLiteratureSetName(result: CorpusQueryResult): string {
  const scope = (result.scopeLabel ?? "").trim();
  if (scope.startsWith("Folder:")) {
    const folderPath = scope
      .replace(/^Folder:\s*/, "")
      .replace(/\s*\(with subfolders\)\s*$/, "")
      .trim();
    const rootName = folderPath.split(/\s*\/\s*/)[0]?.trim();
    if (rootName) return rootName;
  }

  const library = readLibrary();
  const byId = new Map(library.folders.map((f) => [f.id, f]));
  function rootFolderName(folderId: string): string | null {
    let cur = byId.get(folderId);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (!cur.parentId || !byId.has(cur.parentId)) return cur.name;
      cur = byId.get(cur.parentId);
    }
    return null;
  }

  const counts = new Map<string, number>();
  for (const paper of result.papers ?? []) {
    const folderIds = new Set<string>(library.zoteroFolders?.[paper.id] ?? []);
    const primary = library.assignments[paper.id];
    if (primary) folderIds.add(primary);
    const roots = new Set<string>();
    for (const fid of folderIds) {
      const root = rootFolderName(fid);
      if (root) roots.add(root);
    }
    for (const root of roots) {
      counts.set(root, (counts.get(root) ?? 0) + 1);
    }
  }

  let bestName = "";
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      bestName = name;
      bestCount = count;
    }
  }
  if (bestName && bestCount >= Math.ceil((result.papers?.length ?? 1) / 2)) {
    return bestName;
  }

  return "Custom";
}

function safeFileStem(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "Custom";
}

function formatTimestamp(d = new Date()): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
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
    `- ${source.ranking === "legacy_vector" ? "RXFP1 vector" : source.ranking === "text_match" ? "Text match" : `Score: ${source.score.toFixed(4)}`} · Paragraph ${source.paragraphIndex}/${source.totalParagraphs} · ${source.sectionGroup}`,
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
  parts.push("", `*Date: ${formatTimestamp()}*`);
  if (result.model) {
    const ids = String(result.model).split(/,\s*/);
    parts.push("", `*Model: ${ids.map((id) => `${modelLabel(id)} (${id})`).join(", ")}*`);
  }
  const settings = [
    `Top-K ${result.topK}`,
    result.perPaper ? `max ${result.perPaper}/paper` : "",
    result.articleTypes?.length ? `articles: ${result.articleTypes.join(", ")}` : "",
    result.sectionGroups?.length ? `sections: ${result.sectionGroups.join(", ")}` : "",
  ].filter(Boolean).join(" · ");
  if (result.scopeLabel) parts.push("", `*Scope: ${result.scopeLabel}*`);
  for (const note of result.searchNotes ?? []) parts.push("", note);
  parts.push("", `*Papers (${result.papers.length}): ${result.papers.map((p) => p.label).join(", ")} — ${settings}*`);
  parts.push("", "### Answer", "", result.answer || "");
  if (result.sources.length) {
    parts.push("", `### Sources (${result.sources.length})`, "", result.sources.map(sourceMarkdown).join("\n\n"));
  }
  parts.push("");
  return parts.join("\n");
}

// 文献セット（MSC-OXT などのフォルダ単位）ごとに 1つの md へ Q&A を追記する。
app.post("/api/session/save", (req, res) => {
  const { result } = req.body ?? {};
  if (!result) return res.status(400).json({ error: "No search result to save" });
  try {
    fs.mkdirSync(PATHS.outputDir, { recursive: true });
    const setName = resolveLiteratureSetName(result);
    const stem = safeFileStem(setName);
    const file = path.join(PATHS.outputDir, `${stem}_corpus_rag.md`);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, `# Corpus RAG: ${setName}\n\n`, "utf-8");
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
  // 分類前に取り込んだ論文を、起動のたびに裏で分類しておく（済んだものは飛ばす）。
  classifyUncheckedArticles().catch((e) => console.warn(`[classify] ${errorText(e)}`));
});
