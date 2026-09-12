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
  doi?: string;
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

// ---- ドキュメント選択画面（フォルダ管理） ----

export interface LibraryFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  /** Zoteroコレクション由来のフォルダ。手動作成分は undefined。 */
  source?: "zotero";
  zoteroKey?: string;
  zoteroVersion?: number;
}

export interface LibraryState {
  folders: LibraryFolder[];
  /** documentId（article set の id） -> folderId */
  assignments: Record<string, string>;
  /** documentId -> Zoteroアイテムkey */
  zoteroLinks?: Record<string, string>;
  /** documentId -> Zoteroへの登録日時（ISO8601） */
  zoteroDates?: Record<string, string>;
  zoteroSyncedAt?: string;
}

// DOIから全文XMLを自動取得する /api/article/harvest-by-doi のレスポンス。
// ok:false でもHTTP 200で返り、message に理由が入る（出版社URLを案内する）。
export interface DoiHarvestResult {
  ok: boolean;
  doi: string;
  source: string;
  publisher?: string;
  pmcid?: string;
  publisherUrl?: string;
  sourceUrl?: string;
  article?: { id: string; title?: string };
  message?: string;
}

export interface ImportReport {
  ok: boolean;
  article?: {
    id: string;
    title: string;
    sourceUrl: string;
    chunkCount: number;
    createdAt: string;
  };
  reference?: {
    id: string;
    title: string;
    sourceUrl: string;
    totalReferences: number;
    abstractFound: number;
    createdAt: string;
  };
  articleError?: string;
  referenceError?: string;
}

// ---- Zotero 連携 ----

export interface ZoteroStatus {
  available: boolean;
  base: string;
  error?: string;
  collections?: number;
  items?: number;
  syncedAt?: string;
}

export interface ZoteroSyncReport {
  dryRun: boolean;
  collections: number;
  items: number;
  foldersCreated: string[];
  foldersRenamed: { from: string; to: string }[];
  foldersRemoved: string[];
  moved: { documentId: string; from: string; to: string }[];
  matched: { documentId: string; itemKey: string; via: "doi" | "citekey" | "title"; folder: string }[];
  multiCollection: { documentId: string; chosen: string; others: string[] }[];
  unmatched: { key: string; title: string; doi: string; pmid: string; year: string }[];
  unmatchedTotal: number;
  unfiledInZotero: string[];
  syncedAt: string;
}
