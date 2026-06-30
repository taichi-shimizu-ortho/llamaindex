import { createContext, Fragment, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type {
  ArticleQueryResult,
  ArticleSet,
  ArticleSetSummary,
  IntegratedQueryResult,
  ReferenceQueryResult,
  ReferenceRecord,
  ReferenceSet,
  ReferenceSetSummary,
  Status,
} from "./types.js";

type Theme = "light" | "dark";
type SearchMode = "integrated" | "article" | "reference";
type QueryResultUnion = ReferenceQueryResult | ArticleQueryResult | IntegratedQueryResult;

// 本文中の引用番号 [83] / [ 1 , 2 ] を参照文献メタデータに紐付けるための索引。
const ReferenceMapContext = createContext<Map<number, ReferenceRecord>>(new Map());

// 数字・空白・カンマ・ダッシュのみで構成された角括弧（[14/167 patients] のような非引用は除外）。
const CITATION_GROUP = /\[\s*\d[\d\s,–-]*\]/g;

function Citation({ n, record }: { n: number; record?: ReferenceRecord }) {
  if (!record) return <>{n}</>;
  const title = record.pubmed?.title || record.text;
  const journal = record.pubmed?.journal ?? "";
  const year = record.pubmed?.year ?? "";
  const authors = record.pubmed?.authors?.slice(0, 3).join(", ") ?? "";
  return (
    <span className="cite" tabIndex={0}>
      <span className="cite-num">{n}</span>
      <span className="cite-pop" role="tooltip">
        <span className="cite-pop-idx">Reference {record.index}</span>
        <span className="cite-pop-title">{title}</span>
        {(journal || year) && (
          <span className="cite-pop-meta">
            {journal}
            {journal && year ? " · " : ""}
            {year}
          </span>
        )}
        {authors && <span className="cite-pop-authors">{authors}{record.pubmed && record.pubmed.authors.length > 3 ? ", et al." : ""}</span>}
      </span>
    </span>
  );
}

function renderCitationGroup(group: string, refMap: Map<number, ReferenceRecord>, keyBase: string): ReactNode {
  const inner = group.slice(1, -1);
  return (
    <span className="cite-group" key={keyBase}>
      [
      {inner.split(/(\d+)/).map((part, idx) => {
        if (/^\d+$/.test(part)) {
          const n = Number(part);
          return <Citation key={idx} n={n} record={refMap.get(n)} />;
        }
        const sep = part.replace(/\s+/g, "").replace(/,/g, ", ");
        return <Fragment key={idx}>{sep}</Fragment>;
      })}
      ]
    </span>
  );
}

function renderCitations(text: string, refMap: Map<number, ReferenceRecord>, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  CITATION_GROUP.lastIndex = 0;
  while ((m = CITATION_GROUP.exec(text))) {
    if (m.index > last) out.push(<Fragment key={`${keyBase}-t${i}`}>{text.slice(last, m.index)}</Fragment>);
    out.push(renderCitationGroup(m[0], refMap, `${keyBase}-c${i}`));
    last = m.index + m[0].length;
    i += 1;
  }
  if (last < text.length) out.push(<Fragment key={`${keyBase}-t${i}`}>{text.slice(last)}</Fragment>);
  return out;
}

function renderInline(text: string, refMap: Map<number, ReferenceRecord>, cite: boolean, keyBase: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).flatMap((part, idx) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return [<strong key={`${keyBase}-b${idx}`}>{part.slice(2, -2)}</strong>];
    }
    return cite
      ? renderCitations(part, refMap, `${keyBase}-${idx}`)
      : [<Fragment key={`${keyBase}-${idx}`}>{part}</Fragment>];
  });
}

function renderMarkdownLine(text: string, refMap: Map<number, ReferenceRecord>, cite: boolean): ReactNode[] {
  return text.split("\n").flatMap((line, idx) => {
    const nodes = renderInline(line, refMap, cite, `l${idx}`);
    return idx === 0 ? nodes : [<br key={`br-${idx}`} />, ...nodes];
  });
}

// 本文段落（ソース表示）向け: 引用番号のみをリンク化する軽量レンダラー。
function CitedText({ className, text }: { className?: string; text: string }) {
  const refMap = useContext(ReferenceMapContext);
  return <span className={className}>{renderCitations(text, refMap, "ct")}</span>;
}

function MarkdownText({ className, text, cite = false }: { className?: string; text: string; cite?: boolean }) {
  const refMap = useContext(ReferenceMapContext);
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    blocks.push(
      <p className="markdown-paragraph" key={`p-${blocks.length}`}>
        {renderMarkdownLine(paragraph.join("\n"), refMap, cite)}
      </p>,
    );
    paragraph = [];
  }

  function flushList() {
    if (!listItems.length) return;
    blocks.push(
      <ul className="markdown-list" key={`ul-${blocks.length}`}>
        {listItems.map((item, idx) => (
          <li key={idx}>{renderInline(item, refMap, cite, `li${idx}`)}</li>
        ))}
      </ul>,
    );
    listItems = [];
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const listMatch = line.match(/^\s*[-*]\s+(.+)$/);
    if (!line.trim()) {
      flushParagraph();
      flushList();
    } else if (listMatch) {
      flushParagraph();
      listItems.push(listMatch[1]);
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();

  return <div className={className}>{blocks}</div>;
}

function initialTheme(): Theme {
  const saved = localStorage.getItem("theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function sessionStamp(): string {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yy}${mm}${dd}_${hh}${mi}${ss}`;
}

function initialSessionId(): string {
  const saved = sessionStorage.getItem("ragSessionId");
  if (saved) return saved;
  const next = sessionStamp();
  sessionStorage.setItem("ragSessionId", next);
  return next;
}

function datasetBaseId(id: string): string {
  return id.replace(/-\d+$/, "");
}

function datasetLabel(id: string): string {
  return id;
}

function matchingReferenceSet(articleId: string, summaries: ReferenceSetSummary[]): ReferenceSetSummary | undefined {
  const baseId = datasetBaseId(articleId);
  return summaries
    .filter((set) => datasetBaseId(set.id) === baseId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function ScoreBar({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, score * 100));
  return (
    <div className="scorebar" title={`score: ${score.toFixed(4)}`}>
      <div className="scorebar-fill" style={{ width: `${pct}%` }} />
      <span className="scorebar-label">{score.toFixed(3)}</span>
    </div>
  );
}

const ARTICLE_TYPE_LABEL: Record<NonNullable<NonNullable<ReferenceRecord["pubmed"]>["articleType"]>, string> = {
  review: "Review",
  original: "Original",
  other: "Other",
};

function ReferenceRow({ record }: { record: ReferenceRecord }) {
  const abstract = record.pubmed?.abstract ?? "";
  const articleType = record.pubmed?.articleType;
  const meshTerms = record.pubmed?.meshTerms ?? [];
  return (
    <details className={abstract ? "ref-details" : "ref-details muted-row"}>
      <summary>
        <div className="ref-row ref-row-summary">
          <div className="ref-index">{record.index}</div>
          <div className="ref-main">
            <div className="ref-title">{record.pubmed?.title || record.text}</div>
            <div className="ref-meta">
              {articleType && (
                <span className={`ref-type ref-type-${articleType}`}>{ARTICLE_TYPE_LABEL[articleType]}</span>
              )}
              {record.pubmed?.authors?.[0] && (
                <span>
                  {record.pubmed.authors[0]}
                  {record.pubmed.authors.length > 1 ? " et al." : ""}
                </span>
              )}
              {record.pubmed?.journal && <span>{record.pubmed.journal}</span>}
              {record.pubmed?.year && <span>{record.pubmed.year}</span>}
              {record.pmid && (
                <a href={`https://pubmed.ncbi.nlm.nih.gov/${record.pmid}`} target="_blank" rel="noreferrer">
                  PMID {record.pmid}
                </a>
              )}
              {record.doi && (
                <a href={`https://doi.org/${record.doi}`} target="_blank" rel="noreferrer">
                  DOI
                </a>
              )}
              {record.error && <span className="warn-text">{record.error}</span>}
            </div>
          </div>
          <span className={abstract ? "pill ok" : "pill warn"}>{abstract ? "Abstract" : "No abstract"}</span>
        </div>
      </summary>
      <div className="ref-abstract-body">
        {abstract ? (
          <p>{abstract}</p>
        ) : (
          <>
            <p className="muted-text">{record.text}</p>
            {record.error && <p className="warn-text">{record.error}</p>}
          </>
        )}
        {meshTerms.length > 0 && (
          <div className="ref-mesh">
            <span className="ref-mesh-label">MeSH</span>
            {meshTerms.map((term) => (
              <span key={term} className="mesh-tag">
                {term}
              </span>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function ResultSource({ source, idx }: { source: ReferenceQueryResult["sources"][number]; idx: number }) {
  const [open, setOpen] = useState(false);
  const preview = source.abstract.length > 360 ? `${source.abstract.slice(0, 360)}...` : source.abstract;
  return (
    <div className="source-card">
      <div className="source-head">
        <span className="source-idx">{idx + 1}</span>
        <div className="source-cite">
          <div className="source-citekey">
            Reference {source.refIndex}
            {source.citationLabel && ` · ${source.citationLabel}`}
          </div>
          <div className="source-title">{source.title || source.referenceText}</div>
          <div className="source-journal">
            {source.journal}
            {source.year && ` · ${source.year}`}
          </div>
        </div>
        <ScoreBar score={source.score} />
      </div>
      <div className="source-meta">
        {source.pmid && (
          <a className="meta-doi" href={`https://pubmed.ncbi.nlm.nih.gov/${source.pmid}`} target="_blank" rel="noreferrer">
            PubMed
          </a>
        )}
        {source.doi && (
          <a className="meta-doi" href={`https://doi.org/${source.doi}`} target="_blank" rel="noreferrer">
            DOI
          </a>
        )}
        {source.authors && <span>{source.authors}</span>}
      </div>
      <p className="source-text">{open ? source.abstract : preview}</p>
      {source.abstract.length > 360 && (
        <button className="link-btn" onClick={() => setOpen((v) => !v)}>
          {open ? "Close" : "Show abstract"}
        </button>
      )}
    </div>
  );
}

function ArticleResultSource({ source, idx }: { source: ArticleQueryResult["sources"][number]; idx: number }) {
  const [open, setOpen] = useState(false);
  const preview = source.text.length > 360 ? `${source.text.slice(0, 360)}...` : source.text;
  const section = source.subsection ? `${source.section} > ${source.subsection}` : source.section;
  return (
    <div className="source-card">
      <div className="source-head">
        <span className="source-idx">{idx + 1}</span>
        <div className="source-cite">
          <div className="source-citekey">Main article</div>
          <div className="source-title">{section}</div>
          <div className="source-journal">
            {source.journal}
            {source.year && ` · ${source.year}`}
            {` · paragraph ${source.paragraphIndex}/${source.totalParagraphs}`}
          </div>
        </div>
        <ScoreBar score={source.score} />
      </div>
      <div className="source-meta">
        {source.doi && (
          <a className="meta-doi" href={`https://doi.org/${source.doi}`} target="_blank" rel="noreferrer">
            DOI
          </a>
        )}
        {source.authors && <span>{source.authors}</span>}
      </div>
      <CitedText className="source-text" text={open ? source.text : preview} />
      {source.text.length > 360 && (
        <button className="link-btn" onClick={() => setOpen((v) => !v)}>
          {open ? "Close" : "Show paragraph"}
        </button>
      )}
    </div>
  );
}

function IntegratedResultSource({ source, idx }: { source: IntegratedQueryResult["sources"][number]; idx: number }) {
  const [open, setOpen] = useState(false);
  const preview = source.text.length > 360 ? `${source.text.slice(0, 360)}...` : source.text;
  const isMainArticle = source.scope === "main_article";

  return (
    <div className="source-card">
      <div className="source-head">
        <span className="source-idx">{idx + 1}</span>
        <div className="source-cite">
          <div className="source-citekey">
            {isMainArticle ? "Main article" : source.label}
            {!isMainArticle && source.citationLabel && ` · ${source.citationLabel}`}
          </div>
          <div className="source-title">{isMainArticle ? source.label : source.title}</div>
          {isMainArticle ? (
            <div className="source-journal">
              {source.paragraphIndex && source.totalParagraphs
                ? `${source.paragraphIndex}/${source.totalParagraphs} paragraph`
                : "paragraph"}
            </div>
          ) : (
            <div className="source-journal">
              {source.journal}
              {source.year && ` · ${source.year}`}
            </div>
          )}
        </div>
        <ScoreBar score={source.score} />
      </div>

      {!isMainArticle && (
        <div className="source-meta">
          {source.pmid && (
            <a
              className="meta-doi"
              href={`https://pubmed.ncbi.nlm.nih.gov/${source.pmid}`}
              target="_blank"
              rel="noreferrer"
            >
              PubMed
            </a>
          )}
          {source.doi && (
            <a
              className="meta-doi"
              href={`https://doi.org/${source.doi}`}
              target="_blank"
              rel="noreferrer"
            >
              DOI
            </a>
          )}
          {source.authors && <span>{source.authors}</span>}
        </div>
      )}

      {isMainArticle ? (
        <CitedText className="source-text" text={open ? source.text : preview} />
      ) : (
        <p className="source-text">{open ? source.text : preview}</p>
      )}

      {source.text.length > 360 && (
        <button className="link-btn" onClick={() => setOpen((v) => !v)}>
          {open ? "Close" : "Show text"}
        </button>
      )}
    </div>
  );
}

function IntegratedSources({ sources }: { sources: IntegratedQueryResult["sources"] }) {
  const mainSources = sources.filter((source) => source.scope === "main_article");
  const abstractSources = sources.filter((source) => source.scope === "reference_abstract");

  return (
    <>
      <div className="source-group">
        <div className="sources-head">
          <h2>Main Article ({mainSources.length})</h2>
        </div>
        <div className="sources">
          {mainSources.map((source, idx) => (
            <IntegratedResultSource key={`${source.scope}-${source.section}-${source.subsection}-${idx}`} source={source} idx={idx} />
          ))}
        </div>
      </div>

      <div className="source-group">
        <div className="sources-head">
          <h2>Abstract ({abstractSources.length})</h2>
        </div>
        <div className="sources">
          {abstractSources.map((source, idx) => (
            <IntegratedResultSource key={`${source.scope}-${source.doi}-${source.pmid}-${idx}`} source={source} idx={idx} />
          ))}
        </div>
      </div>
    </>
  );
}

function AnswerBlock({ title, text, cite = false }: { title: string; text: string; cite?: boolean }) {
  return (
    <div className="answer-block">
      <h3>{title}</h3>
      <MarkdownText className="answer-text" text={text} cite={cite} />
    </div>
  );
}

type ArticleSectionItem = ArticleSet["sections"][number];
type ArticleSubsectionItem = ArticleSectionItem["subsections"][number];
type FigureItem = {
  title: string;
  content: string;
  imageUrl: string;
  legend: string;
};

function isFigureLike(item: { title: string; type?: string; content?: string }): boolean {
  return item.type === "figure" || /^figure\s+\d+/i.test(item.title) || /\[Image URL:/i.test(item.content ?? "");
}

function figureFromItem(item: { title: string; content: string; paragraphs?: string[] }): FigureItem {
  const content = item.content || item.paragraphs?.join("\n\n") || "";
  const imageUrl = content.match(/\[Image URL:\s*(.*?)\]/i)?.[1]?.trim() ?? "";
  const legend = content.replace(/\[Image URL:\s*.*?\]/gi, "").trim();
  return {
    title: item.title,
    content,
    imageUrl,
    legend,
  };
}

function collectFigures(article: ArticleSet): FigureItem[] {
  const figures: FigureItem[] = [];

  for (const section of article.sections) {
    if (isFigureLike(section)) figures.push(figureFromItem(section));
    for (const subsection of section.subsections) {
      if (isFigureLike(subsection)) figures.push(figureFromItem(subsection));
    }
  }

  const seen = new Set<string>();
  return figures.filter((figure) => {
    const key = `${figure.title}|${figure.legend.slice(0, 100)}|${figure.imageUrl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sectionParagraphCount(section: ArticleSectionItem): number {
  return section.paragraphs.length + section.subsections.filter((sub) => !isFigureLike(sub)).reduce((n, sub) => n + sub.paragraphs.length, 0);
}

function ParagraphList({ paragraphs }: { paragraphs: string[] }) {
  return (
    <div className="article-paragraphs">
      {paragraphs.map((paragraph, idx) => (
        <div className="article-paragraph" key={`${idx}-${paragraph.slice(0, 24)}`}>
          <span className="paragraph-index">{idx + 1}</span>
          <CitedText text={paragraph} />
        </div>
      ))}
    </div>
  );
}

function SubsectionDropdown({ subsection }: { subsection: ArticleSubsectionItem }) {
  return (
    <details className="article-details article-details-nested">
      <summary>
        <span className="article-summary-main">{subsection.title}</span>
        <span className="article-summary-meta">{subsection.paragraphs.length} paragraphs</span>
      </summary>
      <ParagraphList paragraphs={subsection.paragraphs} />
    </details>
  );
}

function SectionDropdown({ section }: { section: ArticleSectionItem }) {
  const count = sectionParagraphCount(section);
  return (
    <details className="article-details">
      <summary>
        <span className="article-summary-main">{section.title}</span>
        <span className="article-summary-meta">
          {section.type} · {count} paragraphs
        </span>
      </summary>

      <div className="article-section-body">
        {section.paragraphs.length > 0 && <ParagraphList paragraphs={section.paragraphs} />}

        {section.subsections.length > 0 && (
          <div className="subsection-stack">
            {section.subsections.filter((subsection) => !isFigureLike(subsection)).map((subsection) => (
              <SubsectionDropdown key={subsection.title} subsection={subsection} />
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function FigureBrowser({ figures }: { figures: FigureItem[] }) {
  if (!figures.length) return null;

  return (
    <div className="figure-browser">
      <div className="article-browser-subhead">
        <h3>Figures</h3>
        <span>{figures.length} figures</span>
      </div>
      <div className="figure-stack">
        {figures.map((figure, idx) => (
          <details className="article-details figure-details" key={`${figure.title}-${idx}`}>
            <summary>
              <span className="article-summary-main">{figure.title}</span>
              <span className="article-summary-meta">{figure.imageUrl ? "image + legend" : "legend"}</span>
            </summary>
            <div className="figure-body">
              {figure.imageUrl && (
                <a className="figure-image-link" href={figure.imageUrl} target="_blank" rel="noreferrer">
                  <img src={figure.imageUrl} alt={figure.title} />
                </a>
              )}
              {figure.legend && <p>{figure.legend}</p>}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

function ArticleContentBrowser({ article }: { article: ArticleSet }) {
  const abstractSections = article.sections.filter((section) => section.type === "abstract");
  const figures = collectFigures(article);
  const mainSections = article.sections.filter((section) => section.type !== "abstract" && !isFigureLike(section));

  return (
    <section className="article-browser">
      <div className="sources-head article-browser-head">
        <h2>Article Content</h2>
        <span className="panel-note">Abstract and main text preview</span>
      </div>

      {abstractSections.map((section) => (
        <details className="article-details article-details-abstract" key={section.title} open>
          <summary>
            <span className="article-summary-main">Abstract</span>
            <span className="article-summary-meta">{section.paragraphs.length} paragraphs</span>
          </summary>
          <ParagraphList paragraphs={section.paragraphs} />
        </details>
      ))}

      <FigureBrowser figures={figures} />

      <div className="main-text-browser">
        <div className="article-browser-subhead">
          <h3>Main Text</h3>
          <span>{mainSections.length} sections</span>
        </div>
        <div className="section-stack">
          {mainSections.map((section) => (
            <SectionDropdown key={`${section.type}-${section.title}`} section={section} />
          ))}
        </div>
      </div>
    </section>
  );
}

export function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [status, setStatus] = useState<Status | null>(null);
  const [sets, setSets] = useState<ReferenceSetSummary[]>([]);
  const [articleSets, setArticleSets] = useState<ArticleSetSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selectedArticleId, setSelectedArticleId] = useState("");
  const [currentSet, setCurrentSet] = useState<ReferenceSet | null>(null);
  const [currentArticle, setCurrentArticle] = useState<ArticleSet | null>(null);
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState(5);
  const [translate, setTranslate] = useState(true);
  const [searchMode, setSearchMode] = useState<SearchMode>("integrated");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [savedFile, setSavedFile] = useState("");
  const [sessionId] = useState(initialSessionId);
  const [result, setResult] = useState<QueryResultUnion | null>(null);

  const referenceMap = useMemo(() => {
    const map = new Map<number, ReferenceRecord>();
    currentSet?.records.forEach((record) => map.set(record.index, record));
    return map;
  }, [currentSet]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  async function fetchReferenceSetSummaries(): Promise<ReferenceSetSummary[]> {
    const res = await fetch("/api/reference/sets");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Failed to load dataset list");
    const nextSets = data.sets ?? [];
    setSets(nextSets);
    return nextSets;
  }

  async function fetchArticleSetSummaries(): Promise<ArticleSetSummary[]> {
    const res = await fetch("/api/article/sets");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Failed to load article JSON list");
    const nextSets = data.sets ?? [];
    setArticleSets(nextSets);
    return nextSets;
  }

  async function loadMatchingReferenceSet(articleId: string, summaries?: ReferenceSetSummary[]) {
    const nextSets = summaries ?? (sets.length ? sets : await fetchReferenceSetSummaries());
    const match = matchingReferenceSet(articleId, nextSets);
    const id = match?.id ?? "";
    setSelectedId(id);
    if (id) {
      await loadSet(id);
    } else {
      setCurrentSet(null);
      setResult(null);
    }
  }

  async function loadArticleSets(nextId?: string) {
    const [nextSets, referenceSets] = await Promise.all([
      fetchArticleSetSummaries(),
      fetchReferenceSetSummaries(),
    ]);
    const id = nextId || selectedArticleId || nextSets[0]?.id || "";
    if (id) {
      setSelectedArticleId(id);
      await loadArticleSet(id);
      await loadMatchingReferenceSet(id, referenceSets);
    } else {
      setSelectedArticleId("");
      setSelectedId("");
      setCurrentArticle(null);
      setCurrentSet(null);
      setResult(null);
    }
  }

  async function loadSet(id: string) {
    const res = await fetch(`/api/reference/sets/${encodeURIComponent(id)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Failed to load JSON");
    setCurrentSet(data);
    setResult(null);
  }

  async function loadArticleSet(id: string) {
    const res = await fetch(`/api/article/sets/${encodeURIComponent(id)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Failed to load article JSON");
    setCurrentArticle(data);
    setResult(null);
  }

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus(null));
    loadArticleSets().catch(() => undefined);
  }, []);

  async function saveResult(nextResult: QueryResultUnion) {
    const res = await fetch("/api/session/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, result: nextResult }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Failed to save Markdown");
    setSavedFile(data.file ?? "");
  }

  async function search() {
    if (!query.trim() || busy) return;
    if (searchMode === "reference" && !currentSet) return;
    if (searchMode === "article" && !currentArticle) return;
    if (searchMode === "integrated" && (!currentArticle || !currentSet)) return;
    setBusy(translate ? "Translating & searching..." : "Searching...");
    setError("");
    try {
      const endpoint =
        searchMode === "article"
          ? "/api/article/query"
          : searchMode === "integrated"
            ? "/api/integrated/query"
            : "/api/reference/query";
      const payload =
        searchMode === "article"
          ? { articleId: currentArticle?.id, query: query.trim(), topK, translate }
          : searchMode === "integrated"
            ? { articleId: currentArticle?.id, referenceSetId: currentSet?.id, query: query.trim(), topK, translate }
            : { setId: currentSet?.id, query: query.trim(), topK, translate };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Search failed");
      setResult(data);
      await saveResult(data);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy("");
    }
  }

  function onQueryKey(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      search();
    }
  }

  return (
    <ReferenceMapContext.Provider value={referenceMap}>
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo-mark">R</span>
          <div>
            <h1>Reference Abstract RAG</h1>
            <p className="subtitle">HTML references → PubMed abstracts → JSON search</p>
          </div>
        </div>
        <div className="status">
          <button
            className="theme-toggle"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            aria-label="Toggle theme"
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          {status?.hasApiKey ? <span className="badge badge-ok">API ready</span> : <span className="badge badge-warn">API key</span>}
        </div>
      </header>

      <main className="workspace">
        <section className="tool-panel">
          <div className="panel-head">
            <h2>Datasets</h2>
            <span className="panel-note">Bookmarklet input</span>
          </div>

          <div className="dataset-picker">
            <label className="field">
              <span>Article JSON</span>
              <select
                value={selectedArticleId}
                onChange={(e) => {
                  const id = e.target.value;
                  setSelectedArticleId(id);
                  if (id) {
                    loadArticleSet(id)
                      .then(() => loadMatchingReferenceSet(id))
                      .catch((err) => setError(String(err?.message ?? err)));
                  } else {
                    setCurrentArticle(null);
                    setSelectedId("");
                    setCurrentSet(null);
                    setResult(null);
                  }
                }}
              >
                <option value="">None</option>
                {articleSets.map((set) => (
                  <option key={set.id} value={set.id}>
                    {datasetLabel(set.id)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Reference JSON</span>
              <div className={selectedId ? "dataset-value" : "dataset-value muted-dataset-value"}>
                {selectedId ? datasetLabel(selectedId) : "No matching JSON"}
              </div>
            </label>
            <button className="ghost refresh-btn" onClick={() => { loadArticleSets().catch((err) => setError(String(err?.message ?? err))); }}>
              Refresh list
            </button>
          </div>
        </section>

        <section className="main-panel">
          {busy && <div className="loading inline-loading"><div className="spinner" /><span>{busy}</span></div>}
          {error && <div className="error">{error}</div>}

          {currentSet || currentArticle ? (
            <>
              <div className="dataset-summary">
                <div>
                  <h2>{currentArticle?.title || currentSet?.title || currentSet?.id}</h2>
                  <p>{currentArticle?.sourceUrl || currentSet?.sourceUrl}</p>
                </div>
                <div className="summary-grid">
                  <div><strong>{currentArticle?.sections.length ?? 0}</strong><span>sections</span></div>
                  <div><strong>{currentArticle?.chunkCount ?? 0}</strong><span>paragraphs</span></div>
                  <div>
                    <strong>
                      {currentSet?.abstractFound ?? 0}
                      <span className="summary-subvalue">/{currentSet?.totalReferences ?? 0}</span>
                    </strong>
                    <span>abstract</span>
                  </div>
                </div>
              </div>

              <section className="query-panel embedded-query">
                <textarea
                  className="query-input"
                  placeholder="Enter your question"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onQueryKey}
                  rows={3}
                />
                <div className="controls">
                  <label className="ctrl">
                    Scope
                    <select value={searchMode} onChange={(e) => setSearchMode(e.target.value as SearchMode)}>
                      <option value="integrated">Integrated</option>
                      <option value="article">Article</option>
                      <option value="reference">Abstract</option>
                    </select>
                  </label>
                  <label className="ctrl">
                    <input type="checkbox" checked={translate} onChange={(e) => setTranslate(e.target.checked)} />
                    JA→EN
                  </label>
                  <label className="ctrl">
                    Top-K
                    <input className="topk" type="number" min={1} max={20} value={topK} onChange={(e) => setTopK(Number(e.target.value))} />
                  </label>
                  <button
                    className="primary"
                    onClick={search}
                    disabled={
                      Boolean(busy) ||
                      !query.trim() ||
                      (searchMode === "article" && !currentArticle) ||
                      (searchMode === "reference" && !currentSet) ||
                      (searchMode === "integrated" && (!currentArticle || !currentSet))
                    }
                  >
                    Search
                  </button>
                </div>
              </section>

              {currentArticle && <ArticleContentBrowser article={currentArticle} />}

              {result && (
                <section className="result">
                  <div className="answer-card">
                    <div className="answer-head">
                      <h2>Answer</h2>
                      {result.enQuery !== result.originalQuery && <span className="trans">EN: {result.enQuery}</span>}
                    </div>
                    {"articleAnswer" in result ? (
                      <div className="answer-split">
                        <AnswerBlock title="Main Article" text={result.articleAnswer} cite />
                        <AnswerBlock title="Reference Abstracts" text={result.referenceAnswer} cite />
                      </div>
                    ) : (
                      <MarkdownText className="answer-text" text={result.answer} cite />
                    )}
                    {savedFile && <div className="saved-note">Saved: {savedFile}</div>}
                  </div>
                  {"articleAnswer" in result ? (
                    <IntegratedSources sources={result.sources} />
                  ) : (
                    <>
                      <div className="sources-head">
                        <h2>Sources ({result.sources.length})</h2>
                      </div>
                      <div className="sources">
                        {"articleId" in result
                          ? result.sources.map((source, idx) => (
                              <ArticleResultSource key={`${source.section}-${source.subsection}-${source.paragraphIndex}-${idx}`} source={source} idx={idx} />
                            ))
                          : result.sources.map((source, idx) => (
                              <ResultSource key={`${source.pmid}-${idx}`} source={source} idx={idx} />
                            ))}
                      </div>
                    </>
                  )}
                </section>
              )}

              {currentSet && (
                <>
                  <div className="sources-head">
                    <h2>References ({currentSet.records.length})</h2>
                  </div>
                  <div className="ref-list">
                    {currentSet.records.map((record) => (
                      <ReferenceRow key={`${record.index}-${record.pmid}-${record.href}`} record={record} />
                    ))}
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="empty-state">
              <h2>No JSON selected</h2>
              <p>Enter an article page URL, or select a saved JSON.</p>
            </div>
          )}
        </section>
      </main>
    </div>
    </ReferenceMapContext.Provider>
  );
}
