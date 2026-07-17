import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { participants, transcriptSegments } from "../db/schema";

export interface FinalTranscriptInput {
  itemId: string;
  meetingId: string;
  participantId: string;
  startMs: number;
  endMs: number;
  text: string;
}

export class TranscriptRepository {
  constructor(private readonly db: Database) {}

  async insertFinal(
    input: FinalTranscriptInput,
  ): Promise<{ segment: typeof transcriptSegments.$inferSelect; inserted: boolean }> {
    return this.db.transaction(async (tx) => {
      const [participant] = await tx
        .select({ id: participants.id })
        .from(participants)
        .where(
          and(
            eq(participants.id, input.participantId),
            eq(participants.meetingId, input.meetingId),
          ),
        )
        .limit(1)
        .for("share");
      if (!participant) throw new Error("TRANSCRIPT_PARTICIPANT_OUT_OF_SCOPE");

      const [inserted] = await tx
        .insert(transcriptSegments)
        .values(input)
        .onConflictDoNothing()
        .returning();
      if (inserted) return { segment: inserted, inserted: true };

      const [existing] = await tx
        .select()
        .from(transcriptSegments)
        .where(
          and(
            eq(transcriptSegments.meetingId, input.meetingId),
            eq(transcriptSegments.participantId, input.participantId),
            eq(transcriptSegments.itemId, input.itemId),
          ),
        )
        .limit(1);
      if (!existing) throw new Error("TRANSCRIPT_IDEMPOTENCY_LOOKUP_FAILED");
      return { segment: existing, inserted: false };
    });
  }

  recent(
    meetingId: string,
    limit = 40,
  ): Promise<Array<typeof transcriptSegments.$inferSelect>> {
    return this.db
      .select()
      .from(transcriptSegments)
      .where(eq(transcriptSegments.meetingId, meetingId))
      .orderBy(desc(transcriptSegments.startMs), desc(transcriptSegments.createdAt))
      .limit(limit);
  }
}
