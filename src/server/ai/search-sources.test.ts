import { describe, expect, it } from "vitest";
import { demoSources } from "../../../tests/fixtures/seed";
import {
  compareSourcesByTitleAndId,
  isStrongLexicalFallback,
  scoreSourceLexically,
  searchSources,
} from "./search-sources";

describe("searchSources", () => {
  it("ranks the PostgreSQL decision before the supporting meeting transcript", () => {
    const results = searchSources("PostgreSQL 전환을 왜 보류했어?", demoSources);

    expect(results.slice(0, 2).map(({ title }) => title)).toEqual([
      "ADR-007 — PostgreSQL 마이그레이션 검토",
      "6월 29일 아키텍처 회의",
    ]);
  });

  it("returns no sources when the question has no lexical match", () => {
    expect(searchSources("휴가 정책을 알려줘", demoSources)).toEqual([]);
  });

  it("uses source ID as the final tie-break regardless of database input order", () => {
    const sources = [
      {
        id: "00000000-0000-4000-8000-000000000002",
        type: "document" as const,
        title: "동일한 PostgreSQL 기록",
        content: "PostgreSQL evidence",
        meetingTimestampMs: null,
      },
      {
        id: "00000000-0000-4000-8000-000000000001",
        type: "document" as const,
        title: "동일한 PostgreSQL 기록",
        content: "PostgreSQL evidence",
        meetingTimestampMs: null,
      },
    ];
    const expected = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ];

    expect(searchSources("PostgreSQL", sources).map(({ id }) => id)).toEqual(expected);
    expect(searchSources("PostgreSQL", [...sources].reverse()).map(({ id }) => id)).toEqual(
      expected,
    );
  });

  it("reports normalized lexical scores using the expanded deduplicated query tokens", () => {
    const source = {
      id: "00000000-0000-4000-8000-000000000010",
      type: "document" as const,
      title: "PostgreSQL 마이그레이션 기록",
      content: "PostgreSQL evidence",
      meetingTimestampMs: null,
    };

    expect(scoreSourceLexically("PostgreSQL 마이그레이션", source)).toMatchObject({
      source,
      rawScore: 13,
      normalizedScore: 13 / 15,
      titleMatchCount: 3,
      bodyMatchCount: 1,
      matchedTitleTokens: ["postgresql", "마이그레이션", "마이"],
    });
  });

  it("keeps a verbose ADR title match as a strong lexical fallback", () => {
    const score = scoreSourceLexically(
      "ADR-007 배경 설명을 아주 자세히 길게 알려줘 정책 일정 담당자 우선순위",
      {
        id: "00000000-0000-4000-8000-000000000011",
        type: "decision",
        title: "ADR-007 결정",
        content: "기록",
        meetingTimestampMs: null,
      },
    );

    expect(score.normalizedScore).toBeLessThan(0.2);
    expect(isStrongLexicalFallback(score)).toBe(true);
  });

  it("accepts long title matches and two distinct title matches as lexical fallback", () => {
    const longTitle = scoreSourceLexically("PostgreSQL", {
      id: "00000000-0000-4000-8000-000000000012",
      type: "document",
      title: "PostgreSQL 기록",
      content: "",
      meetingTimestampMs: null,
    });
    const twoTitles = scoreSourceLexically("결제 출시", {
      id: "00000000-0000-4000-8000-000000000013",
      type: "document",
      title: "결제 출시 기록",
      content: "",
      meetingTimestampMs: null,
    });

    expect(isStrongLexicalFallback(longTitle)).toBe(true);
    expect(isStrongLexicalFallback(twoTitles)).toBe(true);
  });

  it("rejects weak short-title and body-only fallback matches", () => {
    const titleOnly = scoreSourceLexically("회의 일정 정책 담당자 결정 결제 출시", {
      id: "00000000-0000-4000-8000-000000000014",
      type: "document",
      title: "회의 기록",
      content: "",
      meetingTimestampMs: null,
    });
    const bodyOnly = scoreSourceLexically("PostgreSQL", {
      id: "00000000-0000-4000-8000-000000000015",
      type: "document",
      title: "기록",
      content: "PostgreSQL evidence",
      meetingTimestampMs: null,
    });

    expect(isStrongLexicalFallback(titleOnly)).toBe(false);
    expect(isStrongLexicalFallback(bodyOnly)).toBe(false);
  });

  it("uses normalized title code units and UUIDs for deterministic tie breaking", () => {
    const ascii = {
      id: "00000000-0000-4000-8000-000000000016",
      type: "document" as const,
      title: "a record",
      content: "",
      meetingTimestampMs: null,
    };
    const korean = { ...ascii, id: "00000000-0000-4000-8000-000000000015", title: "가 record" };
    const sameTitleLater = { ...ascii, id: "00000000-0000-4000-8000-000000000017" };

    expect(compareSourcesByTitleAndId(ascii, korean)).toBeLessThan(0);
    expect(compareSourcesByTitleAndId(ascii, sameTitleLater)).toBeLessThan(0);
  });
});
