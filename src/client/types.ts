export interface Status {
  hasApiKey: boolean;
  missingKeys: string[];
  llmModel: string;
  llmLabel: string;
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

export interface ReferenceSetSummary {
  id: string;
  title: string;
  sourceUrl: string;
  totalReferences: number;
  abstractFound: number;
  createdAt: string;
}

export interface ArticleSetSummary {
  id: string;
  title: string;
  sourceUrl: string;
  doi?: string;
  chunkCount: number;
  createdAt: string;
}

// ---- 複数論文 RAG（corpus） ----

export type SectionGroup = "intro" | "methods" | "results" | "discussion" | "conclusion" | "figure" | "table" | "other";

export interface CorpusPaper {
  id: string;
  label: string;
  title: string;
  authors: string;
  year: string;
  journal: string;
  doi: string;
  sourceUrl: string;
  paragraphs: number;
  hits: number;
}

export interface CorpusSkipped {
  id: string;
  error: string;
}

export interface CorpusPrepareResult {
  papers: CorpusPaper[];
  skipped: CorpusSkipped[];
  totalParagraphs: number;
}

export interface CorpusSource {
  n: number;
  articleId: string;
  label: string;
  score: number;
  cited: boolean;
  title: string;
  authors: string;
  year: string;
  journal: string;
  doi: string;
  sourceUrl: string;
  section: string;
  subsection: string;
  sectionGroup: SectionGroup;
  paragraphIndex: number;
  totalParagraphs: number;
  text: string;
}

export interface CorpusQueryResult {
  scope: "corpus";
  /** 検索対象の説明（例: "Folder: Rxfp1 / Clinical"、手動選択なら "Custom selection"） */
  scopeLabel: string;
  articleIds: string[];
  papers: CorpusPaper[];
  skipped: CorpusSkipped[];
  originalQuery: string;
  enQuery: string;
  sectionGroups: SectionGroup[];
  topK: number;
  perPaper: number;
  answer: string;
  model: string;
  sources: CorpusSource[];
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
  /** documentId -> 所属する Zotero 由来フォルダすべて（複数コレクション所属の文献用） */
  zoteroFolders?: Record<string, string[]>;
  zoteroSyncedAt?: string;
}

/** RAG の対象をフォルダ単位で決めるときのスコープ。フォルダの中身が変われば対象も追従する。 */
export interface CorpusScope {
  folderId: string;
  includeSubfolders: boolean;
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
