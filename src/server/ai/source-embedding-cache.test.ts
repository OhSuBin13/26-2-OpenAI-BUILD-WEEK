import { describe, expect, it } from "vitest";
import { SourceEmbeddingCache } from "./source-embedding-cache";

describe("SourceEmbeddingCache", () => {
  it("returns a stored vector", () => {
    const cache = new SourceEmbeddingCache();
    cache.set("source", [1, 2]);

    expect(cache.get("source")).toEqual([1, 2]);
  });

  it("refreshes an entry's recency when it is read", () => {
    const cache = new SourceEmbeddingCache(2);
    cache.set("first", [1]);
    cache.set("second", [2]);
    cache.get("first");
    cache.set("third", [3]);

    expect(cache.get("first")).toEqual([1]);
    expect(cache.get("second")).toBeUndefined();
    expect(cache.get("third")).toEqual([3]);
  });

  it("evicts the least recently used entry when the 501st default entry is added", () => {
    const cache = new SourceEmbeddingCache();
    for (let index = 0; index < 501; index += 1) cache.set(`source-${index}`, [index + 1]);

    expect(cache.get("source-0")).toBeUndefined();
    expect(cache.get("source-500")).toEqual([501]);
  });

  it("copies vectors at both the write and read boundaries", () => {
    const cache = new SourceEmbeddingCache();
    const input = [1, 2];
    cache.set("source", input);
    input[0] = 9;
    const received = cache.get("source") as number[];
    received[1] = 8;

    expect(cache.get("source")).toEqual([1, 2]);
  });
});
