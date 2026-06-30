import { Document, Settings, VectorStoreIndex } from "llamaindex";
import { OpenAI, OpenAIEmbedding } from "@llamaindex/openai";
import OpenAIClient from "openai";
import { MODELS } from "./config.js";
import { loadArticleSet, type ArticleSet } from "./articleHarvester.js";

interface CachedArticleIndex {
  set: ArticleSet;
  index: VectorStoreIndex;
}

const cache = new Map<string, Promise<CachedArticleIndex>>();

function ensureSettings() {
  Settings.llm = new OpenAI({ model: MODELS.llm, temperature: 0.1 });
  Settings.embedModel = new OpenAIEmbedding({ model: MODELS.embed });
}

function hasJapanese(s: string): boolean {
  return /[぀-ヿ㐀-鿿]/.test(s);
}

export async function translateToEnglish(text: string): Promise<string> {
  const client = new OpenAIClient();
  const res = await client.chat.completions.create({
    model: MODELS.translate,
    temperature: 0.1,
    messages: [
      {
        role: "user",
        content: `Translate the following Japanese text to English. Return only the translation:\n\n${text}`,
      },
    ],
  });
  return res.choices[0].message.content?.trim() ?? text;
}

function cleanText(text: string): string {
  return text
    .replace(/\[[^\]]*\]\(https?:\/\/[^\)]+\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function documentsFromArticle(set: ArticleSet): Document[] {
  const docs: Document[] = [];
  const base = {
    article_id: set.id,
    title: set.title,
    authors: set.authors.join(", "),
    journal: set.journal,
    year: set.year,
    doi: set.doi,
    source_url: set.sourceUrl,
  };

  for (const section of set.sections) {
    const sectionBase = {
      ...base,
      section: section.title,
      section_type: section.type,
    };

    section.paragraphs.forEach((paragraph, i) => {
      docs.push(new Document({
        text: cleanText(paragraph),
        metadata: {
          ...sectionBase,
          subsection: "",
          paragraph_index: i + 1,
          total_paragraphs: section.paragraphs.length,
          content_scope: "main_article",
        },
      }));
    });

    for (const subsection of section.subsections) {
      subsection.paragraphs.forEach((paragraph, i) => {
        docs.push(new Document({
          text: cleanText(paragraph),
          metadata: {
            ...sectionBase,
            subsection: subsection.title,
            paragraph_index: i + 1,
            total_paragraphs: subsection.paragraphs.length,
            content_scope: "main_article",
          },
        }));
      });
    }
  }

  return docs.filter((doc) => doc.text.trim());
}

async function buildArticleIndex(id: string): Promise<CachedArticleIndex> {
  ensureSettings();
  const set = loadArticleSet(id);
  const documents = documentsFromArticle(set);
  if (!documents.length) throw new Error("No body paragraphs to search");
  const index = await VectorStoreIndex.init({ nodes: documents });
  return { set, index };
}

async function getArticleIndex(id: string): Promise<CachedArticleIndex> {
  if (!cache.has(id)) cache.set(id, buildArticleIndex(id));
  return cache.get(id)!;
}

function nodeText(n: any): string {
  if (typeof n.getContent === "function") {
    try {
      return n.getContent();
    } catch {
      /* fallthrough */
    }
  }
  return n.text ?? "";
}

export interface ArticleQuerySource {
  scope: "main_article";
  score: number;
  title: string;
  authors: string;
  journal: string;
  year: string;
  doi: string;
  sourceUrl: string;
  section: string;
  subsection: string;
  sectionType: string;
  paragraphIndex: number | string;
  totalParagraphs: number | string;
  text: string;
}

export interface ArticleQueryResult {
  articleId: string;
  originalQuery: string;
  enQuery: string;
  answer: string;
  sources: ArticleQuerySource[];
}

export async function runArticleQuery(
  articleId: string,
  originalQuery: string,
  opts: { topK?: number; translate?: boolean; enQuery?: string } = {},
): Promise<ArticleQueryResult> {
  const topK = Math.max(1, Math.min(20, Number(opts.topK ?? 5)));
  const { index } = await getArticleIndex(articleId);
  const shouldTranslate = opts.translate ?? hasJapanese(originalQuery);
  const enQuery = opts.enQuery ?? (shouldTranslate ? await translateToEnglish(originalQuery) : originalQuery);

  const queryEngine = index.asQueryEngine({ similarityTopK: topK });
  const response: any = await queryEngine.query({ query: enQuery });
  const answer: string = response?.response ?? response?.message?.content ?? String(response ?? "");
  const rawNodes: any[] = response?.sourceNodes ?? [];

  return {
    articleId,
    originalQuery,
    enQuery,
    answer,
    sources: rawNodes
      .map((nws): ArticleQuerySource => {
        const node = nws.node ?? nws;
        const meta = node.metadata ?? {};
        return {
          scope: "main_article",
          score: typeof nws.score === "number" ? nws.score : 0,
          title: meta.title ?? "",
          authors: meta.authors ?? "",
          journal: meta.journal ?? "",
          year: meta.year ?? "",
          doi: meta.doi ?? "",
          sourceUrl: meta.source_url ?? "",
          section: meta.section ?? "",
          subsection: meta.subsection ?? "",
          sectionType: meta.section_type ?? "",
          paragraphIndex: meta.paragraph_index ?? "",
          totalParagraphs: meta.total_paragraphs ?? "",
          text: nodeText(node),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK),
  };
}
