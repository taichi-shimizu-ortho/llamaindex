// 論文種別: review（review/systematic review/scoping review をまとめる）/ original（原著論文）/ other。
// サーバ（参照文献の取り込み）とクライアント（種別が保存されていない古い参照文献JSONの表示）で共有する。
export type ArticleType = "review" | "original" | "other";

export function classifyArticleType(publicationTypes: string[]): ArticleType {
  const types = publicationTypes.map((p) => p.toLowerCase().replace(/-/g, " "));
  if (types.some((p) => p.includes("review"))) return "review";
  if (types.some((p) => p.includes("journal article"))) return "original";
  return "other";
}
