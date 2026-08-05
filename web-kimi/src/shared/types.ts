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

