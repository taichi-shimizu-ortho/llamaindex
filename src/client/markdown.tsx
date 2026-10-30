// 本文・回答のマークダウン描画と、引用番号（[12] など）の参照文献リンク化。
import { createContext, Fragment, useContext } from "react";
import type { ReactNode } from "react";
import type { ReferenceRecord } from "./types.js";

// 本文中の引用番号 [83] / [ 1 , 2 ] を参照文献メタデータに紐付けるための索引。
export const ReferenceMapContext = createContext<Map<number, ReferenceRecord>>(new Map());

// 数字・空白・カンマ・セミコロン・ダッシュのみで構成された角括弧/丸括弧（[14/167 patients] のような非引用は除外）。
const CITATION_GROUP = /(?:\[\s*\d[\d\s,;–—-]*\]|\(\s*\d[\d\s,;–—-]*\))/g;

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

// 引用グループ内の番号を個別に展開する。
// カンマ/セミコロン/空白区切りに加え、範囲指定（14-17, 14–17）も 14,15,16,17 に展開する。
function expandCitationNumbers(inner: string): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const push = (n: number) => {
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  };
  const tokens = inner.match(/\d+\s*[–—-]\s*\d+|\d+/g) ?? [];
  for (const token of tokens) {
    const range = token.match(/^(\d+)\s*[–—-]\s*(\d+)$/);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a <= b && b - a <= 200) {
        for (let n = a; n <= b; n++) push(n);
      } else {
        push(a);
        push(b);
      }
    } else {
      push(Number(token));
    }
  }
  return out;
}

// [14; 15; 16; 17] や [14-17] / (14-17) のような複数・範囲指定は 1件ずつに分けて表示する。
function renderCitationGroup(group: string, refMap: Map<number, ReferenceRecord>, keyBase: string): ReactNode {
  const numbers = expandCitationNumbers(group.slice(1, -1));
  if (!numbers.length) return <Fragment key={keyBase}>{group}</Fragment>;

  // 数字が実際に referenceMap に存在する場合のみ引用リンクとしてレンダリングする。
  // これにより (1) などの通常の括弧付き数字が誤って引用化されるのを防ぐ。
  const hasValidRef = numbers.some((n) => refMap.has(n));
  if (!hasValidRef) return <Fragment key={keyBase}>{group}</Fragment>;

  const isParenthesis = group.startsWith("(");
  const openBracket = isParenthesis ? "(" : "[";
  const closeBracket = isParenthesis ? ")" : "]";

  return (
    <span className="cite-group" key={keyBase}>
      {numbers.map((n, idx) => (
        <span className="cite-item" key={idx}>
          {openBracket}
          <Citation n={n} record={refMap.get(n)} />
          {closeBracket}
        </span>
      ))}
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
  return text.split(/(\*\*[^*]+\*\*)/g).flatMap((part, idx): ReactNode[] => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return [<strong key={`${keyBase}-b${idx}`}>{part.slice(2, -2)}</strong>];
    }
    return cite
      ? renderCitations(part, refMap, `${keyBase}-${idx}`)
      : [<Fragment key={`${keyBase}-${idx}`}>{part}</Fragment>];
  });
}

function renderMarkdownLine(text: string, refMap: Map<number, ReferenceRecord>, cite: boolean): ReactNode[] {
  return text.split("\n").flatMap((line, idx): ReactNode[] => {
    const nodes = renderInline(line, refMap, cite, `l${idx}`);
    return idx === 0 ? nodes : [<br key={`br-${idx}`} />, ...nodes];
  });
}

// 本文段落（ソース表示）向け: 引用番号のみをリンク化する軽量レンダラー。
export function CitedText({ className, text }: { className?: string; text: string }) {
  const refMap = useContext(ReferenceMapContext);
  if (text.trim().startsWith("|") || text.includes("\n|")) {
    return <MarkdownText className={className} text={text} cite />;
  }
  return <span className={className}>{renderCitations(text, refMap, "ct")}</span>;
}

export function MarkdownText({ className, text, cite = false }: { className?: string; text: string; cite?: boolean }) {
  const refMap = useContext(ReferenceMapContext);
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let tableRows: string[][] = [];
  let hasHeader = false;

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

  let tableCaption: string | null = null;
  function flushTable() {
    if (!tableRows.length) return;
    const rowsToRender = [...tableRows];
    tableRows = [];
    
    let headerRow: string[] | null = null;
    if (hasHeader && rowsToRender.length > 0) {
      headerRow = rowsToRender.shift()!;
    }
    const maxCols = Math.max(headerRow?.length || 0, ...rowsToRender.map(r => r.length));
    hasHeader = false;

    blocks.push(
      <div className="table-container" key={`table-${blocks.length}`}>
        <table className="markdown-table">
          {tableCaption && <caption>{renderInline(tableCaption, refMap, cite, `cap`)}</caption>}
          {headerRow && (
            <thead>
              <tr>
                {headerRow.map((cell, idx) => (
                  <th key={`th-${idx}`} colSpan={idx === headerRow!.length - 1 && headerRow!.length < maxCols ? maxCols - headerRow!.length + 1 : 1}>{renderInline(cell, refMap, cite, `th-${idx}`)}</th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {rowsToRender.map((row, rIdx) => (
              <tr key={`tr-${rIdx}`}>
                {row.map((cell, cIdx) => (
                  <td key={`td-${cIdx}`} colSpan={cIdx === row.length - 1 && row.length < maxCols ? maxCols - row.length + 1 : 1}>{renderInline(cell, refMap, cite, `td-${rIdx}-${cIdx}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
    tableCaption = null;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const listMatch = line.match(/^\s*[-*]\s+(.+)$/);
    const isTableLine = line.trim().startsWith("|");
    const captionMatch = line.match(/^(?:Table|Figure)\s+\d+[^:]*:\s*(.+)$/i) || line.match(/^(?:Table|Figure)\s+\d+\..+$/i);

    if (!line.trim()) {
      flushParagraph();
      flushList();
      flushTable();
    } else if (isTableLine) {
      if (paragraph.length === 1 && paragraph[0].match(/^(?:Table|Figure)\s+\d+/i)) {
         tableCaption = paragraph[0];
         paragraph = [];
      }
      flushParagraph();
      flushList();
      if (line.replace(/[\s:|:-]/g, "") === "") {
        hasHeader = true;
      } else {
        const cells = line.split("|").slice(1, -1).map((c) => c.trim());
        tableRows.push(cells);
      }
    } else if (listMatch) {
      flushParagraph();
      flushTable();
      listItems.push(listMatch[1]);
    } else {
      flushList();
      flushTable();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  flushTable();

  return <div className={className}>{blocks}</div>;
}
