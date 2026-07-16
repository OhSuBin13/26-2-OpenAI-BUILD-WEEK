import { describe, expect, it } from "vitest";
import { ClientRoomEventSchema, ServerRoomEventSchema } from "./events";

describe("room event contracts", () => {
  it("accepts a participant-tagged final transcript", () => {
    const parsed = ClientRoomEventSchema.parse({
      type: "transcript.final",
      itemId: "item-1",
      text: "리캡아, 보류 이유를 알려줘",
      startMs: 1_200,
      endMs: 3_400,
    });
    expect(parsed.type).toBe("transcript.final");
  });

  it("rejects a decision-saved event without evidence", () => {
    const parsed = ServerRoomEventSchema.safeParse({
      type: "decision.saved",
      decision: {
        id: crypto.randomUUID(),
        title: "DB migration",
        decisionText: "Move to PostgreSQL",
        rationale: ["PostgreSQL supports the required query patterns"],
        owner: null,
        startDate: null,
        durationText: null,
        alternatives: [],
        sources: [],
        status: "accepted",
        approvedAt: new Date().toISOString(),
      },
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected an evidence validation error");
    expect(parsed.error.issues).toEqual([
      expect.objectContaining({ code: "too_small", path: ["decision", "sources"] }),
    ]);
  });
});
