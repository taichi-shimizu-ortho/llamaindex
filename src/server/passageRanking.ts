const STOP = new Set("about after also among and are both can does during each from had has have how into its may more most only other over some such than that the their them then there these they this those through use was were what when where which who will with would".split(" "));
export const searchTerms = (text: string) => new Set(
  (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((term) => term.length > 2 && !STOP.has(term))
    .map((term) => term.length > 4 ? term.replace(/(?<!s)s$/, "") : term),
);

export interface Ranked<T> { item: T; score: number }

export function rankByText<T>(query: string, items: T[], termsOf: (item: T) => Set<string>,
  boost: (item: T) => number = () => 1): Ranked<T>[] {
  const terms = [...searchTerms(query)];
  const candidates = items.map((item) => ({ item, terms: termsOf(item) }));
  const weights = terms.map((term) =>
    Math.log(1 + candidates.length / (1 + candidates.filter((candidate) => candidate.terms.has(term)).length)),
  );
  return candidates.flatMap(({ item, terms: passageTerms }) => {
    const matches = terms.map((term, i) => passageTerms.has(term) ? weights[i] : 0).filter(Boolean);
    if (matches.length < Math.min(2, terms.length) || !matches.length) return [];
    const score = boost(item) * matches.reduce((sum, weight) => sum + weight, 0) / Math.sqrt(12 + passageTerms.size);
    return [{ item, score }];
  }).sort((a, b) => b.score - a.score);
}

export function fusePassageRanks<T>(text: Ranked<T>[], vectors: Ranked<T>[], window: number): Ranked<T>[] {
  if (!vectors.length) return text;
  if (!text.length) return vectors;
  const scores = new Map<T, number>();
  for (const ranking of [vectors, text]) {
    ranking.slice(0, window).forEach(({ item }, i) => {
      scores.set(item, (scores.get(item) ?? 0) + 1 / (60 + i + 1));
    });
  }
  return [...scores].map(([item, score]) => ({ item, score })).sort((a, b) => b.score - a.score);
}
