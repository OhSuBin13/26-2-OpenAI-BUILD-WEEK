# Hybrid Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Task 6's lexical-only source selection with project-scoped lexical and semantic fusion while preserving safe lexical fallback and citation validation.

**Architecture:** `QuestionAnswerService` first loads only the current project's sources and delegates selection to an async `SourceRetrieverPort`. `HybridSourceRetriever` batches the question and uncached source texts through an injected `EmbeddingPort`, caches source vectors in a bounded process-local LRU, combines normalized lexical and cosine scores, and returns only original source objects. `OpenAiEmbeddingClient` owns only the SDK request and response validation; runtime construction remains Task 7.

**Tech Stack:** TypeScript 7, Node.js, Vitest, OpenAI JavaScript SDK 6.47, Zod 4.

## Global Constraints

- Apply semantic retrieval only after `KnowledgeRepository.listProjectSources(projectKey)` resolves.
- Use `text-embedding-3-small`, `OPENAI_EMBEDDING_MODEL=text-embedding-3-small`, and `EMBEDDING_TIMEOUT_MS=3000`.
- Reuse the existing server-only `OPENAI_API_KEY`; never print it or expose it to the browser.
- Tests use fake adapters and make no live OpenAI API request.
- Do not add database columns, migrations, pgvector, document chunking, or runtime `index.ts` wiring.
- Normalize lexical scores to `0..1`, clamp cosine similarity to `0..1`, and compute `finalScore = lexicalScore * 0.4 + semanticScore * 0.6`.
- Filter hybrid results below `0.30`, then return at most five sources.
- Limit each embedding input to 7,500 UTF-8 bytes and each adapter call to 32 inputs.
- Cache only validated source vectors, with 500-entry LRU capacity and a key containing the embedding namespace, source UUID, and SHA-256 of `title + "\n\n" + content`.
- On embedding failure, preserve denominator-independent strong title matches and bounded lexical matches; never pass a weak single-body-token match to Sol.
- Return original `SearchableSource` objects only. Embedding vectors must not enter Sol input, evidence cards, logs, or client events.
- Preserve the pre-existing unstaged `src/server/repositories/repositories.test.ts` change and exclude it from the Task 6 commit.
- Produce one final Task 6 commit after review; do not create intermediate commits.

---

### Task 1: Implement and integrate hybrid retrieval

**Files:**
- Create: `src/server/ai/embedding-client.ts`
- Create: `src/server/ai/embedding-client.test.ts`
- Create: `src/server/ai/source-embedding-cache.ts`
- Create: `src/server/ai/source-embedding-cache.test.ts`
- Create: `src/server/ai/hybrid-source-retriever.ts`
- Create: `src/server/ai/hybrid-source-retriever.test.ts`
- Modify: `src/server/ai/search-sources.ts`
- Modify: `src/server/ai/search-sources.test.ts`
- Modify: `src/server/ai/question-answer-service.ts`
- Modify: `src/server/ai/question-answer-service.test.ts`
- Modify: `src/server/env.ts`
- Modify: `src/server/env.test.ts`
- Modify: `.env.example`
- Keep unchanged: `src/server/ai/sol-analyzer.ts`
- Keep unchanged: `src/server/index.ts`

**Interfaces:**
- Produce:

```ts
export interface EmbeddingPort {
  readonly cacheNamespace: string;
  embed(inputs: readonly string[]): Promise<readonly number[][]>;
}

export interface SourceRetrieverPort {
  retrieve(
    question: string,
    sources: readonly SearchableSource[],
    limit?: number,
  ): Promise<SearchableSource[]>;
}

export class OpenAiEmbeddingClient implements EmbeddingPort {
  constructor(
    client: OpenAI,
    model?: "text-embedding-3-small",
    timeoutMs?: number,
  );
}

export class SourceEmbeddingCache {
  constructor(maxEntries?: number);
  get(key: string): readonly number[] | undefined;
  set(key: string, vector: readonly number[]): void;
}

export class HybridSourceRetriever implements SourceRetrieverPort {
  constructor(embeddings: EmbeddingPort, cache?: SourceEmbeddingCache);
}
```

- Consume: existing `SearchableSource` and `QuestionAnswerService` repository/analyzer ports.
- `QuestionAnswerService` constructor becomes `(knowledge, transcripts, retriever, analyzer)` and awaits `retriever.retrieve(question, all, 5)`.

- [ ] **Step 1: Add failing environment configuration tests**

Extend `src/server/env.test.ts` so the default assertion includes:

```ts
OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
EMBEDDING_TIMEOUT_MS: 3_000,
```

Extend the numeric override test with `EMBEDDING_TIMEOUT_MS: "1200"` and assert `1_200`.

Run:

```bash
npm test -- src/server/env.test.ts
```

Expected: FAIL because both environment fields are absent.

- [ ] **Step 2: Add the embedding environment configuration**

Add to `EnvSchema`:

```ts
OPENAI_EMBEDDING_MODEL: z
  .literal("text-embedding-3-small")
  .default("text-embedding-3-small"),
EMBEDDING_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
```

Add the corresponding defaults to `.env.example`. Re-run the focused environment test and expect PASS.

- [ ] **Step 3: Write failing OpenAI embedding adapter tests**

Create `embedding-client.test.ts` using a fake `client.embeddings.create`. Cover:

1. request model `text-embedding-3-small`, `encoding_format: "float"`, exact input array, an abort signal, and `maxRetries: 0` in request options;
2. response rows returned out of order are restored using `row.index`;
3. empty input, more than 32 inputs, missing indices, non-finite values, inconsistent dimensions, and zero-norm vectors reject without returning a vector; and
4. `cacheNamespace` is `text-embedding-3-small:default`.

Run:

```bash
npm test -- src/server/ai/embedding-client.test.ts
```

Expected: FAIL because `embedding-client.ts` does not exist.

- [ ] **Step 4: Implement `OpenAiEmbeddingClient`**

Create `embedding-client.ts` with these guards and request shape:

```ts
const MAX_BATCH_INPUTS = 32;

const validateVectors = (
  rows: readonly { index: number; embedding: readonly number[] }[],
  expectedLength: number,
) => {
  const ordered = Array.from<readonly number[] | undefined>({ length: expectedLength });
  for (const row of rows) {
    if (!Number.isInteger(row.index) || row.index < 0 || row.index >= expectedLength) {
      throw new Error("EMBEDDING_OUTPUT_INVALID");
    }
    if (ordered[row.index]) throw new Error("EMBEDDING_OUTPUT_INVALID");
    ordered[row.index] = row.embedding;
  }
  if (ordered.some((vector) => !vector)) throw new Error("EMBEDDING_OUTPUT_INVALID");
  const vectors = ordered as readonly (readonly number[])[];
  const dimensions = vectors[0]!.length;
  if (
    dimensions === 0 ||
    vectors.some(
      (vector) =>
        vector.length !== dimensions ||
        vector.some((value) => !Number.isFinite(value)) ||
        vector.every((value) => value === 0),
    )
  ) {
    throw new Error("EMBEDDING_OUTPUT_INVALID");
  }
  return vectors.map((vector) => [...vector]);
};
```

`embed` rejects empty/oversized batches and blank strings, calls:

```ts
this.client.embeddings.create(
  { model: this.model, input: [...inputs], encoding_format: "float" },
  { signal: AbortSignal.timeout(this.timeoutMs), maxRetries: 0 },
);
```

Run the adapter test and expect PASS.

- [ ] **Step 5: Write failing lexical-score and fallback tests**

Extend `search-sources.test.ts` to prove:

1. `scoreSourceLexically` returns the raw score, normalized score, distinct title/body match counts, and matched title tokens using the expanded deduplicated query token set;
2. `isStrongLexicalFallback` accepts a verbose query containing `ADR-007` even when its normalized score is below `0.20`;
3. it accepts a matching title token of length at least four and two distinct title matches;
4. it rejects one short/common title match and one body-only match; and
5. tie-breaking uses normalized title code-unit comparison and UUID rather than locale collation.

Run:

```bash
npm test -- src/server/ai/search-sources.test.ts
```

Expected: FAIL because the scoring and fallback exports do not exist.

- [ ] **Step 6: Refactor lexical scoring without changing the public exact-search behavior**

Add these exports to `search-sources.ts`:

```ts
export interface LexicalSourceScore {
  source: SearchableSource;
  rawScore: number;
  normalizedScore: number;
  titleMatchCount: number;
  bodyMatchCount: number;
  matchedTitleTokens: string[];
}

export function scoreSourceLexically(
  question: string,
  source: SearchableSource,
): LexicalSourceScore;

export function isStrongLexicalFallback(score: LexicalSourceScore): boolean;

export function searchStrongLexicalSources(
  question: string,
  sources: readonly SearchableSource[],
  limit?: number,
): SearchableSource[];

export function compareSourcesByTitleAndId(
  left: SearchableSource,
  right: SearchableSource,
): number;
```

Use the final deduplicated expanded token count as the denominator. `isStrongLexicalFallback` implements:

```ts
const strongTitleMatch =
  score.titleMatchCount >= 2 ||
  score.matchedTitleTokens.some((token) => token.length >= 4);
const boundedLexicalMatch =
  score.normalizedScore >= 0.2 &&
  (score.titleMatchCount >= 1 || score.bodyMatchCount >= 2);
return strongTitleMatch || boundedLexicalMatch;
```

Keep `searchSources` as the existing positive raw-score lexical ranker for its public regression tests. Implement `compareSourcesByTitleAndId` with deterministic normalized-title code-unit comparison followed by UUID, and reuse it in lexical and hybrid ranking instead of locale collation. Run the focused search test and expect PASS.

- [ ] **Step 7: Write failing bounded LRU cache tests**

Create `source-embedding-cache.test.ts` covering:

1. reads return the stored vector;
2. a read refreshes recency;
3. adding the 501st default entry evicts the least recently used entry; and
4. stored and returned vectors cannot be mutated through the caller's array reference.

Run:

```bash
npm test -- src/server/ai/source-embedding-cache.test.ts
```

Expected: FAIL because the cache does not exist.

- [ ] **Step 8: Implement the LRU cache**

Use insertion order in `Map`. `get` deletes and re-inserts a copied vector. `set` stores a copy, refreshes an existing key, and deletes `this.entries.keys().next().value` while size exceeds the positive `maxEntries`. Run the cache test and expect PASS.

- [ ] **Step 9: Write failing hybrid retrieval tests**

Create `hybrid-source-retriever.test.ts` with deterministic fake vectors. Cover:

1. a synonym-only query with zero lexical matches ranks ADR-007 and the June transcript above the `0.30` threshold;
2. the exact PostgreSQL query retains the expected evidence set;
3. the score calculation uses `0.4/0.6`, filters a `0.42` semantic-only source, and filters the unrelated `0.08` source;
4. results are deterministically sorted and capped at five;
5. source embeddings are cached between questions, the question is embedded every time, and title/content changes invalidate the source key;
6. 33 or more total inputs are split into calls of at most 32, with the question only in the first call;
7. every input is at most 7,500 UTF-8 bytes and truncation never splits a Unicode code point;
8. an embedding rejection, missing vector, dimension mismatch, non-finite vector, empty vector, or zero norm uses `searchStrongLexicalSources`;
9. verbose `ADR-007` remains in failure fallback while a weak single-body-token source does not; and
10. returned values are the original source objects and contain no embedding field.

Run:

```bash
npm test -- src/server/ai/hybrid-source-retriever.test.ts
```

Expected: FAIL because the hybrid retriever does not exist.

- [ ] **Step 10: Implement the hybrid retriever**

Create `hybrid-source-retriever.ts` with named constants:

```ts
export const LEXICAL_WEIGHT = 0.4;
export const SEMANTIC_WEIGHT = 0.6;
export const MIN_HYBRID_SCORE = 0.3;
export const MAX_EMBEDDING_INPUT_BYTES = 7_500;
export const MAX_EMBEDDING_BATCH_INPUTS = 32;
```

Return `[]` before scoring or embedding when the trimmed question is empty or `sources` is empty. Use `createHash("sha256")` for source cache keys. Build inputs with `title + "\n\n" + content`. If a formatted source input is blank after trimming, treat the semantic path as invalid and use lexical fallback instead of sending a blank embedding input. Truncate by iterating Unicode code points and accumulating `Buffer.byteLength(character, "utf8")`. Embed the trimmed question and cache misses in sequential chunks as defined in the design. Validate every port vector again at the retriever boundary before caching it.

Cosine similarity must compute both norms and throw on dimension mismatch, non-finite values, or a zero norm. Catch semantic-path errors only around retrieval and return `searchStrongLexicalSources(question, sources, limit)`; do not catch Sol errors.

For valid vectors, rank with:

```ts
const semanticScore = Math.min(Math.max(cosineSimilarity(questionVector, vector), 0), 1);
const finalScore = lexical.normalizedScore * 0.4 + semanticScore * 0.6;
```

Filter below `0.30`, then sort by final, semantic, lexical descending, and `compareSourcesByTitleAndId`. Run the hybrid test and expect PASS.

- [ ] **Step 11: Write failing QuestionAnswerService integration tests**

Refactor test helpers to inject a `SourceRetrieverPort`. Add assertions that:

1. `listProjectSources(projectKey)` resolves before `retrieve(question, returnedRows, 5)` is invoked;
2. an empty retrieval result short-circuits transcripts and Sol;
3. Sol receives only the retriever's top-five original sources and no embedding vectors; and
4. all existing citation allowlist, duplicate removal, schema validation, 40-transcript, and 280-character excerpt tests retain their behavior.

Run:

```bash
npm test -- src/server/ai/question-answer-service.test.ts
```

Expected: FAIL because the constructor and selection path are still lexical-only.

- [ ] **Step 12: Integrate `SourceRetrieverPort` into QuestionAnswerService**

Add the port and constructor dependency:

```ts
export interface SourceRetrieverPort {
  retrieve(
    question: string,
    sources: readonly SearchableSource[],
    limit?: number,
  ): Promise<SearchableSource[]>;
}
```

Replace direct `searchSources` use with:

```ts
const all = await this.knowledge.listProjectSources(input.projectKey);
const selected = await this.retriever.retrieve(input.question, all, 5);
```

Keep all downstream transcript and citation logic unchanged. Run the service test and expect PASS.

- [ ] **Step 13: Run focused and full verification**

Run:

```bash
npm test -- src/server/env.test.ts src/server/ai/embedding-client.test.ts src/server/ai/search-sources.test.ts src/server/ai/source-embedding-cache.test.ts src/server/ai/hybrid-source-retriever.test.ts src/server/ai/question-answer-service.test.ts src/server/ai/sol-analyzer.test.ts
npm run typecheck
npm run build
npm test
git diff --check
```

Expected: all tests, typecheck, build, and whitespace checks PASS. The existing Vite large-chunk advisory is non-blocking because this task changes no client bundle code.

- [ ] **Step 14: Review and publish as one Task 6 commit**

Perform an independent task review and final branch review. Fix every Critical or Important finding and rerun covering tests. Then inspect both staged and unstaged scope:

```bash
git diff --stat
git diff --cached --stat
git diff --cached --name-status
```

Stage only `.env.example`, the two hybrid design/plan documents, `src/server/env.ts`, `src/server/env.test.ts`, `src/server/ai`, and `tests/fixtures`. Explicitly exclude `src/server/repositories/repositories.test.ts`.

Create one commit:

```bash
git commit -m "feat: add grounded hybrid source retrieval"
```

Push `feature/recap-mvp`, create a ready pull request against `main`, merge it after checks pass, and fast-forward local `main`. Preserve the feature worktree and the excluded user change.
