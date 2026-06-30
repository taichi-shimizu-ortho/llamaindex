export interface Status {
  hasApiKey: boolean;
}

export interface ReferenceRecord {
  index: number;
  text: string;
  sourceUrl: string;
  href: string;
  doi: string;
  pmid: string;
  pubmedFound: boolean;
  pubmed?: {
    pmid: string;
    doi: string;
    title: string;
    abstract: string;
    authors: string[];
    journal: string;
    year: string;
    publicationTypes: string[];
    meshTerms?: string[];
    articleType?: "review" | "original" | "other";
  };
  error?: string;
}

export interface ReferenceSet {
  id: string;
  sourceUrl: string;
  title: string;
  createdAt: string;
  totalReferences: number;
  pubmedFound: number;
  abstractFound: number;
  records: ReferenceRecord[];
}

export interface ReferenceSetSummary {
  id: string;
  title: string;
  sourceUrl: string;
  totalReferences: number;
  abstractFound: number;
  createdAt: string;
}

export interface ReferenceQueryResult {
  setId: string;
  originalQuery: string;
  enQuery: string;
  answer: string;
  sources: {
    score: number;
    refIndex: number | string;
    title: string;
    authors: string;
    journal: string;
    year: string;
    doi: string;
    pmid: string;
    href: string;
    referenceText: string;
    abstract: string;
    citationLabel: string;
  }[];
}

export interface ArticleSection {
  title: string;
  type: string;
  content: string;
  paragraphs: string[];
  subsections: { title: string; type?: string; content: string; paragraphs: string[] }[];
}

export interface ArticleSet {
  id: string;
  sourceUrl: string;
  title: string;
  authors: string[];
  journal: string;
  year: string;
  doi: string;
  createdAt: string;
  sections: ArticleSection[];
  chunkCount: number;
}

export interface ArticleSetSummary {
  id: string;
  title: string;
  sourceUrl: string;
  chunkCount: number;
  createdAt: string;
}

export interface ArticleQueryResult {
  articleId: string;
  originalQuery: string;
  enQuery: string;
  answer: string;
  sources: {
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
  }[];
}

export interface IntegratedQueryResult {
  articleId: string;
  referenceSetId: string;
  originalQuery: string;
  enQuery: string;
  answer: string;
  articleAnswer: string;
  referenceAnswer: string;
  sources: {
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
  }[];
}
