import type OpenAI from "openai";

const MAX_BATCH_INPUTS = 32;
const INVALID_OUTPUT = "EMBEDDING_OUTPUT_INVALID";

export interface EmbeddingPort {
  readonly cacheNamespace: string;
  embed(inputs: readonly string[]): Promise<readonly number[][]>;
}

const validateVectors = (
  rows: readonly { index: number; embedding: readonly number[] }[],
  expectedLength: number,
) => {
  const ordered = Array.from<readonly number[] | undefined>({ length: expectedLength });
  for (const row of rows) {
    if (!Number.isInteger(row.index) || row.index < 0 || row.index >= expectedLength) {
      throw new Error(INVALID_OUTPUT);
    }
    if (ordered[row.index]) throw new Error(INVALID_OUTPUT);
    ordered[row.index] = row.embedding;
  }
  if (ordered.some((vector) => !vector)) throw new Error(INVALID_OUTPUT);
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
    throw new Error(INVALID_OUTPUT);
  }
  return vectors.map((vector) => [...vector]);
};

export class OpenAiEmbeddingClient implements EmbeddingPort {
  readonly cacheNamespace: string;

  constructor(
    private readonly client: OpenAI,
    private readonly model: "text-embedding-3-small" = "text-embedding-3-small",
    private readonly timeoutMs = 3_000,
  ) {
    this.cacheNamespace = `${this.model}:default`;
  }

  async embed(inputs: readonly string[]): Promise<readonly number[][]> {
    if (
      inputs.length === 0 ||
      inputs.length > MAX_BATCH_INPUTS ||
      inputs.some((input) => input.trim().length === 0)
    ) {
      throw new Error(INVALID_OUTPUT);
    }
    const response = await this.client.embeddings.create(
      { model: this.model, input: [...inputs], encoding_format: "float" },
      { signal: AbortSignal.timeout(this.timeoutMs), maxRetries: 0 },
    );
    return validateVectors(response.data, inputs.length);
  }
}
