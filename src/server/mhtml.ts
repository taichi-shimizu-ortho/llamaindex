// ブラウザ（Chrome の「ページを保存 > ウェブページ、1 つのファイル」）が書く MHTML から、
// 論文ページ本体の HTML と元URLを取り出す。
// MHTML は multipart/related の MIME で、先頭の text/html パートがメインフレーム。
// 画像やCSSの別パートは使わない（図は HTML 内の元URLを参照する）。
import fs from "node:fs";

export interface MhtmlPage {
  html: string;
  // Snapshot-Content-Location（保存したページのURL）
  sourceUrl: string;
  // 保存日時（Date ヘッダ）。読めなければ空
  savedAt: string;
}

// ヘッダ部（折り返し行を連結）を小文字キーの辞書にする。
function parseHeaders(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of block.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (m) headers[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return headers;
}

function splitHead(part: string): { headers: Record<string, string>; body: string } {
  const m = /\r?\n\r?\n/.exec(part);
  if (!m) return { headers: parseHeaders(part), body: "" };
  return { headers: parseHeaders(part.slice(0, m.index)), body: part.slice(m.index + m[0].length) };
}

function decodeQuotedPrintable(body: string): Buffer {
  const joined = body.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i];
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      // 本文は QP 化された ASCII なので1文字1バイトで足りる
      bytes.push(joined.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function decodeBody(body: string, encoding: string): Buffer {
  const enc = encoding.toLowerCase();
  if (enc === "quoted-printable") return decodeQuotedPrintable(body);
  if (enc === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64");
  return Buffer.from(body, "latin1");
}

function charsetOf(contentType: string): string {
  return /charset="?([^";\s]+)"?/i.exec(contentType)?.[1]?.toLowerCase() ?? "utf-8";
}

export function readMhtml(filePath: string): MhtmlPage {
  // 本文パートは 7bit/QP/base64 なので latin1 で読めばバイトを壊さず分割できる
  const raw = fs.readFileSync(filePath).toString("latin1");
  const top = splitHead(raw);
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(top.headers["content-type"] ?? "")?.[1];
  if (!boundary) throw new Error(`Not an MHTML file (no multipart boundary): ${filePath}`);
  const sourceUrl = top.headers["snapshot-content-location"] ?? "";

  const parts = top.body.split(`--${boundary}`).slice(1).map(splitHead);
  const htmlParts = parts.filter((p) => /^text\/html/i.test(p.headers["content-type"] ?? ""));
  // 同じ text/html でも iframe のパートがあるので、元URLと一致するものを優先する
  const main = htmlParts.find((p) => sourceUrl && p.headers["content-location"] === sourceUrl) ?? htmlParts[0];
  if (!main) throw new Error(`No HTML part in MHTML: ${filePath}`);

  const bytes = decodeBody(main.body, main.headers["content-transfer-encoding"] ?? "");
  const charset = charsetOf(main.headers["content-type"] ?? "");
  const html = new TextDecoder(charset === "utf8" ? "utf-8" : charset).decode(bytes);
  const date = new Date(top.headers["date"] ?? "");
  return {
    html,
    sourceUrl: sourceUrl || main.headers["content-location"] || "",
    savedAt: Number.isNaN(date.getTime()) ? "" : date.toISOString(),
  };
}
