import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const roomStatus = pgEnum("room_status", ["waiting", "active", "ended"]);
export const sourceType = pgEnum("source_type", ["decision", "transcript", "document"]);
export const decisionStatus = pgEnum("decision_status", ["accepted"]);

export const rooms = pgTable("rooms", {
  id: uuid("id").primaryKey().defaultRandom(),
  capabilityHash: text("capability_hash").notNull(),
  projectKey: text("project_key").notNull().default("atlas-demo"),
  status: roomStatus("status").notNull().default("waiting"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

export const meetings = pgTable("meetings", {
  id: uuid("id").primaryKey().defaultRandom(),
  roomId: uuid("room_id")
    .notNull()
    .references(() => rooms.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

export const participants = pgTable("participants", {
  id: uuid("id").primaryKey().defaultRandom(),
  meetingId: uuid("meeting_id")
    .notNull()
    .references(() => meetings.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  roleLabel: text("role_label").notNull(),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  leftAt: timestamp("left_at", { withTimezone: true }),
});

export const transcriptSegments = pgTable(
  "transcript_segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: text("item_id").notNull(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("transcript_item_unique").on(
      table.meetingId,
      table.participantId,
      table.itemId,
    ),
  ],
);

export const knowledgeSources = pgTable("knowledge_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectKey: text("project_key").notNull(),
  type: sourceType("type").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  meetingTimestampMs: integer("meeting_timestamp_ms"),
  metadata: jsonb("metadata")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
});

export const decisions = pgTable("decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  meetingId: uuid("meeting_id")
    .notNull()
    .references(() => meetings.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  status: decisionStatus("status").notNull().default("accepted"),
  decisionText: text("decision_text").notNull(),
  rationale: jsonb("rationale").$type<string[]>().notNull(),
  owner: text("owner"),
  startDate: text("start_date"),
  durationText: text("duration_text"),
  alternatives: jsonb("alternatives").$type<string[]>().notNull(),
  approvedByParticipantId: uuid("approved_by_participant_id")
    .notNull()
    .references(() => participants.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
});

export const decisionSources = pgTable("decision_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  decisionId: uuid("decision_id")
    .notNull()
    .references(() => decisions.id, { onDelete: "cascade" }),
  knowledgeSourceId: uuid("knowledge_source_id").references(() => knowledgeSources.id),
  transcriptSegmentId: uuid("transcript_segment_id").references(() => transcriptSegments.id),
  evidenceType: sourceType("evidence_type").notNull(),
  sourceLabel: text("source_label").notNull(),
  excerpt: text("excerpt").notNull(),
  timestampMs: integer("timestamp_ms"),
  valid: boolean("valid").notNull().default(true),
});
