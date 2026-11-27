// 出版社や PMC は自動取得に対して論文ではなくボット確認ページを返すことがある。
// それを論文として取り込むと <title>（"Checking your browser - reCAPTCHA" など）が論文ID・題名になり、
// 同じ題名の別論文どうしが同じIDに上書きされる。
// 論文の題名と取り違えないよう、題名の先頭で判定する（reCAPTCHA だけは位置を問わない）。
const BOT_CHECK_TITLE =
  /^\s*(?:checking your browser|just a moment|attention required|are you a robot|verify(?:ing)? you are human)|recaptcha/i;

export function isBotCheckPage(html: string): boolean {
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  return BOT_CHECK_TITLE.test(title.replace(/<[^>]+>/g, " "));
}

export function assertNotBotCheckPage(html: string, sourceUrl: string): void {
  if (!isBotCheckPage(html)) return;
  throw new Error(
    `${sourceUrl || "The page"} is a bot-check page, not the article. Open the article in a browser, save it as MHTML, and import that file.`,
  );
}
