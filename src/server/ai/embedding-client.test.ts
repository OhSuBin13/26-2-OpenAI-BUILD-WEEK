import { describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { OpenAiEmbeddingClient } from "./embedding-client";

function fakeClient(rows: Array<{ index: number; embedding: number[] }>) {
  const create = vi.fn(async () => ({ data: rows }));
  return { client: { embeddings: { create } } as unknown as OpenAI, create };
}

describe("OpenAiEmbeddingClient", () => {
  it("uses the fixed model and safe request options", async () => {
    const { client, create } = fakeClient([
      { index: 0, embedding: [1, 0] },
      { index: 1, embedding: [0, 1] },
    ]);
    const embeddings = new OpenAiEmbeddingClient(client);

    await expect(embeddings.embed(["question", "source"])).resolves.toEqual([
      [1, 0],
      [0, 1],
    ]);

    expect(embeddings.cacheNamespace).toBe("text-embedding-3-small:default");
    expect(create).toHaveBeenCalledWith(
      {
        model: "text-embedding-3-small",
        input: ["question", "source"],
        encoding_format: "float",
      },
      expect.objectContaining({ signal: expect.any(AbortSignal), maxRetries: 0 }),
    );
  });

  it("restores response rows by their indexes", async () => {
    const { client } = fakeClient([
      { index: 1, embedding: [0, 1] },
      { index: 0, embedding: [1, 0] },
    ]);

    await expect(new OpenAiEmbeddingClient(client).embed(["first", "second"])).resolves.toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it.each([
    ["an empty batch", [], []],
    ["a batch over 32 inputs", Array.from({ length: 33 }, () => "input"), []],
    ["blank input", ["  "], []],
    ["missing indexes", ["input"], []],
    ["non-finite values", ["input"], [{ index: 0, embedding: [Number.NaN] }]],
    ["inconsistent dimensions", ["one", "two"], [{ index: 0, embedding: [1] }, { index: 1, embedding: [1, 0] }]],
    ["zero-norm vectors", ["input"], [{ index: 0, embedding: [0, 0] }]],
  ])("rejects %s", async (_label, inputs, rows) => {
    const { client } = fakeClient(rows);

    await expect(new OpenAiEmbeddingClient(client).embed(inputs)).rejects.toThrow(
      "EMBEDDING_OUTPUT_INVALID",
    );
  });
});
