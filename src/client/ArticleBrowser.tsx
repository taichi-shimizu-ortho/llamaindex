// 主論文JSONの本文・図をセクション単位で展開表示するブラウザと、参照文献一覧の行（Preview 画面で使う）。
// RAG の段落から開いたときは、その段落を含むセクションを開いて強調する。
import { classifyArticleType, type ArticleType } from "../shared/articleType.js";
import { CitedText } from "./markdown.js";
import type { ArticleSection, ArticleSet, ArticleSubsection, ReferenceRecord } from "./types.js";

type FigureItem = {
  // 本文中の位置（RAG の段落から図へ飛ぶときに使う）。sub = -1 はセクションそのもの
  section: number;
  sub: number;
  title: string;
  content: string;
  imageUrl: string;
  legend: string;
};

/** 強調する段落の位置。sub = -1 はセクション直下の段落 */
export interface ParagraphLocation {
  section: number;
  sub: number;
  paragraph: number;
}

export const TARGET_PARAGRAPH_ID = "preview-target";

function isFigureLike(item: { title: string; type?: string; content?: string }): boolean {
  return item.type === "figure" || /^figure\s+\d+/i.test(item.title) || /\[Image URL:/i.test(item.content ?? "");
}

function figureFromItem(item: { title: string; content: string; paragraphs?: string[] }, section: number, sub: number): FigureItem {
  const content = item.content || item.paragraphs?.join("\n\n") || "";
  const imageUrl = content.match(/\[Image URL:\s*(.*?)\]/i)?.[1]?.trim() ?? "";
  const legend = content.replace(/\[Image URL:\s*.*?\]/gi, "").trim();
  return {
    section,
    sub,
    title: item.title,
    content,
    imageUrl,
    legend,
  };
}

function collectFigures(article: ArticleSet): FigureItem[] {
  const figures: FigureItem[] = [];

  article.sections.forEach((section, sectionIdx) => {
    if (isFigureLike(section)) figures.push(figureFromItem(section, sectionIdx, -1));
    section.subsections.forEach((subsection, subIdx) => {
      if (isFigureLike(subsection)) figures.push(figureFromItem(subsection, sectionIdx, subIdx));
    });
  });

  const seen = new Set<string>();
  return figures.filter((figure) => {
    const key = `${figure.title}|${figure.legend.slice(0, 100)}|${figure.imageUrl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// RAG の段落（section / subsection の題と、その中での番号）から本文中の位置を探す。
// 段落番号は空段落を除いた数え方なので、本文の一部が一致する段落を優先し、なければ番号で当てる。
export function locateParagraph(
  article: ArticleSet,
  passage: { section: string; subsection: string; paragraphIndex: number; text: string },
): ParagraphLocation | null {
  const section = article.sections.findIndex((s) => s.title === passage.section);
  if (section < 0) return null;
  const sub = passage.subsection
    ? article.sections[section].subsections.findIndex((s) => s.title === passage.subsection)
    : -1;
  if (passage.subsection && sub < 0) return null;
  const paragraphs = sub < 0 ? article.sections[section].paragraphs : article.sections[section].subsections[sub].paragraphs;
  if (!paragraphs.length) return null;

  const probe = normalize(passage.text).slice(10, 70);
  const byText = probe.length >= 20 ? paragraphs.findIndex((p) => normalize(p).includes(probe)) : -1;
  const paragraph = byText >= 0 ? byText : Math.min(Math.max(passage.paragraphIndex - 1, 0), paragraphs.length - 1);
  return { section, sub, paragraph };
}

function sectionParagraphCount(section: ArticleSection): number {
  return section.paragraphs.length + section.subsections.filter((sub) => !isFigureLike(sub)).reduce((n, sub) => n + sub.paragraphs.length, 0);
}

function ParagraphList({ paragraphs, target = -1 }: { paragraphs: string[]; target?: number }) {
  return (
    <div className="article-paragraphs">
      {paragraphs.map((paragraph, idx) => (
        <div
          className={idx === target ? "article-paragraph target" : "article-paragraph"}
          id={idx === target ? TARGET_PARAGRAPH_ID : undefined}
          key={`${idx}-${paragraph.slice(0, 24)}`}
        >
          <span className="paragraph-index">{idx + 1}</span>
          <CitedText text={paragraph} />
        </div>
      ))}
    </div>
  );
}

function SubsectionDropdown({ subsection, target = -1 }: { subsection: ArticleSubsection; target?: number }) {
  return (
    <details className="article-details article-details-nested" open={target >= 0 || undefined}>
      <summary>
        <span className="article-summary-main">{subsection.title}</span>
        <span className="article-summary-meta">{subsection.paragraphs.length} paragraphs</span>
      </summary>
      <ParagraphList paragraphs={subsection.paragraphs} target={target} />
    </details>
  );
}

function SubsectionStack({
  section,
  target,
  skipFigures,
}: {
  section: ArticleSection;
  target?: ParagraphLocation;
  skipFigures: boolean;
}) {
  return (
    <div className="subsection-stack">
      {section.subsections.map((subsection, idx) =>
        skipFigures && isFigureLike(subsection) ? null : (
          <SubsectionDropdown
            key={`${idx}-${subsection.title}`}
            subsection={subsection}
            target={target?.sub === idx ? target.paragraph : -1}
          />
        ),
      )}
    </div>
  );
}

function SectionDropdown({ section, target }: { section: ArticleSection; target?: ParagraphLocation }) {
  const count = sectionParagraphCount(section);
  return (
    <details className="article-details" open={Boolean(target) || undefined}>
      <summary>
        <span className="article-summary-main">{section.title}</span>
        <span className="article-summary-meta">
          {section.type} · {count} paragraphs
        </span>
      </summary>

      <div className="article-section-body">
        {section.paragraphs.length > 0 && (
          <ParagraphList paragraphs={section.paragraphs} target={target?.sub === -1 ? target.paragraph : -1} />
        )}
        {section.subsections.length > 0 && <SubsectionStack section={section} target={target} skipFigures />}
      </div>
    </details>
  );
}

function FigureBrowser({ figures, target }: { figures: FigureItem[]; target?: ParagraphLocation | null }) {
  if (!figures.length) return null;

  return (
    <div className="figure-browser">
      <div className="article-browser-subhead">
        <h3>Figures</h3>
        <span>{figures.length} figures</span>
      </div>
      <div className="figure-stack">
        {figures.map((figure, idx) => {
          const isTarget = target?.section === figure.section && target.sub === figure.sub;
          return (
            <details
              className={isTarget ? "article-details figure-details target" : "article-details figure-details"}
              id={isTarget ? TARGET_PARAGRAPH_ID : undefined}
              open={isTarget || undefined}
              key={`${figure.title}-${idx}`}
            >
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
          );
        })}
      </div>
    </div>
  );
}

export function ArticleContentBrowser({ article, target }: { article: ArticleSet; target?: ParagraphLocation | null }) {
  const figures = collectFigures(article);
  const sections = article.sections.map((section, idx) => ({ section, idx }));
  const abstractSections = sections.filter(({ section }) => section.type === "abstract");
  const mainSections = sections.filter(({ section }) => section.type !== "abstract" && !isFigureLike(section));
  const targetFor = (idx: number) => (target?.section === idx ? target : undefined);

  return (
    <section className="article-browser">
      {abstractSections.map(({ section, idx }) => (
        <details className="article-details article-details-abstract" key={`${idx}-${section.title}`} open>
          <summary>
            <span className="article-summary-main">Abstract</span>
            <span className="article-summary-meta">
              {section.paragraphs.length + section.subsections.reduce((n, sub) => n + sub.paragraphs.length, 0)} paragraphs
            </span>
          </summary>
          {section.paragraphs.length > 0 && (
            <ParagraphList paragraphs={section.paragraphs} target={targetFor(idx)?.sub === -1 ? targetFor(idx)!.paragraph : -1} />
          )}
          {section.subsections.length > 0 && <SubsectionStack section={section} target={targetFor(idx)} skipFigures={false} />}
        </details>
      ))}

      <FigureBrowser figures={figures} target={target} />

      <div className="main-text-browser">
        <div className="article-browser-subhead">
          <h3>Main Text</h3>
          <span>{mainSections.length} sections</span>
        </div>
        <div className="section-stack">
          {mainSections.map(({ section, idx }) => (
            <SectionDropdown key={`${idx}-${section.type}-${section.title}`} section={section} target={targetFor(idx)} />
          ))}
        </div>
      </div>
    </section>
  );
}

export type { ArticleType };

// 種別を保存する前に取り込んだ参照文献JSONは publicationTypes だけ持つので、そこから判定する。
export function referenceType(record: ReferenceRecord): ArticleType | undefined {
  const pubmed = record.pubmed;
  if (!pubmed) return undefined;
  return pubmed.articleType ?? (pubmed.publicationTypes?.length ? classifyArticleType(pubmed.publicationTypes) : undefined);
}

export const ARTICLE_TYPE_LABEL: Record<ArticleType, string> = {
  review: "Review",
  original: "Original",
  other: "Other",
};

export function ReferenceRow({ record }: { record: ReferenceRecord }) {
  const abstract = record.pubmed?.abstract ?? "";
  const articleType = referenceType(record);
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
