import { and, asc, eq, inArray } from "drizzle-orm";
import type { Decision, DecisionDraft, EvidenceSource } from "../../shared/domain";
import type { Database } from "../db/client";
import {
  decisionSources,
  decisions,
  knowledgeSources,
  meetings,
  participants,
  rooms,
  transcriptSegments,
} from "../db/schema";

export interface AcceptedDecisionInput {
  meetingId: string;
  approvedByParticipantId: string;
  draft: Omit<DecisionDraft, "token">;
}

export class DecisionRepository {
  constructor(private readonly db: Database) {}

  async insertAccepted(input: AcceptedDecisionInput): Promise<Decision> {
    return this.db.transaction(async (tx) => {
      const [meeting] = await tx
        .select({ roomId: meetings.roomId })
        .from(meetings)
        .where(eq(meetings.id, input.meetingId))
        .limit(1)
        .for("share");
      if (!meeting) throw new Error("DECISION_EVIDENCE_OUT_OF_SCOPE");

      const [room] = await tx
        .select({ projectKey: rooms.projectKey })
        .from(rooms)
        .where(eq(rooms.id, meeting.roomId))
        .limit(1)
        .for("share");
      if (!room) throw new Error("DECISION_EVIDENCE_OUT_OF_SCOPE");

      const [approver] = await tx
        .select({ id: participants.id })
        .from(participants)
        .where(
          and(
            eq(participants.id, input.approvedByParticipantId),
            eq(participants.meetingId, input.meetingId),
          ),
        )
        .limit(1)
        .for("share");
      if (!approver) throw new Error("DECISION_APPROVER_OUT_OF_SCOPE");

      const sourceIds = input.draft.sources.map((source) => source.id);
      if (sourceIds.length === 0) throw new Error("DECISION_EVIDENCE_OUT_OF_SCOPE");
      const knowledgeRows = await tx
        .select({
          id: knowledgeSources.id,
          projectKey: knowledgeSources.projectKey,
          type: knowledgeSources.type,
          title: knowledgeSources.title,
          content: knowledgeSources.content,
          meetingTimestampMs: knowledgeSources.meetingTimestampMs,
        })
        .from(knowledgeSources)
        .where(inArray(knowledgeSources.id, sourceIds))
        .for("share");
      if (knowledgeRows.some((source) => source.projectKey !== room.projectKey)) {
        throw new Error("DECISION_EVIDENCE_OUT_OF_SCOPE");
      }
      const knowledgeById = new Map(knowledgeRows.map((source) => [source.id, source]));
      const currentTranscriptIds = sourceIds.filter((id) => !knowledgeById.has(id));
      const transcriptRows =
        currentTranscriptIds.length === 0
          ? []
          : await tx
              .select({
                id: transcriptSegments.id,
                meetingId: transcriptSegments.meetingId,
                text: transcriptSegments.text,
                startMs: transcriptSegments.startMs,
              })
              .from(transcriptSegments)
              .where(inArray(transcriptSegments.id, currentTranscriptIds))
              .for("share");
      if (
        transcriptRows.length !== currentTranscriptIds.length ||
        transcriptRows.some((source) => source.meetingId !== input.meetingId)
      ) {
        throw new Error("DECISION_EVIDENCE_OUT_OF_SCOPE");
      }
      const transcriptById = new Map(transcriptRows.map((source) => [source.id, source]));
      const canonicalSources: EvidenceSource[] = input.draft.sources.map((source) => {
        const knowledge = knowledgeById.get(source.id);
        if (knowledge) {
          return {
            id: knowledge.id,
            type: knowledge.type,
            title: knowledge.title,
            excerpt: knowledge.content,
            timestampMs: knowledge.meetingTimestampMs,
          };
        }

        const transcript = transcriptById.get(source.id);
        if (!transcript) throw new Error("DECISION_EVIDENCE_OUT_OF_SCOPE");
        return {
          id: transcript.id,
          type: "transcript",
          title: source.title,
          excerpt: transcript.text,
          timestampMs: transcript.startMs,
        };
      });

      const [row] = await tx
        .insert(decisions)
        .values({
          meetingId: input.meetingId,
          title: input.draft.title,
          decisionText: input.draft.decisionText,
          rationale: input.draft.rationale,
          owner: input.draft.owner,
          startDate: input.draft.startDate,
          durationText: input.draft.durationText,
          alternatives: input.draft.alternatives,
          approvedByParticipantId: input.approvedByParticipantId,
        })
        .returning();

      await tx.insert(decisionSources).values(
        canonicalSources.map((source) => ({
          decisionId: row.id,
          knowledgeSourceId: knowledgeById.has(source.id) ? source.id : null,
          transcriptSegmentId: knowledgeById.has(source.id) ? null : source.id,
          evidenceType: source.type,
          sourceLabel: source.title,
          excerpt: source.excerpt,
          timestampMs: source.timestampMs,
        })),
      );

      return {
        id: row.id,
        status: "accepted" as const,
        title: row.title,
        decisionText: row.decisionText,
        rationale: row.rationale,
        owner: row.owner,
        startDate: row.startDate,
        durationText: row.durationText,
        alternatives: row.alternatives,
        sources: canonicalSources,
        approvedAt: row.approvedAt.toISOString(),
      };
    });
  }

  async listAccepted(meetingId: string): Promise<Decision[]> {
    const rows = await this.db
      .select()
      .from(decisions)
      .where(eq(decisions.meetingId, meetingId))
      .orderBy(asc(decisions.approvedAt));

    return Promise.all(
      rows.map(async (row) => {
        const sourceRows = await this.db
          .select()
          .from(decisionSources)
          .where(eq(decisionSources.decisionId, row.id));
        const sources: EvidenceSource[] = sourceRows.map((source) => ({
          id: source.knowledgeSourceId ?? source.transcriptSegmentId!,
          type: source.evidenceType,
          title: source.sourceLabel,
          excerpt: source.excerpt,
          timestampMs: source.timestampMs,
        }));
        return {
          id: row.id,
          status: "accepted" as const,
          title: row.title,
          decisionText: row.decisionText,
          rationale: row.rationale,
          owner: row.owner,
          startDate: row.startDate,
          durationText: row.durationText,
          alternatives: row.alternatives,
          sources,
          approvedAt: row.approvedAt.toISOString(),
        };
      }),
    );
  }
}
