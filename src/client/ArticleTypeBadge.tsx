// 主論文の種別バッジ（PubMed の Publication Type による Original / Review）。未分類なら何も出さない。
import { MAIN_ARTICLE_TYPE_LABEL, type MainArticleType } from "../shared/articleType.js";

export function ArticleTypeBadge({ type }: { type?: MainArticleType | null }) {
  if (!type) return null;
  return <span className={`ref-type ref-type-${type}`}>{MAIN_ARTICLE_TYPE_LABEL[type]}</span>;
}
