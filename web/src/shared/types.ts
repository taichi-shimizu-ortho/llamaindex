// 構造化JSONの型定義（Python版 30_batch_convert_articles.py の出力スキーマと一致）

export interface Subsection {
  title: string;
  content: string;
}

export type SectionType =
  | "abstract"
  | "intro"
  | "keywords"
  | "abbreviations"
  | "materials|methods"
  | "results"
  | "discussion"
  | "conclusion"
  | "references"
  | "cited_by"
  | "acknowledgements"
  | "review"
  | "other";

export interface Section {
  title: string;
  type: SectionType;
  content: string;
  subsections: Subsection[];
}

export interface Article {
  citekey: string;
  title: string;
  authors: string[];
  published: string;
  source: string;
  volume: string;
  issue: string;
  doi: string;
  tags: string[];
  sections: Section[];
  is_review: boolean;
  filename: string;
  pmid: string;
  publisher: string;
  entrez_mesh_terms: string[];
  entrez_keywords: string[];
}

export interface ArticlesFile {
  articles: Article[];
  metadata: {
    total_count: number;
    failed_count: number;
    source_directory: string;
    failed_files: { filename: string; error: string }[];
  };
}

// 検索結果（API レスポンス）
export interface SourceNode {
  source: "RXFP1" | "All";
  score: number;
  citekey: string;
  title: string;
  authors: string;
  journal: string;
  published: string;
  volume: string;
  issue: string;
  section: string;
  subsection: string;
  section_type: string;
  paragraph_index: number | string;
  total_paragraphs: number | string;
  doi: string;
  pmid: string;
  tags: string;
  mesh_terms: string;
  text: string;
}

export interface QueryResult {
  original_query: string;
  en_query: string;
  answer: string;
  targets: string[];
  sources: SourceNode[];
}
