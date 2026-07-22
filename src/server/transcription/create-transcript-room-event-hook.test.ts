import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createTranscriptRoomEventHook } from "./create-transcript-room-event-hook";

describe("createTranscriptRoomEventHook", () => {
  it("broadcasts partial transcripts without persisting them", async () => {
    const roomId = randomUUID();
    const participantId = randomUUID();
    const emit = vi.fn();
    const io = { to: vi.fn(() => ({ emit })) };
    const rooms = {
      getParticipant: vi.fn(),
      getMeetingId: vi.fn(),
    };
    const transcripts = { insertFinal: vi.fn() };
    const onEvent = createTranscriptRoomEventHook(io, rooms, transcripts);

    await onEvent({
      roomId,
      participantId,
      event: { type: "transcript.partial", itemId: "item-live", text: "진행 중" },
    });

    expect(io.to).toHaveBeenCalledWith(roomId);
    expect(emit).toHaveBeenCalledWith("room:event", {
      type: "transcript.partial",
      participantId,
      itemId: "item-live",
      text: "진행 중",
    });
    expect(transcripts.insertFinal).not.toHaveBeenCalled();
  });

  it("persists and broadcasts a final transcript with server room context", async () => {
    const roomId = randomUUID();
    const meetingId = randomUUID();
    const participantId = randomUUID();
    const segmentId = randomUUID();
    const emit = vi.fn();
    const io = { to: vi.fn(() => ({ emit })) };
    const participant = {
      id: participantId,
      displayName: "민지",
      roleLabel: "PM",
      muted: false,
      speaking: false,
      connected: true,
    };
    const rooms = {
      getParticipant: vi.fn(() => participant),
      getMeetingId: vi.fn(() => meetingId),
    };
    const row = {
      id: segmentId,
      itemId: "item-final",
      meetingId,
      participantId,
      startMs: 100,
      endMs: 900,
      text: "PostgreSQL 전환은 보류합니다.",
      createdAt: new Date(),
    };
    const transcripts = {
      insertFinal: vi.fn(async () => ({ segment: row, inserted: true })),
    };
    const onEvent = createTranscriptRoomEventHook(io, rooms, transcripts);

    await onEvent({
      roomId,
      participantId,
      event: {
        type: "transcript.final",
        itemId: "item-final",
        text: "PostgreSQL 전환은 보류합니다.",
        startMs: 100,
        endMs: 900,
      },
    });

    expect(transcripts.insertFinal).toHaveBeenCalledWith({
      itemId: "item-final",
      meetingId,
      participantId,
      text: "PostgreSQL 전환은 보류합니다.",
      startMs: 100,
      endMs: 900,
    });
    expect(emit).toHaveBeenCalledWith("room:event", {
      type: "transcript.final",
      segment: {
        id: segmentId,
        itemId: "item-final",
        participantId,
        displayName: "민지",
        text: "PostgreSQL 전환은 보류합니다.",
        startMs: 100,
        endMs: 900,
      },
    });
  });

  it("does not rebroadcast an idempotent final transcript retry", async () => {
    const roomId = randomUUID();
    const meetingId = randomUUID();
    const participantId = randomUUID();
    const emit = vi.fn();
    const io = { to: vi.fn(() => ({ emit })) };
    const rooms = {
      getParticipant: vi.fn(() => ({
        id: participantId,
        displayName: "민지",
        roleLabel: "PM",
        muted: false,
        speaking: false,
        connected: true,
      })),
      getMeetingId: vi.fn(() => meetingId),
    };
    const transcripts = {
      insertFinal: vi.fn(async () => ({
        segment: {
          id: randomUUID(),
          itemId: "item-final",
          meetingId,
          participantId,
          startMs: 100,
          endMs: 900,
          text: "이미 저장된 발화",
          createdAt: new Date(),
        },
        inserted: false,
      })),
    };
    const onEvent = createTranscriptRoomEventHook(io, rooms, transcripts);

    await onEvent({
      roomId,
      participantId,
      event: {
        type: "transcript.final",
        itemId: "item-final",
        text: "이미 저장된 발화",
        startMs: 100,
        endMs: 900,
      },
    });

    expect(transcripts.insertFinal).toHaveBeenCalledTimes(1);
    expect(io.to).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("rejects final transcripts when participant or meeting context is gone", async () => {
    const roomId = randomUUID();
    const participantId = randomUUID();
    const io = { to: vi.fn(() => ({ emit: vi.fn() })) };
    const transcripts = { insertFinal: vi.fn() };
    const event = {
      type: "transcript.final" as const,
      itemId: "item-final",
      text: "늦게 도착한 발화",
      startMs: 100,
      endMs: 900,
    };

    const missingParticipant = createTranscriptRoomEventHook(
      io,
      { getParticipant: vi.fn(() => null), getMeetingId: vi.fn(() => randomUUID()) },
      transcripts,
    );
    const missingMeeting = createTranscriptRoomEventHook(
      io,
      {
        getParticipant: vi.fn(() => ({
          id: participantId,
          displayName: "민지",
          roleLabel: "PM",
          muted: false,
          speaking: false,
          connected: true,
        })),
        getMeetingId: vi.fn(() => null),
      },
      transcripts,
    );

    await expect(
      missingParticipant({ roomId, participantId, event }),
    ).rejects.toThrow("ROOM_UNAVAILABLE");
    await expect(missingMeeting({ roomId, participantId, event })).rejects.toThrow(
      "ROOM_UNAVAILABLE",
    );
    expect(transcripts.insertFinal).not.toHaveBeenCalled();
    expect(io.to).not.toHaveBeenCalled();
  });
});
