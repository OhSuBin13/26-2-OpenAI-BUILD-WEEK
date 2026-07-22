import {
  ServerRoomEventSchema,
  type ClientRoomEvent,
  type ServerRoomEvent,
} from "../../shared/events";
import type { Participant } from "../../shared/domain";
import type { TranscriptRepository } from "../repositories/transcript-repository";

interface RoomEventBroadcaster {
  to(roomId: string): {
    emit(eventName: "room:event", event: ServerRoomEvent): unknown;
  };
}

interface TranscriptRoomContext {
  getParticipant(roomId: string, participantId: string): Participant | null;
  getMeetingId(roomId: string): string | null;
}

interface TranscriptWriter {
  insertFinal: TranscriptRepository["insertFinal"];
}

export interface TranscriptRoomEventInput {
  roomId: string;
  participantId: string;
  event: ClientRoomEvent;
}

const parseServerEvent = (event: ServerRoomEvent): ServerRoomEvent =>
  ServerRoomEventSchema.parse(event);

export function createTranscriptRoomEventHook(
  io: RoomEventBroadcaster,
  rooms: TranscriptRoomContext,
  transcripts: TranscriptWriter,
): (input: TranscriptRoomEventInput) => Promise<void> {
  return async ({ roomId, participantId, event }) => {
    if (event.type === "transcript.partial") {
      io.to(roomId).emit(
        "room:event",
        parseServerEvent({
          type: "transcript.partial",
          participantId,
          itemId: event.itemId,
          text: event.text,
        }),
      );
      return;
    }

    if (event.type === "transcript.final") {
      const participant = rooms.getParticipant(roomId, participantId);
      const meetingId = rooms.getMeetingId(roomId);
      if (!participant || !meetingId) throw new Error("ROOM_UNAVAILABLE");

      const { segment, inserted } = await transcripts.insertFinal({
        itemId: event.itemId,
        meetingId,
        participantId,
        startMs: event.startMs,
        endMs: event.endMs,
        text: event.text,
      });
      if (!inserted) return;

      io.to(roomId).emit(
        "room:event",
        parseServerEvent({
          type: "transcript.final",
          segment: {
            id: segment.id,
            itemId: segment.itemId,
            participantId,
            displayName: participant.displayName,
            text: segment.text,
            startMs: segment.startMs,
            endMs: segment.endMs,
          },
        }),
      );
    }
  };
}
