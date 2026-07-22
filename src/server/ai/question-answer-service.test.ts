import { describe, expect, it, vi } from "vitest";
import {
  ADR_ID,
  demoSources,
  HISTORY_TRANSCRIPT_ID,
} from "../../../tests/fixtures/seed";
import {
  QuestionAnswerService,
  type ProjectSourceReader,
  type RecentTranscriptReader,
  type SourceRetrieverPort,
} from "./question-answer-service";
import type { SearchableSource } from "./search-sources";
import type { SolAnalyzerPort } from "./sol-analyzer";

const answerInput = {
  projectKey: "atlas-demo",
  meetingId: "10000000-0000-4000-8000-000000000001",
  question: "PostgreSQL 전환을 왜 보류했어?",
};

function sourceReader(sources: SearchableSource[]): ProjectSourceReader {
  return { listProjectSources: vi.fn(async () => sources) };
}

function transcriptReader(rows: Array<{ text: string }>): RecentTranscriptReader {
  return { recent: vi.fn(async () => rows) };
}

function sourceRetriever(result?: SearchableSource[]): SourceRetrieverPort {
  return {
    retrieve: vi.fn(async (_question, sources) => result ?? [...sources].slice(0, 5)),
  };
}

describe("QuestionAnswerService", () => {
  it("returns the answer and evidence cards for citations selected by the server", async () => {
    const knowledge = sourceReader(demoSources);
    const transcripts = transcriptReader([
      { text: "가장 최근 발화" },
      { text: "이전 발화" },
    ]);
    const analyze = vi.fn(async (_input: Parameters<SolAnalyzerPort["analyze"]>[0]) => ({
      answer: "담당자 부재와 3주 일정, 결제 기능 우선순위 때문에 보류했습니다.",
      key_reasons: ["담당자 부재", "일정 충돌"],
      evidence_ids: [ADR_ID, HISTORY_TRANSCRIPT_ID],
      confidence: "high" as const,
      missing_information: [],
    }));
    const analyzer: SolAnalyzerPort = { analyze };
    const service = new QuestionAnswerService(knowledge, transcripts, sourceRetriever(), analyzer);

    await expect(service.answer(answerInput)).resolves.toEqual({
      answer: "담당자 부재와 3주 일정, 결제 기능 우선순위 때문에 보류했습니다.",
      sources: [
        {
          id: ADR_ID,
          type: "decision",
          title: "ADR-007 — PostgreSQL 마이그레이션 검토",
          excerpt:
            "PostgreSQL 전환은 기술 문제가 아니라 담당자 부재, 약 3주의 일정 필요, 결제 기능 출시와의 충돌 때문에 보류했다.",
          timestampMs: null,
        },
        {
          id: HISTORY_TRANSCRIPT_ID,
          type: "transcript",
          title: "6월 29일 아키텍처 회의",
          excerpt:
            "PostgreSQL 마이그레이션을 보류한다. 이번 분기에는 담당자가 없고 결제 기능 출시가 우선이며 전환에는 약 3주가 필요하다.",
          timestampMs: 1_122_000,
        },
      ],
      confidence: "high",
    });
  });

  it("sends only the top five sources and 40 newest rows in chronological order", async () => {
    const sources = Array.from({ length: 6 }, (_, index): SearchableSource => ({
      id: `00000000-0000-4000-8000-${String(index + 11).padStart(12, "0")}`,
      type: "document",
      title: `PostgreSQL source ${String.fromCharCode(65 + index)}`,
      content: "PostgreSQL migration evidence",
      meetingTimestampMs: null,
    }));
    const recentRows = Array.from({ length: 41 }, (_, index) => ({
      text: `recent-${41 - index}`,
    }));
    const originalOrder = recentRows.map(({ text }) => text);
    const knowledge = sourceReader(sources);
    const transcripts = transcriptReader(recentRows);
    const retriever = sourceRetriever();
    const analyze = vi.fn(
      async (input: Parameters<SolAnalyzerPort["analyze"]>[0]) => ({
        answer: "검증된 답변",
        key_reasons: [],
        evidence_ids: [input.sources[0]!.id],
        confidence: "medium" as const,
        missing_information: [],
      }),
    );
    const service = new QuestionAnswerService(knowledge, transcripts, retriever, { analyze });

    await service.answer({ ...answerInput, question: "PostgreSQL" });

    expect(transcripts.recent).toHaveBeenCalledWith(answerInput.meetingId, 40);
    expect(retriever.retrieve).toHaveBeenCalledWith("PostgreSQL", sources, 5);
    expect(analyze).toHaveBeenCalledWith({
      question: "PostgreSQL",
      sources: sources.slice(0, 5),
      recentTranscript: Array.from({ length: 40 }, (_, index) => `recent-${index + 2}`),
    });
    expect(recentRows.map(({ text }) => text)).toEqual(originalOrder);
  });

  it("falls back without evidence when the analyzer invents a source UUID", async () => {
    const knowledge = sourceReader(demoSources);
    const transcripts = transcriptReader([]);
    const analyzer: SolAnalyzerPort = {
      analyze: vi.fn(async () => ({
        answer: "근거 없는 답변",
        key_reasons: [],
        evidence_ids: ["00000000-0000-4000-8000-999999999999"],
        confidence: "high" as const,
        missing_information: [],
      })),
    };
    const service = new QuestionAnswerService(knowledge, transcripts, sourceRetriever(), analyzer);

    await expect(service.answer(answerInput)).resolves.toEqual({
      answer: "현재 연결된 프로젝트 기록에서는 해당 내용을 찾지 못했습니다.",
      sources: [],
      confidence: "low",
    });
  });

  it("falls back before loading transcripts or calling the analyzer when retrieval finds nothing", async () => {
    const knowledge = sourceReader(demoSources);
    const transcripts = transcriptReader([]);
    const analyze = vi.fn(async () => ({
      answer: "호출되면 안 되는 답변",
      key_reasons: [],
      evidence_ids: [],
      confidence: "high" as const,
      missing_information: [],
    }));
    const service = new QuestionAnswerService(knowledge, transcripts, sourceRetriever([]), { analyze });

    await expect(
      service.answer({ ...answerInput, question: "휴가 정책을 알려줘" }),
    ).resolves.toEqual({
      answer: "현재 연결된 프로젝트 기록에서는 해당 내용을 찾지 못했습니다.",
      sources: [],
      confidence: "low",
    });
    expect(transcripts.recent).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
  });

  it("falls back when the analyzer returns no evidence citations", async () => {
    const analyzer: SolAnalyzerPort = {
      analyze: vi.fn(async () => ({
        answer: "인용 없는 답변",
        key_reasons: [],
        evidence_ids: [],
        confidence: "high" as const,
        missing_information: [],
      })),
    };
    const service = new QuestionAnswerService(
      sourceReader(demoSources),
      transcriptReader([]),
      sourceRetriever(),
      analyzer,
    );

    await expect(service.answer(answerInput)).resolves.toEqual({
      answer: "현재 연결된 프로젝트 기록에서는 해당 내용을 찾지 못했습니다.",
      sources: [],
      confidence: "low",
    });
  });

  it("falls back when the analyzer reports missing information", async () => {
    const analyzer: SolAnalyzerPort = {
      analyze: vi.fn(async () => ({
        answer: "불충분한 답변",
        key_reasons: [],
        evidence_ids: [ADR_ID],
        confidence: "medium" as const,
        missing_information: ["담당자 확인 필요"],
      })),
    };
    const service = new QuestionAnswerService(
      sourceReader(demoSources),
      transcriptReader([]),
      sourceRetriever(),
      analyzer,
    );

    await expect(service.answer(answerInput)).resolves.toEqual({
      answer: "현재 연결된 프로젝트 기록에서는 해당 내용을 찾지 못했습니다.",
      sources: [],
      confidence: "low",
    });
  });

  it("caps client evidence excerpts at 280 characters", async () => {
    const longContent = `PostgreSQL ${"가".repeat(300)}`;
    const longSource: SearchableSource = {
      id: ADR_ID,
      type: "decision",
      title: "ADR-007",
      content: longContent,
      meetingTimestampMs: null,
    };
    const analyzer: SolAnalyzerPort = {
      analyze: vi.fn(async () => ({
        answer: "검증된 답변",
        key_reasons: [],
        evidence_ids: [ADR_ID],
        confidence: "high" as const,
        missing_information: [],
      })),
    };
    const service = new QuestionAnswerService(
      sourceReader([longSource]),
      transcriptReader([]),
      sourceRetriever(),
      analyzer,
    );

    const result = await service.answer({ ...answerInput, question: "PostgreSQL" });

    expect(result.sources[0]?.excerpt).toBe(longContent.slice(0, 280));
    expect(result.sources[0]?.excerpt).toHaveLength(280);
  });

  it.each([
    { label: "empty excerpt", content: "", meetingTimestampMs: null },
    { label: "negative timestamp", content: "PostgreSQL evidence", meetingTimestampMs: -1 },
  ])("fails closed when one mapped evidence card has an invalid $label", async (invalid) => {
    const validSource: SearchableSource = {
      id: ADR_ID,
      type: "decision",
      title: "PostgreSQL valid source",
      content: "PostgreSQL valid evidence",
      meetingTimestampMs: null,
    };
    const invalidSource: SearchableSource = {
      id: HISTORY_TRANSCRIPT_ID,
      type: "transcript",
      title: "PostgreSQL invalid source",
      content: invalid.content,
      meetingTimestampMs: invalid.meetingTimestampMs,
    };
    const analyzer: SolAnalyzerPort = {
      analyze: vi.fn(async () => ({
        answer: "invalid evidence answer",
        key_reasons: [],
        evidence_ids: [ADR_ID, HISTORY_TRANSCRIPT_ID],
        confidence: "high" as const,
        missing_information: [],
      })),
    };
    const service = new QuestionAnswerService(
      sourceReader([validSource, invalidSource]),
      transcriptReader([]),
      sourceRetriever(),
      analyzer,
    );

    await expect(
      service.answer({ ...answerInput, question: "PostgreSQL" }),
    ).resolves.toEqual({
      answer: "현재 연결된 프로젝트 기록에서는 해당 내용을 찾지 못했습니다.",
      sources: [],
      confidence: "low",
    });
  });

  it("deduplicates valid evidence IDs while preserving their first-seen order", async () => {
    const analyzer: SolAnalyzerPort = {
      analyze: vi.fn(async () => ({
        answer: "검증된 답변",
        key_reasons: [],
        evidence_ids: [HISTORY_TRANSCRIPT_ID, ADR_ID, HISTORY_TRANSCRIPT_ID, ADR_ID],
        confidence: "high" as const,
        missing_information: [],
      })),
    };
    const service = new QuestionAnswerService(
      sourceReader(demoSources),
      transcriptReader([]),
      sourceRetriever(),
      analyzer,
    );

    const result = await service.answer(answerInput);

    expect(result.sources.map(({ id }) => id)).toEqual([HISTORY_TRANSCRIPT_ID, ADR_ID]);
  });

  it("waits for project-scoped sources before invoking retrieval", async () => {
    let listed = false;
    const knowledge: ProjectSourceReader = {
      listProjectSources: vi.fn(async (projectKey) => {
        expect(projectKey).toBe(answerInput.projectKey);
        listed = true;
        return [demoSources[0]!];
      }),
    };
    const retriever: SourceRetrieverPort = {
      retrieve: vi.fn(async (_question, sources, limit) => {
        expect(listed).toBe(true);
        expect(sources).toEqual([demoSources[0]]);
        expect(limit).toBe(5);
        return [];
      }),
    };
    const transcripts = transcriptReader([]);
    const analyzer: SolAnalyzerPort = { analyze: vi.fn() };

    await new QuestionAnswerService(knowledge, transcripts, retriever, analyzer).answer(answerInput);

    expect(transcripts.recent).not.toHaveBeenCalled();
    expect(analyzer.analyze).not.toHaveBeenCalled();
  });

  it("passes only retriever-selected original sources to Sol", async () => {
    const selected = demoSources.slice(0, 1);
    const analyze = vi.fn(async (_input: Parameters<SolAnalyzerPort["analyze"]>[0]) => ({
      answer: "검증된 답변",
      key_reasons: [],
      evidence_ids: [ADR_ID],
      confidence: "high" as const,
      missing_information: [],
    }));

    await new QuestionAnswerService(
      sourceReader(demoSources),
      transcriptReader([]),
      sourceRetriever(selected),
      { analyze },
    ).answer(answerInput);

    expect(analyze).toHaveBeenCalledWith(
      expect.objectContaining({ sources: selected }),
    );
    expect(analyze.mock.calls[0]![0].sources[0]).toBe(selected[0]);
    expect(analyze.mock.calls[0]![0].sources[0]).not.toHaveProperty("embedding");
  });
});
