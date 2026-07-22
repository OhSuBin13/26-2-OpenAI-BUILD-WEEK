import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { ADR_ID, demoSources, HISTORY_TRANSCRIPT_ID } from "../../../tests/fixtures/seed";
import type { EmbeddingPort } from "./embedding-client";
import {
  HybridSourceRetriever,
  LEXICAL_WEIGHT,
  MAX_EMBEDDING_BATCH_INPUTS,
  MAX_EMBEDDING_INPUT_BYTES,
  MIN_HYBRID_SCORE,
  SEMANTIC_WEIGHT,
} from "./hybrid-source-retriever";
import type { SearchableSource } from "./search-sources";

const sourceText = (source: SearchableSource) => `${source.title}\n\n${source.content}`;

function fakeEmbeddings(
  vectorFor: (input: string) => number[],
): EmbeddingPort & { embed: ReturnType<typeof vi.fn> } {
  return {
    cacheNamespace: "fake:default",
    embed: vi.fn(async (inputs: readonly string[]) => inputs.map(vectorFor)),
  };
}

describe("HybridSourceRetriever", () => {
  it("retrieves synonym-only ADR and transcript evidence above the threshold", async () => {
    const embeddings = fakeEmbeddings((input) => {
      if (input === "데이터베이스 교체를 미룬 배경은?") return [1, 0];
      if (input === sourceText(demoSources[0]!)) return [1, 0];
      if (input === sourceText(demoSources[1]!)) return [0.9, 0.1];
      return [0, 1];
    });

    await expect(
      new HybridSourceRetriever(embeddings).retrieve(
        "데이터베이스 교체를 미룬 배경은?",
        demoSources,
      ),
    ).resolves.toEqual([demoSources[0], demoSources[1]]);
  });

  it("retains the PostgreSQL ADR and transcript evidence set", async () => {
    const embeddings = fakeEmbeddings((input) => {
      if (input === "PostgreSQL 전환을 왜 보류했어?") return [1, 0];
      if (input === sourceText(demoSources[0]!)) return [1, 0];
      if (input === sourceText(demoSources[1]!)) return [0.9, 0.1];
      return [0, 1];
    });

    await expect(
      new HybridSourceRetriever(embeddings).retrieve("PostgreSQL 전환을 왜 보류했어?", demoSources),
    ).resolves.toEqual([demoSources[0], demoSources[1]]);
  });

  it("uses the 0.4/0.6 score and filters weak semantic-only sources", async () => {
    const sources: SearchableSource[] = [
      {
        id: "00000000-0000-4000-8000-000000000010",
        type: "document",
        title: "qualified",
        content: "needle",
        meetingTimestampMs: null,
      },
      {
        id: "00000000-0000-4000-8000-000000000011",
        type: "document",
        title: "semantic 0.42",
        content: "different",
        meetingTimestampMs: null,
      },
      {
        id: "00000000-0000-4000-8000-000000000012",
        type: "document",
        title: "unrelated 0.08",
        content: "different",
        meetingTimestampMs: null,
      },
    ];
    const embeddings = fakeEmbeddings((input) => {
      if (input === "needle") return [1, 0];
      if (input === sourceText(sources[0]!)) return [0.4, Math.sqrt(0.84)];
      if (input === sourceText(sources[1]!)) return [0.42, Math.sqrt(1 - 0.42 ** 2)];
      return [0.08, Math.sqrt(1 - 0.08 ** 2)];
    });

    expect({ LEXICAL_WEIGHT, SEMANTIC_WEIGHT, MIN_HYBRID_SCORE }).toEqual({
      LEXICAL_WEIGHT: 0.4,
      SEMANTIC_WEIGHT: 0.6,
      MIN_HYBRID_SCORE: 0.3,
    });
    await expect(new HybridSourceRetriever(embeddings).retrieve("needle", sources)).resolves.toEqual([
      sources[0],
    ]);
  });

  it("sorts deterministically and caps results at five", async () => {
    const sources = ["z", "a", "f", "c", "e", "b"].map((title, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 20).padStart(12, "0")}`,
      type: "document" as const,
      title,
      content: "evidence",
      meetingTimestampMs: null,
    }));
    const embeddings = fakeEmbeddings(() => [1, 0]);

    await expect(new HybridSourceRetriever(embeddings).retrieve("synonym", sources)).resolves.toEqual([
      sources[1],
      sources[5],
      sources[3],
      sources[4],
      sources[2],
    ]);
  });

  it("caches only source embeddings and invalidates a changed source", async () => {
    const source: SearchableSource = {
      id: "00000000-0000-4000-8000-000000000030",
      type: "document",
      title: "source",
      content: "content",
      meetingTimestampMs: null,
    };
    const embeddings = fakeEmbeddings(() => [1, 0]);
    const retriever = new HybridSourceRetriever(embeddings);

    await retriever.retrieve("question one", [source]);
    await retriever.retrieve("question two", [source]);
    await retriever.retrieve("question three", [{ ...source, content: "changed" }]);

    expect(embeddings.embed.mock.calls.map(([inputs]) => inputs)).toEqual([
      ["question one", sourceText(source)],
      ["question two"],
      ["question three", "source\n\nchanged"],
    ]);
  });

  it("invalidates cache entries when source content changes beyond the embedding prefix", async () => {
    const source: SearchableSource = {
      id: "00000000-0000-4000-8000-000000000031",
      type: "document",
      title: "a".repeat(MAX_EMBEDDING_INPUT_BYTES),
      content: "first version",
      meetingTimestampMs: null,
    };
    const embeddings = fakeEmbeddings(() => [1, 0]);
    const retriever = new HybridSourceRetriever(embeddings);

    await retriever.retrieve("first question", [source]);
    await retriever.retrieve("second question", [{ ...source, content: "second version" }]);

    expect(embeddings.embed.mock.calls[1]![0]).toHaveLength(2);
  });

  it("chunks more than 32 inputs with the question only in the first batch", async () => {
    const sources = Array.from({ length: 32 }, (_, index): SearchableSource => ({
      id: `00000000-0000-4000-8000-${String(index + 40).padStart(12, "0")}`,
      type: "document",
      title: `source-${index}`,
      content: "content",
      meetingTimestampMs: null,
    }));
    const embeddings = fakeEmbeddings(() => [1, 0]);

    await new HybridSourceRetriever(embeddings).retrieve("question", sources);

    expect(embeddings.embed.mock.calls.map(([inputs]) => inputs.length)).toEqual([
      MAX_EMBEDDING_BATCH_INPUTS,
      1,
    ]);
    expect(embeddings.embed.mock.calls[0]![0][0]).toBe("question");
    expect(embeddings.embed.mock.calls[1]![0]).not.toContain("question");
  });

  it("keeps a successful first chunk cached when a later chunk fails", async () => {
    const sources = Array.from({ length: 32 }, (_, index): SearchableSource => ({
      id: `00000000-0000-4000-8000-${String(index + 50).padStart(12, "0")}`,
      type: "document",
      title: `source-${index}`,
      content: "evidence",
      meetingTimestampMs: null,
    }));
    let calls = 0;
    const embeddings: EmbeddingPort & { embed: ReturnType<typeof vi.fn> } = {
      cacheNamespace: "fake:default",
      embed: vi.fn(async (inputs: readonly string[]) => {
        calls += 1;
        if (calls === 2) throw new Error("second chunk failed");
        return inputs.map(() => [1, 0]);
      }),
    };
    const retriever = new HybridSourceRetriever(embeddings);

    await expect(retriever.retrieve("first question", sources)).resolves.toEqual([]);
    await expect(retriever.retrieve("healthy question", sources)).resolves.toHaveLength(5);

    expect(embeddings.embed.mock.calls[0]![0]).toEqual([
      "first question",
      ...sources.slice(0, 31).map(sourceText),
    ]);
    expect(embeddings.embed.mock.calls[1]![0]).toEqual([sourceText(sources[31]!)]);
    expect(embeddings.embed.mock.calls[2]![0]).toEqual([
      "healthy question",
      sourceText(sources[31]!),
    ]);
  });

  it("bounds every embedding input by UTF-8 bytes without splitting Unicode code points", async () => {
    const oversized = "😀".repeat(5_000);
    const source: SearchableSource = {
      id: "00000000-0000-4000-8000-000000000080",
      type: "document",
      title: oversized,
      content: oversized,
      meetingTimestampMs: null,
    };
    const embeddings = fakeEmbeddings(() => [1, 0]);

    await new HybridSourceRetriever(embeddings).retrieve(oversized, [source]);

    for (const call of embeddings.embed.mock.calls) {
      for (const input of call[0]) {
        expect(Buffer.byteLength(input, "utf8")).toBeLessThanOrEqual(MAX_EMBEDDING_INPUT_BYTES);
        expect(input).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
        expect(input).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      }
    }
  });

  it.each([
    ["embedding rejection", () => Promise.reject(new Error("provider failed"))],
    ["missing vector", () => Promise.resolve([[1, 0]])],
    ["dimension mismatch", () => Promise.resolve([[1, 0], [1]])],
    ["non-finite vector", () => Promise.resolve([[1, 0], [Number.NaN, 0]])],
    ["empty vector", () => Promise.resolve([[1, 0], []])],
    ["zero-norm vector", () => Promise.resolve([[1, 0], [0, 0]])],
  ])("uses strong lexical fallback on %s", async (_label, response) => {
    const adr: SearchableSource = {
      id: ADR_ID,
      type: "decision",
      title: "ADR-007 결정",
      content: "기록",
      meetingTimestampMs: null,
    };
    const weakBody: SearchableSource = {
      id: "00000000-0000-4000-8000-000000000090",
      type: "document",
      title: "기록",
      content: "정책 단어",
      meetingTimestampMs: null,
    };
    const embeddings: EmbeddingPort = {
      cacheNamespace: "fake:default",
      embed: vi.fn(response),
    };

    await expect(
      new HybridSourceRetriever(embeddings).retrieve(
        "ADR-007 정책 일정 담당자 우선순위 배경을 자세히 설명해줘",
        [adr, weakBody],
      ),
    ).resolves.toEqual([adr]);
  });

  it("does not cache malformed vectors, allowing a later healthy request to recover", async () => {
    const source: SearchableSource = {
      id: "00000000-0000-4000-8000-000000000091",
      type: "document",
      title: "record",
      content: "needle",
      meetingTimestampMs: null,
    };
    let calls = 0;
    const embeddings: EmbeddingPort & { embed: ReturnType<typeof vi.fn> } = {
      cacheNamespace: "fake:default",
      embed: vi.fn(async (inputs: readonly string[]) => {
        calls += 1;
        return calls === 1 ? [[1, 0], [1]] : inputs.map(() => [1, 0]);
      }),
    };
    const retriever = new HybridSourceRetriever(embeddings);

    await expect(retriever.retrieve("needle", [source])).resolves.toEqual([]);
    await expect(retriever.retrieve("needle", [source])).resolves.toEqual([source]);
    expect(embeddings.embed.mock.calls[1]![0]).toEqual(["needle", sourceText(source)]);
  });

  it("returns the original source object without an embedding field", async () => {
    const source: SearchableSource = {
      id: HISTORY_TRANSCRIPT_ID,
      type: "transcript",
      title: "original",
      content: "evidence",
      meetingTimestampMs: 1,
    };
    const embeddings = fakeEmbeddings(() => [1, 0]);

    const result = await new HybridSourceRetriever(embeddings).retrieve("synonym", [source]);

    expect(result[0]).toBe(source);
    expect(result[0]).not.toHaveProperty("embedding");
  });
});
