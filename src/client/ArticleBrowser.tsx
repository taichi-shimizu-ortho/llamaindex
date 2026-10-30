// 主論文JSONの本文・図をセクション単位で展開表示するブラウザ。
import { CitedText } from "./markdown.js";
import type { ArticleSet } from "./types.js";

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

export function ArticleContentBrowser({ article }: { article: ArticleSet }) {
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
            <span className="article-summary-meta">
              {section.paragraphs.length + section.subsections.reduce((n, sub) => n + sub.paragraphs.length, 0)} paragraphs
            </span>
          </summary>
          {section.paragraphs.length > 0 && <ParagraphList paragraphs={section.paragraphs} />}
          {section.subsections.length > 0 && (
            <div className="subsection-stack">
              {section.subsections.map((subsection) => (
                <SubsectionDropdown key={subsection.title} subsection={subsection} />
              ))}
            </div>
          )}
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
