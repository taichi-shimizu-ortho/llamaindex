// [STEP 40 のDocument化ロジック移植] 構造化JSON → 段落単位 Document
// Python版 40_build_all_articles_index.py の create_section_documents_* と一致
import { Document } from "llamaindex";
import { EXCLUDE_FROM_INDEX } from "./config.js";
import type { Article } from "../shared/types.js";

function shouldExcludeParagraph(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes("references") || t.includes("cited by");
}

function isReviewArticle(a: Article): boolean {
  if (typeof a.is_review === "boolean") return a.is_review;
  return (a.tags || []).includes("review");
}

function baseMetadata(a: Article, articleType: "regular" | "review") {
  const authors = a.authors || [];
  let firstAuthor = "";
  let authorsStr = "";
  if (Array.isArray(authors) && authors.length) {
    firstAuthor = authors[0].split(",")[0].trim();
    authorsStr = authors.join(", ");
  } else {
    authorsStr = String(authors);
  }
  const citation = firstAuthor || a.published ? `${firstAuthor} ${a.published}`.trim() : a.citekey;
  return {
    citekey: a.citekey || "Unknown",
    title: a.title || "",
    authors: authorsStr,
    first_author: firstAuthor,
    published: a.published || "",
    source: a.source || "",
    volume: a.volume || "",
    issue: a.issue || "",
    doi: a.doi || "",
    pmid: a.pmid || "",
    citation,
    article_type: articleType,
    mesh_terms: (a.entrez_mesh_terms || []).join(", "),
    keywords: (a.entrez_keywords || []).join(", "),
  };
}

function paragraphs(text: string): string[] {
  return text
    .split("\n\n")
    .map((p) => p.trim())
    .filter((p) => p && !shouldExcludeParagraph(p));
}

function regularDocuments(articles: Article[]): Document[] {
  const docs: Document[] = [];
  for (const a of articles) {
    const base = baseMetadata(a, "regular");
    for (const section of a.sections) {
      if (EXCLUDE_FROM_INDEX.has(section.type)) continue;

      // メインセクションの段落
      const mainParas = paragraphs(section.content || "");
      mainParas.forEach((p, i) => {
        docs.push(new Document({
          text: p,
          metadata: {
            ...base,
            section: section.title || "Untitled",
            section_type: section.type || "unknown",
            subsection: "",
            paragraph_index: i + 1,
            total_paragraphs: mainParas.length,
          },
        }));
      });

      // サブセクションの段落
      for (const sub of section.subsections || []) {
        const subParas = paragraphs(sub.content || "");
        subParas.forEach((p, i) => {
          docs.push(new Document({
            text: p,
            metadata: {
              ...base,
              section: section.title || "Untitled",
              section_type: section.type || "unknown",
              subsection: sub.title || "Untitled",
              paragraph_index: i + 1,
              total_paragraphs: subParas.length,
            },
          }));
        });
      }
    }
  }
  return docs;
}

function reviewDocuments(articles: Article[]): Document[] {
  const docs: Document[] = [];
  for (const a of articles) {
    const base = baseMetadata(a, "review");
    for (const section of a.sections) {
      if (EXCLUDE_FROM_INDEX.has(section.type)) continue;

      // セクション + 全サブセクションを結合
      let combined = section.content || "";
      for (const sub of section.subsections || []) {
        if ((sub.content || "").trim()) combined += "\n\n" + sub.content;
      }
      const paras = paragraphs(combined);
      paras.forEach((p, i) => {
        docs.push(new Document({
          text: p,
          metadata: {
            ...base,
            section: section.title || "Untitled",
            section_type: section.type || "unknown",
            subsection: "",
            paragraph_index: i + 1,
            total_paragraphs: paras.length,
          },
        }));
      });
    }
  }
  return docs;
}

export function createSectionDocuments(articles: Article[]): Document[] {
  const review = articles.filter(isReviewArticle);
  const regular = articles.filter((a) => !isReviewArticle(a));
  return [...regularDocuments(regular), ...reviewDocuments(review)];
}

export { isReviewArticle };
