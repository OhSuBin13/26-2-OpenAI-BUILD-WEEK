import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DecisionDraft } from "../../shared/domain";
import { createDb, type Database } from "../db/client";
import { knowledgeSources, participants } from "../db/schema";
import { DecisionRepository } from "./decision-repository";
import { KnowledgeRepository } from "./knowledge-repository";
import { RoomRepository } from "./room-repository";
import { TranscriptRepository } from "./transcript-repository";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const disposableDatabasePattern = /^recap_test_[0-9a-f]{32}$/;
let db: Database;
let dbIsOpen = false;
let adminSql: ReturnType<typeof postgres> | undefined;
let testDatabaseCreated = false;
let suppliedDatabaseUrl = "";
let testDatabaseName = "";
let testDatabaseUrl = "";

function requireDisposableDatabaseName() {
  if (!disposableDatabasePattern.test(testDatabaseName)) {
    throw new Error("INVALID_DISPOSABLE_DATABASE_NAME");
  }
}

function databaseUrlFor(baseUrl: string, databaseName: string) {
  const url = new URL(baseUrl);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use postgres:// or postgresql://");
  }
  url.pathname = `/${databaseName}`;
  url.hash = "";
  return url.toString();
}

function runDbScript(script: "db:migrate" | "db:seed") {
  return execFileAsync("npm", ["run", script], {
    cwd: projectRoot,
    env: { ...process.env, NODE_ENV: "test", DATABASE_URL: testDatabaseUrl },
  });
}

async function verifyDisposableDatabaseTarget() {
  const sentinel = postgres(testDatabaseUrl, { max: 1 });
  try {
    const [row] = await sentinel<{ databaseName: string }[]>`
      select current_database() as "databaseName"
    `;
    if (row?.databaseName !== testDatabaseName) {
      throw new Error("DISPOSABLE_DATABASE_SENTINEL_MISMATCH");
    }
  } finally {
    await sentinel.end({ timeout: 5 });
  }
}

async function closeAndDropTestDatabase() {
  const errors: unknown[] = [];
  if (dbIsOpen) {
    try {
      await db.$client.end({ timeout: 5 });
    } catch (error) {
      errors.push(error);
    } finally {
      dbIsOpen = false;
    }
  }

  const control = adminSql;
  adminSql = undefined;
  if (control) {
    try {
      if (testDatabaseCreated) {
        requireDisposableDatabaseName();
        await control`drop database if exists ${control(testDatabaseName)} with (force)`;
        testDatabaseCreated = false;
      }
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        await control.end({ timeout: 5 });
      } catch (error) {
        errors.push(error);
      }
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to clean up repository test database");
  }
}

beforeAll(async () => {
  suppliedDatabaseUrl = process.env.DATABASE_URL ?? "";
  if (!suppliedDatabaseUrl) throw new Error("DATABASE_URL is required for repository tests");

  testDatabaseName = `recap_test_${randomUUID().replaceAll("-", "")}`;
  requireDisposableDatabaseName();
  testDatabaseUrl = databaseUrlFor(suppliedDatabaseUrl, testDatabaseName);
  const adminUrl = databaseUrlFor(suppliedDatabaseUrl, "postgres");
  adminSql = postgres(adminUrl.toString(), { max: 1 });

  try {
    await adminSql`create database ${adminSql(testDatabaseName)}`;
    testDatabaseCreated = true;
    await verifyDisposableDatabaseTarget();
    await runDbScript("db:migrate");
    await runDbScript("db:seed");
    db = createDb(testDatabaseUrl);
    dbIsOpen = true;
  } catch (setupError) {
    try {
      await closeAndDropTestDatabase();
    } catch (cleanupError) {
      throw new AggregateError(
        [setupError, cleanupError],
        "Repository database setup and cleanup both failed",
      );
    }
    throw setupError;
  }
}, 30_000);

afterAll(closeAndDropTestDatabase, 30_000);

async function createTestRoom(capabilityHash: string, projectKey: string) {
  return new RoomRepository(db).create(capabilityHash, projectKey);
}

async function createMeetingFixture() {
  const room = await createTestRoom(`hash-${randomUUID()}`, "atlas-demo");
  const [participant] = await db
    .insert(participants)
    .values({ meetingId: room.meetingId, displayName: "민지", roleLabel: "Tech Lead" })
    .returning();
  return { room, participant };
}

function decisionDraft(sources: DecisionDraft["sources"]): Omit<DecisionDraft, "token"> {
  return {
    title: "PostgreSQL 마이그레이션 재개",
    decisionText: "결제 기능 출시 후 PostgreSQL 마이그레이션을 재개한다.",
    rationale: ["담당자와 3주의 전환 기간을 확보한다."],
    owner: "민지",
    startDate: "2026-07-20",
    durationText: "3주",
    alternatives: ["현재 데이터베이스 유지"],
    sources,
  };
}

describe("repository integration database", () => {
  it("uses a disposable database instead of the supplied application database", async () => {
    const rows = await db.execute<{ databaseName: string }>(
      sql`select current_database() as "databaseName"`,
    );

    expect(rows[0]?.databaseName).toBe(testDatabaseName);
    expect(rows[0]?.databaseName).toMatch(disposableDatabasePattern);
    expect(testDatabaseUrl).not.toBe(suppliedDatabaseUrl);
  });
});

describe("RoomRepository", () => {
  it("creates a room with a meeting and loads both identifiers", async () => {
    const rooms = new RoomRepository(db);
    const room = await createTestRoom("hash-123", "atlas-demo");

    await expect(rooms.get(room.id)).resolves.toMatchObject({
      id: room.id,
      capabilityHash: "hash-123",
      projectKey: "atlas-demo",
      status: "waiting",
    });
    await expect(rooms.getMeetingId(room.id)).resolves.toBe(room.meetingId);
  });

  it("returns null for unknown room and meeting identifiers", async () => {
    const rooms = new RoomRepository(db);
    const unknownRoomId = randomUUID();

    await expect(rooms.get(unknownRoomId)).resolves.toBeNull();
    await expect(rooms.getMeetingId(unknownRoomId)).resolves.toBeNull();
  });

  it("verifies only the matching room capability", async () => {
    const rooms = new RoomRepository(db);
    const room = await createTestRoom("hash-verify", "atlas-demo");

    await expect(rooms.verifyCapability(room.id, "hash-verify")).resolves.toBe(true);
    await expect(rooms.verifyCapability(room.id, "wrong")).resolves.toBe(false);
    await expect(rooms.verifyCapability(randomUUID(), "hash-verify")).resolves.toBe(false);
  });
});

describe("TranscriptRepository", () => {
  it("inserts final transcripts idempotently by meeting, participant, and item", async () => {
    const { room, participant } = await createMeetingFixture();
    const transcripts = new TranscriptRepository(db);
    const input = {
      itemId: "item-idempotent",
      meetingId: room.meetingId,
      participantId: participant.id,
      startMs: 100,
      endMs: 200,
      text: "첫 번째 최종 발화",
    };

    const first = await transcripts.insertFinal(input);
    const duplicate = await transcripts.insertFinal({ ...input, text: "중복 발화" });

    expect(first.inserted).toBe(true);
    expect(duplicate).toEqual({ segment: first.segment, inserted: false });
    expect(duplicate.segment.text).toBe("첫 번째 최종 발화");
  });

  it("returns the most recent transcripts first and honors the limit", async () => {
    const { room, participant } = await createMeetingFixture();
    const transcripts = new TranscriptRepository(db);
    for (const [itemId, startMs] of [
      ["item-100", 100],
      ["item-300", 300],
      ["item-200", 200],
    ] as const) {
      await transcripts.insertFinal({
        itemId,
        meetingId: room.meetingId,
        participantId: participant.id,
        startMs,
        endMs: startMs + 50,
        text: itemId,
      });
    }

    const recent = await transcripts.recent(room.meetingId, 2);

    expect(recent.map(({ itemId }) => itemId)).toEqual(["item-300", "item-200"]);
  });

  it("rejects a participant from another meeting", async () => {
    const target = await createMeetingFixture();
    const other = await createMeetingFixture();
    const transcripts = new TranscriptRepository(db);

    await expect(
      transcripts.insertFinal({
        itemId: "cross-meeting-participant",
        meetingId: target.room.meetingId,
        participantId: other.participant.id,
        startMs: 400,
        endMs: 600,
        text: "다른 회의 참여자의 발화",
      }),
    ).rejects.toThrow("TRANSCRIPT_PARTICIPANT_OUT_OF_SCOPE");
    await expect(transcripts.recent(target.room.meetingId)).resolves.toEqual([]);
  });
});

describe("KnowledgeRepository", () => {
  it("loads only the exact seeded Atlas demo evidence", async () => {
    const knowledge = new KnowledgeRepository(db);
    const sources = await knowledge.listProjectSources("atlas-demo");

    expect(sources).toHaveLength(3);
    expect(sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "decision",
          title: "ADR-007 — PostgreSQL 마이그레이션 검토",
          content:
            "PostgreSQL 전환은 기술 문제가 아니라 담당자 부재, 약 3주의 일정 필요, 결제 기능 출시와의 충돌 때문에 보류했다.",
          meetingTimestampMs: null,
          metadata: { status: "postponed" },
        }),
        expect.objectContaining({
          type: "transcript",
          title: "6월 29일 아키텍처 회의",
          content:
            "PostgreSQL 마이그레이션을 보류한다. 이번 분기에는 담당자가 없고 결제 기능 출시가 우선이며 전환에는 약 3주가 필요하다.",
          meetingTimestampMs: 1_122_000,
          metadata: { displayTimestamp: "18:42" },
        }),
        expect.objectContaining({
          type: "document",
          title: "결제 시스템 출시 계획",
          content: "결제 기능 출시 후 데이터베이스 마이그레이션 기간을 별도로 확보할 수 있다.",
          meetingTimestampMs: null,
          metadata: {},
        }),
      ]),
    );
    await expect(knowledge.listProjectSources("another-project")).resolves.toEqual([]);
  });

  it("reconciles stale Atlas evidence when the deterministic seed reruns", async () => {
    const { room, participant } = await createMeetingFixture();
    const [staleSource] = await db
      .insert(knowledgeSources)
      .values({
        projectKey: "atlas-demo",
        type: "document",
        title: "stale demo evidence",
        content: "This row must not survive a deterministic reseed.",
      })
      .returning();
    const decisions = new DecisionRepository(db);
    const accepted = await decisions.insertAccepted({
      meetingId: room.meetingId,
      approvedByParticipantId: participant.id,
      draft: decisionDraft([
        {
          id: staleSource.id,
          type: staleSource.type,
          title: staleSource.title,
          excerpt: staleSource.content,
          timestampMs: staleSource.meetingTimestampMs,
        },
      ]),
    });

    const { stdout } = await runDbScript("db:seed");
    const sources = await new KnowledgeRepository(db).listProjectSources("atlas-demo");

    expect(stdout).toContain("Seeded Recap demo evidence");
    expect(sources.map(({ id }) => id).sort()).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
    ]);
    await expect(decisions.listAccepted(room.meetingId)).resolves.toEqual([accepted]);
  });
});

describe("DecisionRepository", () => {
  it("inserts and lists an accepted decision with its evidence", async () => {
    const { room, participant } = await createMeetingFixture();
    const decisions = new DecisionRepository(db);
    const [source] = await new KnowledgeRepository(db).listProjectSources("atlas-demo");
    const sourceInput = {
      id: source.id,
      type: source.type,
      title: source.title,
      excerpt: source.content,
      timestampMs: source.meetingTimestampMs,
    };

    const inserted = await decisions.insertAccepted({
      meetingId: room.meetingId,
      approvedByParticipantId: participant.id,
      draft: decisionDraft([sourceInput]),
    });

    expect(inserted).toMatchObject({
      status: "accepted",
      title: "PostgreSQL 마이그레이션 재개",
      sources: [sourceInput],
    });
    expect(Number.isNaN(Date.parse(inserted.approvedAt))).toBe(false);
    await expect(decisions.listAccepted(room.meetingId)).resolves.toEqual([inserted]);
  });

  it("rejects knowledge evidence from another project", async () => {
    const { room, participant } = await createMeetingFixture();
    const [otherProjectSource] = await db
      .insert(knowledgeSources)
      .values({
        projectKey: "other-project",
        type: "document",
        title: "다른 프로젝트 문서",
        content: "Atlas 회의에서는 사용할 수 없는 근거다.",
      })
      .returning();
    const decisions = new DecisionRepository(db);

    await expect(
      decisions.insertAccepted({
        meetingId: room.meetingId,
        approvedByParticipantId: participant.id,
        draft: decisionDraft([
          {
            id: otherProjectSource.id,
            type: otherProjectSource.type,
            title: otherProjectSource.title,
            excerpt: otherProjectSource.content,
            timestampMs: otherProjectSource.meetingTimestampMs,
          },
        ]),
      }),
    ).rejects.toThrow("DECISION_EVIDENCE_OUT_OF_SCOPE");
    await expect(decisions.listAccepted(room.meetingId)).resolves.toEqual([]);
  });

  it("uses canonical stored knowledge evidence instead of caller display fields", async () => {
    const { room, participant } = await createMeetingFixture();
    const decisions = new DecisionRepository(db);
    const source = (await new KnowledgeRepository(db).listProjectSources("atlas-demo")).find(
      ({ id }) => id === "00000000-0000-4000-8000-000000000001",
    )!;
    const canonicalSource = {
      id: source.id,
      type: source.type,
      title: source.title,
      excerpt: source.content,
      timestampMs: source.meetingTimestampMs,
    };

    const inserted = await decisions.insertAccepted({
      meetingId: room.meetingId,
      approvedByParticipantId: participant.id,
      draft: decisionDraft([
        {
          id: source.id,
          type: "document",
          title: "위조된 제목",
          excerpt: "위조된 인용문",
          timestampMs: 999,
        },
      ]),
    });

    expect(inserted.sources).toEqual([canonicalSource]);
    await expect(decisions.listAccepted(room.meetingId)).resolves.toEqual([inserted]);
  });

  it("rejects an approver from another meeting", async () => {
    const target = await createMeetingFixture();
    const other = await createMeetingFixture();
    const decisions = new DecisionRepository(db);
    const [source] = await new KnowledgeRepository(db).listProjectSources("atlas-demo");

    await expect(
      decisions.insertAccepted({
        meetingId: target.room.meetingId,
        approvedByParticipantId: other.participant.id,
        draft: decisionDraft([
          {
            id: source.id,
            type: source.type,
            title: source.title,
            excerpt: source.content,
            timestampMs: source.meetingTimestampMs,
          },
        ]),
      }),
    ).rejects.toThrow("DECISION_APPROVER_OUT_OF_SCOPE");
    await expect(decisions.listAccepted(target.room.meetingId)).resolves.toEqual([]);
  });

  it("rejects transcript evidence from another meeting without saving a decision", async () => {
    const target = await createMeetingFixture();
    const other = await createMeetingFixture();
    const transcript = await new TranscriptRepository(db).insertFinal({
      itemId: "out-of-scope",
      meetingId: other.room.meetingId,
      participantId: other.participant.id,
      startMs: 500,
      endMs: 700,
      text: "다른 회의의 발화",
    });
    const decisions = new DecisionRepository(db);

    await expect(
      decisions.insertAccepted({
        meetingId: target.room.meetingId,
        approvedByParticipantId: target.participant.id,
        draft: decisionDraft([
          {
            id: transcript.segment.id,
            type: "transcript",
            title: "다른 회의",
            excerpt: transcript.segment.text,
            timestampMs: transcript.segment.startMs,
          },
        ]),
      }),
    ).rejects.toThrow("DECISION_EVIDENCE_OUT_OF_SCOPE");
    await expect(decisions.listAccepted(target.room.meetingId)).resolves.toEqual([]);
  });
});
