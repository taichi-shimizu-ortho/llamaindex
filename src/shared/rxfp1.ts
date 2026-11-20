export const RXFP1_ARTICLE_PREFIX = "rxfp1.";
export const isRxfp1Article = (id: string) => id.startsWith(RXFP1_ARTICLE_PREFIX);
export const rxfp1ArticleId = (citekey: string) => RXFP1_ARTICLE_PREFIX + citekey.replace(/[^A-Za-z0-9_.-]+/g, "_");
