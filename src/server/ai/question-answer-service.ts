import { EvidenceSourceSchema, type EvidenceSource } from "../../shared/domain";
import type { SourceRetrieverPort } from "./hybrid-source-retriever";
import type { SearchableSource } from "./search-sources";
import type { SolAnalyzerPort } from "./sol-analyzer";

export type { SourceRetrieverPort } from "./hybrid-source-retriever";

const FALLBACK = "현재 연결된 프로젝트 기록에서는 해당 내용을 찾지 못했습니다.";

export interface ProjectSourceReader {
  listProjectSources(projectKey: string): Promise<SearchableSource[]>;
}

export interface RecentTranscriptReader {
  recent(meetingId: string, limit: number): Promise<Array<{ text: string }>>;
}

export class QuestionAnswerService {
  constructor(
    private readonly knowledge: ProjectSourceReader,
    private readonly transcripts: RecentTranscriptReader,
    private readonly retriever: SourceRetrieverPort,
    private readonly analyzer: SolAnalyzerPort,
  ) {}

  async answer(input: { projectKey: string; meetingId: string; question: string }) {
    const all = await this.knowledge.listProjectSources(input.projectKey);
    const selected = await this.retriever.retrieve(input.question, all, 5);
    if (selected.length === 0) {
      return { answer: FALLBACK, sources: [] as EvidenceSource[], confidence: "low" as const };
    }
    const recentRows = await this.transcripts.recent(input.meetingId, 40);
    const result = await this.analyzer.analyze({
      question: input.question,
      sources: selected,
      recentTranscript: recentRows
        .slice(0, 40)
        .reverse()
        .map((row) => row.text),
    });
    const selectedById = new Map(selected.map((source) => [source.id, source]));
    const invalidCitation = result.evidence_ids.some((id) => !selectedById.has(id));
    if (
      result.missing_information.length > 0 ||
      invalidCitation ||
      result.evidence_ids.length === 0
    ) {
      return { answer: FALLBACK, sources: [] as EvidenceSource[], confidence: "low" as const };
    }
    const sources: EvidenceSource[] = [];
    for (const id of new Set(result.evidence_ids)) {
      const source = selectedById.get(id)!;
      const parsed = EvidenceSourceSchema.safeParse({
        id: source.id,
        type: source.type,
        title: source.title,
        excerpt: source.content.slice(0, 280),
        timestampMs: source.meetingTimestampMs,
      });
      if (!parsed.success) {
        return { answer: FALLBACK, sources: [], confidence: "low" as const };
      }
      sources.push(parsed.data);
    }
    return { answer: result.answer, sources, confidence: result.confidence };
  }
}
