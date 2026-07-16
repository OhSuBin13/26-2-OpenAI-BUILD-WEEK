import { z } from "zod";

export const AiStateSchema = z.enum([
  "waiting",
  "listening",
  "searching",
  "analyzing",
  "speaking",
  "confirming",
  "saving",
  "error",
]);
export type AiState = z.infer<typeof AiStateSchema>;

export const ParticipantSchema = z.object({
  id: z.uuid(),
  displayName: z.string().trim().min(1).max(40),
  roleLabel: z.string().trim().min(1).max(40),
  muted: z.boolean(),
  speaking: z.boolean(),
  connected: z.boolean(),
});
export type Participant = z.infer<typeof ParticipantSchema>;

export const TranscriptSegmentSchema = z.object({
  id: z.uuid(),
  itemId: z.string().min(1),
  participantId: z.uuid(),
  displayName: z.string().min(1),
  text: z.string().trim().min(1),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

export const EvidenceSourceSchema = z.object({
  id: z.uuid(),
  type: z.enum(["decision", "transcript", "document"]),
  title: z.string().min(1),
  excerpt: z.string().min(1),
  timestampMs: z.number().int().nonnegative().nullable(),
});
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

export const DecisionDraftSchema = z.object({
  token: z.string().min(32),
  title: z.string().min(1),
  decisionText: z.string().min(1),
  rationale: z.array(z.string().min(1)).min(1),
  owner: z.string().min(1).nullable(),
  startDate: z.string().date().nullable(),
  durationText: z.string().min(1).nullable(),
  alternatives: z.array(z.string().min(1)),
  sources: z.array(EvidenceSourceSchema).min(1),
});
export type DecisionDraft = z.infer<typeof DecisionDraftSchema>;

export const DecisionSchema = DecisionDraftSchema.omit({ token: true }).extend({
  id: z.uuid(),
  status: z.literal("accepted"),
  approvedAt: z.iso.datetime(),
});
export type Decision = z.infer<typeof DecisionSchema>;
