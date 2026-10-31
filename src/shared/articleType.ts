// 論文種別: review（review/systematic review/scoping review をまとめる）/ original（原著論文）/ other。
// 参照文献の取り込み（サーバ）と、主論文の分類で共有する。
export type ArticleType = "review" | "original" | "other";

export function classifyArticleType(publicationTypes: string[]): ArticleType {
  const types = publicationTypes.map((p) => p.toLowerCase().replace(/-/g, " "));
  if (types.some((p) => p.includes("review"))) return "review";
  if (types.some((p) => p.includes("journal article"))) return "original";
  return "other";
}

// 取り込む主論文は原著か総説のどちらか（コメンタリー・エディトリアル等はそもそも取り込まない方針）なので2分類にする。
// メタアナリシスは総説側に入れる。
export type MainArticleType = "original" | "review";

export const MAIN_ARTICLE_TYPE_LABEL: Record<MainArticleType, string> = {
  original: "Original",
  review: "Review",
};

export function classifyMainArticle(publicationTypes: string[]): MainArticleType {
  const types = publicationTypes.map((p) => p.toLowerCase().replace(/-/g, " "));
  return classifyArticleType(publicationTypes) === "review" || types.some((p) => p.includes("meta analysis"))
    ? "review"
    : "original";
}
