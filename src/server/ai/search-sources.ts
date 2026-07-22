export interface SearchableSource {
  id: string;
  type: "decision" | "transcript" | "document";
  title: string;
  content: string;
  meetingTimestampMs: number | null;
}

export interface LexicalSourceScore {
  source: SearchableSource;
  rawScore: number;
  normalizedScore: number;
  titleMatchCount: number;
  bodyMatchCount: number;
  matchedTitleTokens: string[];
}

const normalize = (value: string) =>
  value
    .toLocaleLowerCase("ko-KR")
    .replace(/[^0-9a-z가-힣]+/gi, " ")
    .trim();

const tokens = (value: string) => [
  ...new Set(
    normalize(value)
      .split(/\s+/)
      .filter((token) => token.length >= 2),
  ),
];

const expandedTokens = (question: string) =>
  [
    ...new Set(
      tokens(question).flatMap((token) =>
        token.length >= 4 && /^[가-힣]+$/.test(token) ? [token, token.slice(0, 2)] : [token],
      ),
    ),
  ];

export function compareSourcesByTitleAndId(
  left: SearchableSource,
  right: SearchableSource,
): number {
  const leftTitle = normalize(left.title);
  const rightTitle = normalize(right.title);
  if (leftTitle < rightTitle) return -1;
  if (leftTitle > rightTitle) return 1;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

export function scoreSourceLexically(
  question: string,
  source: SearchableSource,
): LexicalSourceScore {
  const query = expandedTokens(question);
  const title = normalize(source.title);
  const body = normalize(source.content);
  const matchedTitleTokens = query.filter((token) => title.includes(token));
  const bodyMatchCount = query.filter((token) => body.includes(token)).length;
  const titleMatchCount = matchedTitleTokens.length;
  const rawScore = titleMatchCount * 4 + bodyMatchCount;

  return {
    source,
    rawScore,
    normalizedScore:
      query.length === 0 ? 0 : Math.min(rawScore / (query.length * 5), 1),
    titleMatchCount,
    bodyMatchCount,
    matchedTitleTokens,
  };
}

export function isStrongLexicalFallback(score: LexicalSourceScore): boolean {
  const strongTitleMatch =
    score.titleMatchCount >= 2 ||
    score.matchedTitleTokens.some((token) => token.length >= 4);
  const boundedLexicalMatch =
    score.normalizedScore >= 0.2 &&
    (score.titleMatchCount >= 1 || score.bodyMatchCount >= 2);
  return strongTitleMatch || boundedLexicalMatch;
}

export function searchStrongLexicalSources(
  question: string,
  sources: readonly SearchableSource[],
  limit = 5,
): SearchableSource[] {
  return sources
    .map((source) => scoreSourceLexically(question, source))
    .filter(isStrongLexicalFallback)
    .sort(
      (left, right) =>
        right.rawScore - left.rawScore || compareSourcesByTitleAndId(left.source, right.source),
    )
    .slice(0, limit)
    .map(({ source }) => source);
}

export function searchSources(
  question: string,
  sources: readonly SearchableSource[],
  limit = 5,
): SearchableSource[] {
  return sources
    .map((source) => scoreSourceLexically(question, source))
    .filter(({ rawScore }) => rawScore > 0)
    .sort(
      (left, right) =>
        right.rawScore - left.rawScore || compareSourcesByTitleAndId(left.source, right.source),
    )
    .slice(0, limit)
    .map(({ source }) => source);
}
