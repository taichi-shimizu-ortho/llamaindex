import OpenAIClient from "openai";
import { MODELS } from "./config.js";
import { cosineSimilarity, embedModel, getEmbeddings } from "./embeddingStore.js";
import { loadArticleSet, type ArticleSet } from "./articleHarvester.js";

// 1パラグラフ = 1検索・表示単位。テキストとメタデータを保持する。
interface ArticleItem {
  text: string;
  meta: {
    title: string;
    authors: string;
    journal: string;
    year: string;
    doi: string;
    source_url: string;
    section: string;
    section_type: string;
    subsection: string;
    paragraph_index: number;
    total_paragraphs: number;
  };
}

interface CachedArticleIndex {
  set: ArticleSet;
  items: ArticleItem[];
  embeddings: number[][];
}

const cache = new Map<string, Promise<CachedArticleIndex>>();

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

function itemsFromArticle(set: ArticleSet): ArticleItem[] {
  const items: ArticleItem[] = [];
  const base = {
    title: set.title,
    authors: set.authors.join(", "),
    journal: set.journal,
    year: set.year,
    doi: set.doi,
    source_url: set.sourceUrl,
  };

  for (const section of set.sections) {
    section.paragraphs.forEach((paragraph, i) => {
      const text = cleanText(paragraph);
      if (text) {
        items.push({
          text,
          meta: {
            ...base,
            section: section.title,
            section_type: section.type,
            subsection: "",
            paragraph_index: i + 1,
            total_paragraphs: section.paragraphs.length,
          },
        });
      }
    });

    for (const subsection of section.subsections) {
      subsection.paragraphs.forEach((paragraph, i) => {
        const text = cleanText(paragraph);
        if (text) {
          items.push({
            text,
            meta: {
              ...base,
              section: section.title,
              section_type: section.type,
              subsection: subsection.title,
              paragraph_index: i + 1,
              total_paragraphs: subsection.paragraphs.length,
            },
          });
        }
      });
    }
  }

  return items;
}

async function buildArticleIndex(id: string): Promise<CachedArticleIndex> {
  const set = loadArticleSet(id);
  const items = itemsFromArticle(set);
  if (!items.length) throw new Error("No body paragraphs to search");
  // 埋め込みはディスクキャッシュ経由（再起動時は再埋め込みしない）。
  const embeddings = await getEmbeddings("article", id, items.map((item) => item.text));
  return { set, items, embeddings };
}

async function getArticleIndex(id: string): Promise<CachedArticleIndex> {
  if (!cache.has(id)) cache.set(id, buildArticleIndex(id));
  return cache.get(id)!;
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

async function synthesizeArticleAnswer(enQuery: string, sources: ArticleQuerySource[]): Promise<string> {
  if (!sources.length) return "";
  const client = new OpenAIClient();
  const context = sources
    .map((source, i) => {
      const section = source.subsection ? `${source.section} > ${source.subsection}` : source.section;
      return `[${i + 1}] (${section}, paragraph ${source.paragraphIndex})\n${source.text}`;
    })
    .join("\n\n---\n\n");

  const res = await client.chat.completions.create({
    model: MODELS.llm,
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content: [
          "You answer questions using only the provided passages from a single research article.",
          "Base every statement strictly on the passages; do not add outside knowledge.",
          "If the passages do not contain enough information, say so clearly.",
          "Always answer in English, regardless of the language of the user's query.",
        ].join(" "),
      },
      {
        role: "user",
        content: [`Query: ${enQuery}`, "", "Article passages:", context].join("\n"),
      },
    ],
  });

  return res.choices[0].message.content?.trim() ?? "";
}

export async function runArticleQuery(
  articleId: string,
  originalQuery: string,
  opts: { topK?: number; translate?: boolean; enQuery?: string } = {},
): Promise<ArticleQueryResult> {
  const topK = Math.max(1, Math.min(20, Number(opts.topK ?? 5)));
  const { items, embeddings } = await getArticleIndex(articleId);
  const shouldTranslate = opts.translate ?? hasJapanese(originalQuery);
  const enQuery = opts.enQuery ?? (shouldTranslate ? await translateToEnglish(originalQuery) : originalQuery);

  // クエリを埋め込み、各パラグラフとのコサイン類似度で上位topKを選ぶ。
  const queryVec = await embedModel().getTextEmbedding(enQuery);
  const sources: ArticleQuerySource[] = items
    .map((item, i): ArticleQuerySource => ({
      scope: "main_article",
      score: cosineSimilarity(queryVec, embeddings[i]),
      title: item.meta.title,
      authors: item.meta.authors,
      journal: item.meta.journal,
      year: item.meta.year,
      doi: item.meta.doi,
      sourceUrl: item.meta.source_url,
      section: item.meta.section,
      subsection: item.meta.subsection,
      sectionType: item.meta.section_type,
      paragraphIndex: item.meta.paragraph_index,
      totalParagraphs: item.meta.total_paragraphs,
      text: item.text,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const answer = await synthesizeArticleAnswer(enQuery, sources);

  return { articleId, originalQuery, enQuery, answer, sources };
}
