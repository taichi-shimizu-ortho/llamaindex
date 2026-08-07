import { runArticleQuery, type ArticleQuerySource } from "./articleRag.js";
import { runReferenceQuery } from "./referenceRag.js";

export interface IntegratedSource {
  scope: "main_article" | "reference_abstract";
  score: number;
  label: string;
  title: string;
  authors: string;
  journal: string;
  year: string;
  doi: string;
  pmid: string;
  href: string;
  citationLabel?: string;
  section: string;
  subsection: string;
  paragraphIndex: number | string;
  totalParagraphs: number | string;
  text: string;
}

export interface IntegratedQueryResult {
  articleId: string;
  referenceSetId: string;
  originalQuery: string;
  enQuery: string;
  answer: string;
  articleAnswer: string;
  referenceAnswer: string;
  sources: IntegratedSource[];
}

function articleSourceToIntegrated(source: ArticleQuerySource): IntegratedSource {
  const section = source.subsection ? `${source.section} > ${source.subsection}` : source.section;
  return {
    scope: "main_article",
    score: source.score,
    label: section || "Main article",
    title: source.title,
    authors: source.authors,
    journal: source.journal,
    year: source.year,
    doi: source.doi,
    pmid: "",
    href: source.sourceUrl,
    section: source.section,
    subsection: source.subsection,
    paragraphIndex: source.paragraphIndex,
    totalParagraphs: source.totalParagraphs,
    text: source.text,
  };
}

export async function runIntegratedQuery(
  articleId: string,
  referenceSetId: string,
  originalQuery: string,
  opts: { topK?: number } = {},
): Promise<IntegratedQueryResult> {
  const topK = Math.max(1, Math.min(20, Number(opts.topK ?? 5)));
  const enQuery = originalQuery;

  const [article, references] = await Promise.all([
    runArticleQuery(articleId, originalQuery, { topK }),
    runReferenceQuery(referenceSetId, originalQuery, { topK }),
  ]);

  const articleSources = article.sources.map(articleSourceToIntegrated);
  const referenceSources: IntegratedSource[] = references.sources.map((source) => ({
    scope: "reference_abstract",
    score: source.score,
    label: `Reference ${source.refIndex}`,
    title: source.title,
    authors: source.authors,
    journal: source.journal,
    year: source.year,
    doi: source.doi,
    pmid: source.pmid,
    href: source.href,
    citationLabel: source.citationLabel,
    section: "Abstract",
    subsection: "",
    paragraphIndex: "",
    totalParagraphs: "",
    text: source.abstract,
  }));

  return {
    articleId,
    referenceSetId,
    originalQuery,
    enQuery,
    answer: [
      "## Main article",
      article.answer,
      "",
      "## Reference abstracts",
      references.answer,
    ].join("\n"),
    articleAnswer: article.answer,
    referenceAnswer: references.answer,
    sources: [...articleSources, ...referenceSources].sort((a, b) => b.score - a.score).slice(0, topK * 2),
  };
}
