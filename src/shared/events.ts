import { z } from "zod";
import {
  AiStateSchema,
  DecisionDraftSchema,
  DecisionSchema,
  EvidenceSourceSchema,
  ParticipantSchema,
  TranscriptSegmentSchema,
} from "./domain";

const RtcSignalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("offer"), sdp: z.string().min(1) }),
  z.object({ kind: z.literal("answer"), sdp: z.string().min(1) }),
  z.object({
    kind: z.literal("ice"),
    candidate: z.string(),
    sdpMid: z.string().nullable(),
    sdpMLineIndex: z.number().int().nullable(),
  }),
]);

export const ClientRoomEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("participant.mic_changed"), muted: z.boolean() }),
  z.object({ type: z.literal("participant.speaking_changed"), speaking: z.boolean() }),
  z.object({ type: z.literal("webrtc.signal"), targetId: z.uuid(), signal: RtcSignalSchema }),
  z.object({ type: z.literal("transcript.partial"), itemId: z.string().min(1), text: z.string() }),
  z.object({
    type: z.literal("transcript.final"),
    itemId: z.string().min(1),
    text: z.string().trim().min(1),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("ai.ask"), question: z.string().trim().min(1).max(500) }),
  z.object({ type: z.literal("ai.stop") }),
  z.object({ type: z.literal("decision.respond"), token: z.string().min(32), response: z.string().trim().min(1) }),
]);
export type ClientRoomEvent = z.infer<typeof ClientRoomEventSchema>;

export const ServerRoomEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("room.snapshot"),
    selfParticipantId: z.uuid(),
    meetingElapsedMs: z.number().int().nonnegative().optional(),
    participants: z.array(ParticipantSchema).max(2),
  }),
  z.object({ type: z.literal("participant.joined"), participant: ParticipantSchema }),
  z.object({ type: z.literal("participant.left"), participantId: z.uuid() }),
  z.object({ type: z.literal("participant.mic_changed"), participantId: z.uuid(), muted: z.boolean() }),
  z.object({ type: z.literal("participant.speaking_changed"), participantId: z.uuid(), speaking: z.boolean() }),
  z.object({ type: z.literal("webrtc.signal"), fromId: z.uuid(), signal: RtcSignalSchema }),
  z.object({ type: z.literal("transcript.partial"), participantId: z.uuid(), itemId: z.string(), text: z.string() }),
  z.object({ type: z.literal("transcript.final"), segment: TranscriptSegmentSchema }),
  z.object({ type: z.literal("ai.state"), state: AiStateSchema, message: z.string().nullable() }),
  z.object({ type: z.literal("ai.answer.clear") }),
  z.object({ type: z.literal("ai.answer.delta"), delta: z.string() }),
  z.object({ type: z.literal("ai.audio.delta"), pcm16Base64: z.string().min(1) }),
  z.object({ type: z.literal("ai.evidence"), sources: z.array(EvidenceSourceSchema).max(5) }),
  z.object({ type: z.literal("decision.proposed"), decision: DecisionDraftSchema }),
  z.object({ type: z.literal("decision.saved"), decision: DecisionSchema }),
  z.object({ type: z.literal("room.error"), code: z.string().min(1), message: z.string().min(1) }),
]);
export type ServerRoomEvent = z.infer<typeof ServerRoomEventSchema>;
