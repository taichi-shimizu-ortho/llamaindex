import { ArticleSection, ArticleSet, ArticleSubsection } from "./articleHarvester.js";
import { ReferenceRecord } from "./referenceHarvester.js";

function decodeHtmlEntities(s: string): string {
  const named: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
  return s
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (match, code) => {
      const value = code.toLowerCase().startsWith("x") ? parseInt(code.slice(1), 16) : parseInt(code, 10);
      return Number.isFinite(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : match;
    })
    .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match);
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanJatsText(html: string): string {
  let cited = html.replace(/<xref\b[^>]*ref-type=["']bibr["'][^>]*>([\s\S]*?)<\/xref>/gi, "[$1]");
  return stripTags(cited);
}

function extractTagContent(xml: string, tag: string): string[] {
  const results: string[] = [];
  const regex = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  let match;
  while ((match = regex.exec(xml)) !== null) {
    results.push(match[1]);
  }
  return results;
}

export function parseJatsArticle(jatsXml: string, baseInfo: { id: string, sourceUrl: string, title?: string }): Partial<ArticleSet> | null {
  if (!jatsXml.includes("<article") || !jatsXml.includes("<body")) return null;

  const articleMetaMatch = jatsXml.match(/<article-meta[^>]*>([\s\S]*?)<\/article-meta>/i);
  const articleMeta = articleMetaMatch ? articleMetaMatch[1] : "";

  let title = baseInfo.title;
  if (!title) {
    const titleMatch = articleMeta.match(/<article-title[^>]*>([\s\S]*?)<\/article-title>/i);
    if (titleMatch) title = stripTags(titleMatch[1]);
  }

  const doiMatch = articleMeta.match(/<article-id[^>]*pub-id-type=["']doi["'][^>]*>([\s\S]*?)<\/article-id>/i);
  const doi = doiMatch ? stripTags(doiMatch[1]).trim() : "";

  let year = "";
  const pubDateMatch = articleMeta.match(/<pub-date[^>]*>([\s\S]*?)<\/pub-date>/i);
  if (pubDateMatch) {
    const pubXml = pubDateMatch[1];
    const y = pubXml.match(/<year[^>]*>([\s\S]*?)<\/year>/i)?.[1];
    let m = pubXml.match(/<month[^>]*>([\s\S]*?)<\/month>/i)?.[1];
    let d = pubXml.match(/<day[^>]*>([\s\S]*?)<\/day>/i)?.[1];
    const cleanY = y ? stripTags(y).trim() : "";
    const cleanM = m ? stripTags(m).trim().padStart(2, "0") : "";
    const cleanD = d ? stripTags(d).trim().padStart(2, "0") : "";
    
    const parts = [cleanY, cleanM, cleanD].filter(Boolean);
    if (parts.length > 0) {
      year = parts.join("-"); // e.g. 2026-06 or 2026-06-20
    }
  }

  const authors: string[] = [];
  const contribMatch = articleMeta.match(/<contrib-group[^>]*>([\s\S]*?)<\/contrib-group>/i);
  if (contribMatch) {
    const contribs = extractTagContent(contribMatch[1], "contrib");
    for (const c of contribs) {
      if (c.includes('contrib-type="author"') || c.includes("contrib-type='author'")) {
        const surnameMatch = c.match(/<surname[^>]*>([\s\S]*?)<\/surname>/i);
        const givenMatch = c.match(/<given-names[^>]*>([\s\S]*?)<\/given-names>/i);
        if (surnameMatch && givenMatch) {
          authors.push(`${stripTags(givenMatch[1]).trim()} ${stripTags(surnameMatch[1]).trim()}`);
        } else if (surnameMatch) {
          authors.push(stripTags(surnameMatch[1]).trim());
        }
      }
    }
  }

  const sections: ArticleSection[] = [];

  const abstractMatch = articleMeta.match(/<abstract[^>]*>([\s\S]*?)<\/abstract>/i);
  if (abstractMatch) {
    const absContent = abstractMatch[1];
    const secMatches = extractTagContent(absContent, "sec");
    const abstractSubsections: ArticleSubsection[] = [];
    if (secMatches.length > 0) {
      for (const sec of secMatches) {
        const titleMatch = sec.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const secTitle = titleMatch ? stripTags(titleMatch[1]) : "Abstract";
        const paragraphs = extractTagContent(sec, "p").map(cleanJatsText);
        if (paragraphs.length > 0) {
          abstractSubsections.push({ title: secTitle, content: paragraphs.join(" "), paragraphs });
        }
      }
    } else {
      const paragraphs = extractTagContent(absContent, "p").map(cleanJatsText);
      if (paragraphs.length > 0) {
        abstractSubsections.push({ title: "Abstract", content: paragraphs.join(" "), paragraphs });
      }
    }
    if (abstractSubsections.length > 0) {
      if (abstractSubsections.length === 1 && abstractSubsections[0].title === "Abstract") {
        sections.push({
          title: "Abstract", type: "abstract",
          content: abstractSubsections[0].content,
          paragraphs: abstractSubsections[0].paragraphs,
          subsections: [],
        });
      } else {
        sections.push({
          title: "Abstract", type: "abstract",
          content: abstractSubsections.map(s => s.content).join("\n"),
          paragraphs: [],
          subsections: abstractSubsections,
        });
      }
    }
  }

  const bodyMatch = jatsXml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    const bodyContent = bodyMatch[1];
    
    // Check if there is text before the first <sec> (usually Introduction)
    const firstSecMatch = bodyContent.match(/<sec\b/i);
    const beforeSecContent = firstSecMatch ? bodyContent.substring(0, firstSecMatch.index) : bodyContent;
    const introParagraphs = extractTagContent(beforeSecContent, "p").map(cleanJatsText);
    if (introParagraphs.length > 0) {
      sections.push({
        title: "Introduction",
        type: "body",
        content: introParagraphs.join("\n"),
        paragraphs: introParagraphs,
        subsections: []
      });
    }
    
    // Depth-aware extractor for top-level <sec>
    const getTopLevelSecs = (xml: string): string[] => {
      const secs: string[] = [];
      let depth = 0;
      let start = -1;
      const regex = /<\/?sec\b[^>]*>/gi;
      let match;
      while ((match = regex.exec(xml)) !== null) {
        if (match[0].startsWith("</")) {
          depth--;
          if (depth === 0 && start !== -1) {
            secs.push(xml.slice(start, match.index));
            start = -1;
          }
        } else {
          if (depth === 0) {
            start = match.index + match[0].length;
          }
          depth++;
        }
      }
      return secs;
    };

    const topSecs = getTopLevelSecs(bodyContent);
    for (const secContent of topSecs) {
      const titleMatch = secContent.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const secTitle = titleMatch ? stripTags(titleMatch[1]) : "Section";
      
      const subSecs = getTopLevelSecs(secContent); // Sub-sections are top-level within this sec
      let contentNoSubSec = secContent;
      for (const sub of subSecs) {
        contentNoSubSec = contentNoSubSec.replace(sub, "");
      }
      const paragraphs: string[] = [];
      paragraphs.push(...extractTagContent(contentNoSubSec, "p").map(cleanJatsText));

      const subsections: ArticleSubsection[] = [];
      for (const sub of subSecs) {
        const subTitleMatch = sub.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const subTitle = subTitleMatch ? stripTags(subTitleMatch[1]) : "";
        const subParagraphs = extractTagContent(sub, "p").map(cleanJatsText);
        if (subTitle && subParagraphs.length > 0) {
          subsections.push({ title: subTitle, content: subParagraphs.join(" "), paragraphs: subParagraphs });
        }
      }

      sections.push({ title: secTitle, type: "body", content: paragraphs.join("\n"), paragraphs, subsections });
    }
  }

  const parseTables = (xml: string) => {
    const tws = extractTagContent(xml, "table-wrap");
    for (const tw of tws) {
      const labelMatch = tw.match(/<label[^>]*>([\s\S]*?)<\/label>/i);
      const label = labelMatch ? stripTags(labelMatch[1]) : "Table";
      const capMatch = tw.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i);
      const caption = capMatch ? cleanJatsText(capMatch[1]) : "";
      
      const tableMatch = tw.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
      if (!tableMatch) continue;
      const tableRows = extractTagContent(tableMatch[1], "tr");

      // JATSは空のスタブセル（表の左上）を <th/> のように自己閉じで書くため、
      // 閉じタグを必須にするとセルが1つ消え、行全体が左にずれる。
      // colspan はmarkdownで結合できないので、その分の空セルを足して桁を保つ。
      const rows: string[][] = [];
      for (const tr of tableRows) {
        const cellRegex = /<(th|td)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/gi;
        const cells: string[] = [];
        let cellMatch;
        while ((cellMatch = cellRegex.exec(tr)) !== null) {
          cells.push(cleanJatsText(cellMatch[3] ?? "").replace(/\|/g, ""));
          const span = Number(cellMatch[2]?.match(/colspan=["'](\d+)["']/i)?.[1] ?? 1);
          for (let k = 1; k < span; k++) cells.push("");
        }
        if (cells.length) rows.push(cells);
      }

      // 全行を最大列数に合わせる。markdownは行ごとの列数の不一致を表現できない。
      const mdRows: string[] = [];
      if (rows.length) {
        const width = Math.max(...rows.map((r) => r.length));
        const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
        rows.forEach((r, i) => {
          mdRows.push(`| ${pad(r).join(" | ")} |`);
          if (i === 0) mdRows.push(`| ${Array(width).fill("---").join(" | ")} |`);
        });
      }
      if (mdRows.length) {
        sections.push({
          title: label,
          type: "table",
          content: `${label}. ${caption}\n${mdRows.join("\n")}`,
          paragraphs: [`${label}. ${caption}\n${mdRows.join("\n")}`],
          subsections: []
        });
      }
    }
  };
  parseTables(jatsXml);

  const parseFigures = (xml: string) => {
    const figs = extractTagContent(xml, "fig");
    for (const fig of figs) {
      const labelMatch = fig.match(/<label[^>]*>([\s\S]*?)<\/label>/i);
      const label = labelMatch ? stripTags(labelMatch[1]) : "Figure";
      const capMatch = fig.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i);
      const caption = capMatch ? cleanJatsText(capMatch[1]) : "";
      
      const graphicMatch = fig.match(/<graphic\b[^>]*xlink:href=["']([^"']+)["'][^>]*>/i);
      const url = graphicMatch ? graphicMatch[1] : "";
      
      if (url) {
        const mdText = `[Image URL: ${url}]`;
        sections.push({
          title: label,
          type: "figure",
          content: `${label}. ${caption}\n${mdText}`,
          paragraphs: [`${label}. ${caption}`, mdText],
          subsections: []
        });
      }
    }
  };
  parseFigures(jatsXml);

  return {
    id: baseInfo.id,
    sourceUrl: baseInfo.sourceUrl,
    title: title || "",
    authors,
    doi,
    year,
    sections,
    extractionSource: "sage-jats",
    createdAt: new Date().toISOString()
  };
}

export function parseJatsReferences(jatsXml: string): Partial<ReferenceRecord>[] {
  const results: Partial<ReferenceRecord>[] = [];
  const refListMatch = jatsXml.match(/<ref-list[^>]*>([\s\S]*?)<\/ref-list>/i);
  if (!refListMatch) return results;

  const refs = extractTagContent(refListMatch[1], "ref");
  for (const ref of refs) {
    const textMatch = ref.match(/<mixed-citation[^>]*>([\s\S]*?)<\/mixed-citation>/i) || ref.match(/<element-citation[^>]*>([\s\S]*?)<\/element-citation>/i);
    const text = textMatch ? stripTags(textMatch[1]).trim() : stripTags(ref).trim();
    
    let doi = "";
    const doiMatch = ref.match(/<pub-id[^>]*pub-id-type=["']doi["'][^>]*>([\s\S]*?)<\/pub-id>/i);
    if (doiMatch) doi = stripTags(doiMatch[1]).trim();
    
    let pmid = "";
    const pmidMatch = ref.match(/<pub-id[^>]*pub-id-type=["']pmid["'][^>]*>([\s\S]*?)<\/pub-id>/i);
    if (pmidMatch) pmid = stripTags(pmidMatch[1]).trim();

    results.push({
      text,
      doi,
      pmid
    });
  }
  return results;
}
