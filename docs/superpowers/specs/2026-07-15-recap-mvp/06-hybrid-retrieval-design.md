# Task 6 Hybrid Retrieval Design

**Date:** 2026-07-22

**Status:** Implemented and independently reviewed

**Scope:** Replace Task 6's lexical-only retrieval with project-scoped lexical and semantic fusion. Database persistence and pgvector remain out of scope.

## 1. Problem

The current lexical ranker is reliable for exact identifiers and product terms such as `ADR-007`, `PostgreSQL`, and `결제 출시`. It cannot reliably retrieve a source when a participant asks with a synonym or paraphrase that shares no useful token with the source.

Retrieval must improve semantic recall without weakening these existing guarantees:

- a question may search only the current room's `projectKey`;
- unrelated questions return no evidence rather than an arbitrary top result;
- only the server-selected top five source IDs may reach GPT-5.6 Sol and later the client;
- an embedding failure must not prevent strong exact lexical retrieval; and
- tests must not make paid OpenAI API calls.

## 2. Chosen approach

Use an application-side hybrid retriever with on-demand OpenAI embeddings and a process-local source cache.

The flow is:

```text
question
  -> KnowledgeRepository.listProjectSources(projectKey)
  -> lexical scoring over only those project rows
  -> query embedding + batched cache-miss source embeddings
  -> normalized lexical/semantic score fusion
  -> relevance threshold and deterministic top five
  -> GPT-5.6 Sol
  -> server citation validation
```

The implementation does not add an embedding column, change the PostgreSQL image, or install pgvector. Those changes would require embedding versioning, backfill, and migration policies and belong in a later scaling task.

## 3. Security and data boundary

`QuestionAnswerService` must call `listProjectSources(projectKey)` before invoking the hybrid retriever. The embedding adapter receives only the rows returned by that project-scoped query.

The service must never fetch a global candidate set and filter it after semantic search. This prevents another project's title or content from being sent to the embedding API or considered as evidence.

Project isolation remains a repository contract rather than a second in-memory filter: `SearchableSource` intentionally carries no `projectKey`. The existing repository integration test must continue proving the SQL `WHERE project_key = ...` behavior, while the service test proves retrieval begins only after that scoped call resolves.

Embedding vectors are retrieval internals. They are not added to `SearchableSource`, serialized into the Sol prompt, returned to the browser, or persisted in logs.

## 4. Components

### `EmbeddingPort`

A narrow port accepts a batch of non-empty strings and returns vectors in the same logical order.

```ts
interface EmbeddingPort {
  readonly cacheNamespace: string;
  embed(inputs: readonly string[]): Promise<readonly number[][]>;
}
```

`cacheNamespace` identifies the model and dimensions that produced a vector, for example `text-embedding-3-small:default`. Production uses `OpenAiEmbeddingClient` with `text-embedding-3-small`. Each `embed` call makes one API request, maps response entries by their `index` rather than trusting response array order, and rejects missing, non-finite, empty, or inconsistent vectors.

Every question and source embedding input is trimmed to at most 7,500 UTF-8 bytes without splitting a Unicode code point. Because one token cannot represent less than one input byte, this stays below the model's 8,192-token per-input limit with margin. `HybridSourceRetriever` groups the question and cache misses into calls of at most 32 inputs, keeping each request below the API's aggregate token limit. The first call contains the question plus up to 31 source misses; later calls contain up to 32 additional source misses. After each successful call, validated source vectors are cached. Any failed call makes the current retrieval use lexical fallback, while vectors cached from earlier successful calls remain available for a later request.

The adapter uses an injected short timeout. Timeout, malformed response, or provider failure is reported to the retriever, which falls back to lexical retrieval.

### `SourceEmbeddingCache`

Only source embeddings are cached. The question embedding is generated for every question.

Each cache entry is keyed by:

```text
embedding cache namespace + source UUID + SHA-256(title + "\n\n" + content)
```

Changing the model, dimensions, source title, or source content therefore creates a cache miss automatically. Failed or malformed vectors are never cached. The cache is process-local and may be empty after a restart; correctness must not depend on a warm cache. It has a default maximum of 500 entries and evicts the least recently used entry when full so repeated source edits cannot grow memory without a bound.

### `HybridSourceRetriever`

The retriever owns embedding orchestration, cache lookup, score fusion, relevance filtering, and deterministic ordering. `QuestionAnswerService` supplies the already project-scoped rows and awaits at most five results.

The pure lexical tokenization and scoring helpers remain separately testable. `SolAnalyzer` and citation validation do not change.

## 5. Scoring contract

### Lexical score

Retain the current weights:

- token in title: `4`
- token in content: `1`

`queryTokenCount` is the size of the final deduplicated token set actually used for scoring, including the two-character Korean prefixes added by the existing expansion rule. Normalize the raw score before fusion:

```ts
lexicalScore = queryTokenCount === 0
  ? 0
  : Math.min(rawLexicalScore / (queryTokenCount * 5), 1);
```

This produces a bounded `0..1` value and prevents a multi-token lexical score from overwhelming cosine similarity.

### Semantic score

Embed `title + "\n\n" + content` for each source and the participant question using the same model. Compute cosine similarity defensively rather than assuming normalized inputs:

```ts
semanticScore = clamp(cosineSimilarity(questionVector, sourceVector), 0, 1);
```

Dimension mismatch, non-finite values, an empty vector, or a zero vector norm makes the semantic batch invalid and triggers lexical fallback.

### Fusion and filtering

```ts
finalScore = lexicalScore * 0.4 + semanticScore * 0.6;
```

The initial minimum final score is `0.30`. This means a semantic-only result generally needs at least `0.50` cosine similarity, while a strong exact identifier can still qualify through its lexical contribution. Task 6 treats this as a named provisional constant and tests only the score math with fake vectors. Task 10 owns live calibration before the judged run.

Candidates with `finalScore < 0.30` are removed before taking the top five. A zero lexical score is not itself a reason to remove a candidate because that would reproduce the synonym-recall failure.

“Preserve exact lexical behavior” means preserving recall and a positive ranking contribution for exact identifiers, not giving every lexical match absolute precedence over a much stronger semantic match. The existing seeded PostgreSQL query must still select ADR-007 and the supporting transcript under the deterministic test vectors, but an intentionally stronger semantic result may rank above a weaker lexical result according to the approved `0.4/0.6` formula.

Sort order is deterministic:

1. final score descending;
2. semantic score descending;
3. lexical score descending;
4. normalized title ascending by JavaScript code-unit comparison, without runtime-locale collation; and
5. source UUID ascending.

## 6. Failure behavior

- If no project source exists, return the existing insufficient-evidence fallback without calling embeddings or Sol.
- If the trimmed question is empty, return the same fallback without calling embeddings or Sol.
- If embeddings time out, fail, or are malformed, a source is eligible for lexical fallback when either of these predicates is true:
  - `strongTitleMatch`: at least two distinct query tokens match the title, or at least one matching title token has four or more characters; or
  - `boundedLexicalMatch`: `lexicalScore >= 0.20` and the source has at least one title-token match or at least two body-token matches.
- `strongTitleMatch` is independent of the normalized denominator, so a verbose question cannot dilute an exact `ADR-007`, `PostgreSQL`, or similarly distinctive title match below the fallback floor. A single short/common title token or a single body token does not receive this bypass.
- If lexical fallback also finds nothing, return the existing insufficient-evidence fallback without calling Sol.
- If hybrid scoring returns no candidate above the relevance threshold, return the same fallback.
- Sol structured-output failure and citation-validation failure retain their existing behavior.

This makes semantic retrieval an availability enhancement without turning an embedding-provider outage into an uncited answer.

## 7. Configuration

Add server-only configuration with safe defaults:

```text
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_TIMEOUT_MS=3000
```

The existing `OPENAI_API_KEY` is reused. No credential is exposed to the browser. This Task 6 adjustment owns the AI implementation plus `env.ts`, `env.test.ts`, and `.env.example` declarations; it does not modify `index.ts` or instantiate runtime services. Task 7 owns constructing the production embedding client and selecting a deterministic fake `EmbeddingPort` when `DEMO_FAKE_OPENAI=1`, just as it selects the other fake AI adapters. Unit and integration tests inject a fake port and spend no API credit.

## 8. Verification contract

Tests must prove:

1. the repository is called with the requested `projectKey` before retrieval;
2. the repository integration test still proves that `listProjectSources` returns no other project's rows;
3. exact `ADR-007` and `PostgreSQL` queries remain eligible, and the seeded PostgreSQL query retains its expected evidence set with deterministic vectors;
4. a synonym-only question retrieves the intended source through fake semantic vectors;
5. lexical and semantic scores are normalized and combined with `0.4/0.6` weights;
6. a semantically unrelated question remains below the threshold and returns no source;
7. source embeddings are reused across questions and invalidated when content changes;
8. query embeddings are never cached across questions;
9. embedding failure and invalid vectors retain a verbose question's exact `ADR-007` title result but reject a weak single-body-token match;
10. only the deterministic top five sources reach Sol;
11. embedding vectors never appear in Sol input or the client evidence cards; and
12. oversized inputs are UTF-8-safely bounded, more than 32 inputs are chunked, and a failed chunk triggers lexical fallback;
13. zero-norm, dimension-mismatched, and non-finite vectors trigger lexical fallback; and
14. all existing citation, transcript-window, and fallback tests continue to pass.

Task 10's opt-in evaluation must add the synonym/paraphrase E02 variant `데이터베이스 교체를 미룬 배경은?`, which must retrieve ADR-007 and the June 29 transcript. E04 retains `휴가 정책을 알려줘`, which must return no source. Those two cases are the initial live-model calibration gate for the `0.30` threshold; changing the threshold requires both to keep passing. No live embedding call is required during this Task 6 review cycle.

## 9. Deferred work

The following remain outside this change:

- persisted embeddings or a backfill command;
- model/content-hash columns in PostgreSQL;
- pgvector, approximate nearest-neighbor indexes, or a vector database;
- semantic document chunking beyond the bounded title/content prefix used by this MVP;
- cross-process or distributed cache coherence; and
- changing Sol prompts, citation rules, or room orchestration.

If the project corpus or server count grows, a separate task should persist versioned embeddings and move similarity filtering closer to PostgreSQL.

## 10. Reference

- [OpenAI Vector Embeddings guide](https://developers.openai.com/api/docs/guides/embeddings): batched inputs, `text-embedding-3-small`, cosine similarity, vector dimensions, and token limits.
