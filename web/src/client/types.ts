// クライアント用に共有型を再エクスポート（サーバの shared/types と同一スキーマ）
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

export interface Status {
  indexReady: boolean;
  storageDir: string;
  hasApiKey: boolean;
}
