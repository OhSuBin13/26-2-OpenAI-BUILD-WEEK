import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { EmbeddingPort } from "./embedding-client";
import {
  compareSourcesByTitleAndId,
  scoreSourceLexically,
  searchStrongLexicalSources,
  type SearchableSource,
} from "./search-sources";
import { SourceEmbeddingCache } from "./source-embedding-cache";

export const LEXICAL_WEIGHT = 0.4;
export const SEMANTIC_WEIGHT = 0.6;
export const MIN_HYBRID_SCORE = 0.3;
export const MAX_EMBEDDING_INPUT_BYTES = 7_500;
export const MAX_EMBEDDING_BATCH_INPUTS = 32;

export interface SourceRetrieverPort {
  retrieve(
    question: string,
    sources: readonly SearchableSource[],
    limit?: number,
  ): Promise<SearchableSource[]>;
}

const truncateUtf8 = (value: string) => {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > MAX_EMBEDDING_INPUT_BYTES) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
};

const validateVectors = (vectors: readonly (readonly number[])[], expectedLength: number) => {
  if (vectors.length !== expectedLength) throw new Error("EMBEDDING_OUTPUT_INVALID");
  return vectors.map((vector) => {
    if (
      !Array.isArray(vector) ||
      vector.length === 0 ||
      vector.some((value) => !Number.isFinite(value)) ||
      vector.every((value) => value === 0)
    ) {
      throw new Error("EMBEDDING_OUTPUT_INVALID");
    }
    return [...vector];
  });
};

const cosineSimilarity = (left: readonly number[], right: readonly number[]) => {
  if (left.length === 0 || left.length !== right.length) {
    throw new Error("EMBEDDING_OUTPUT_INVALID");
  }
  let dotProduct = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
      throw new Error("EMBEDDING_OUTPUT_INVALID");
    }
    dotProduct += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) throw new Error("EMBEDDING_OUTPUT_INVALID");
  return dotProduct / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
};

export class HybridSourceRetriever implements SourceRetrieverPort {
  constructor(
    private readonly embeddings: EmbeddingPort,
    private readonly cache = new SourceEmbeddingCache(),
  ) {}

  async retrieve(
    question: string,
    sources: readonly SearchableSource[],
    limit = 5,
  ): Promise<SearchableSource[]> {
    const trimmedQuestion = question.trim();
    if (trimmedQuestion.length === 0 || sources.length === 0) return [];

    try {
      const questionInput = truncateUtf8(trimmedQuestion);
      const sourceInputs = sources.map((source) => ({
        source,
        input: truncateUtf8(`${source.title}\n\n${source.content}`),
        cacheKey: this.cacheKey(source),
      }));
      if (sourceInputs.some(({ input }) => input.trim().length === 0)) {
        throw new Error("EMBEDDING_INPUT_INVALID");
      }

      const vectorsBySource = new Map<SearchableSource, readonly number[]>();
      const misses = sourceInputs.filter(({ source, cacheKey }) => {
        const cached = this.cache.get(cacheKey);
        if (!cached) return true;
        vectorsBySource.set(source, cached);
        return false;
      });

      const batches: Array<
        Array<{ source?: SearchableSource; input: string; cacheKey?: string }>
      > = [
        [{ input: questionInput }, ...misses.slice(0, 31)],
      ];
      for (let index = 31; index < misses.length; index += MAX_EMBEDDING_BATCH_INPUTS) {
        batches.push(misses.slice(index, index + MAX_EMBEDDING_BATCH_INPUTS));
      }

      let questionVector: readonly number[] | undefined;
      for (const [batchIndex, batch] of batches.entries()) {
        const vectors = validateVectors(
          await this.embeddings.embed(batch.map(({ input }) => input)),
          batch.length,
        );
        const firstVectorIndex = batchIndex === 0 ? 1 : 0;
        if (batchIndex === 0) questionVector = vectors[0]!;
        if (!questionVector) throw new Error("EMBEDDING_OUTPUT_INVALID");
        for (let index = firstVectorIndex; index < batch.length; index += 1) {
          const source = batch[index]!.source!;
          const vector = vectors[index]!;
          const cacheKey = batch[index]!.cacheKey!;
          cosineSimilarity(questionVector, vector);
          this.cache.set(cacheKey, vector);
          vectorsBySource.set(source, vector);
        }
      }
      if (!questionVector || vectorsBySource.size !== sources.length) {
        throw new Error("EMBEDDING_OUTPUT_INVALID");
      }
      for (const vector of vectorsBySource.values()) cosineSimilarity(questionVector, vector);

      return sources
        .map((source) => {
          const lexical = scoreSourceLexically(question, source);
          const semanticScore = Math.min(
            Math.max(cosineSimilarity(questionVector, vectorsBySource.get(source)!), 0),
            1,
          );
          return {
            source,
            lexicalScore: lexical.normalizedScore,
            semanticScore,
            finalScore: lexical.normalizedScore * LEXICAL_WEIGHT + semanticScore * SEMANTIC_WEIGHT,
          };
        })
        .filter(({ finalScore }) => finalScore >= MIN_HYBRID_SCORE)
        .sort(
          (left, right) =>
            right.finalScore - left.finalScore ||
            right.semanticScore - left.semanticScore ||
            right.lexicalScore - left.lexicalScore ||
            compareSourcesByTitleAndId(left.source, right.source),
        )
        .slice(0, limit)
        .map(({ source }) => source);
    } catch {
      return searchStrongLexicalSources(question, sources, limit);
    }
  }

  private cacheKey(source: SearchableSource) {
    const digest = createHash("sha256")
      .update(`${source.title}\n\n${source.content}`)
      .digest("hex");
    return `${this.embeddings.cacheNamespace}:${source.id}:${digest}`;
  }
}
