export class SourceEmbeddingCache {
  private readonly entries = new Map<string, readonly number[]>();

  constructor(private readonly maxEntries = 500) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("EMBEDDING_CACHE_SIZE_INVALID");
    }
  }

  get(key: string): readonly number[] | undefined {
    const vector = this.entries.get(key);
    if (!vector) return undefined;
    this.entries.delete(key);
    const copy = [...vector];
    this.entries.set(key, copy);
    return [...copy];
  }

  set(key: string, vector: readonly number[]): void {
    this.entries.delete(key);
    this.entries.set(key, [...vector]);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
