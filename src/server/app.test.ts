import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { parseEnv } from "./env";
import { hashCapability } from "./rooms/capability";

const env = parseEnv({
  APP_ORIGIN: "http://localhost:5173",
  DATABASE_URL: "postgres://recap:recap@localhost:5432/recap",
  DEMO_FAKE_OPENAI: "1",
});

const room = {
  id: randomUUID(),
  capabilityHash: "stored-hash",
  projectKey: "atlas-demo",
  status: "waiting" as const,
  createdAt: new Date(),
  endedAt: null,
  meetingId: randomUUID(),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createApp", () => {
  it("reports health without touching room persistence", async () => {
    const rooms = { create: vi.fn(async () => room) };

    const response = await request(createApp(env, rooms)).get("/api/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(rooms.create).not.toHaveBeenCalled();
  });

  it("creates a room and returns an opaque invite capability", async () => {
    const rooms = { create: vi.fn(async () => room) };

    const response = await request(createApp(env, rooms)).post("/api/rooms").send({});

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      roomId: room.id,
      secret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      inviteUrl: expect.any(String),
    });
    expect(response.body.inviteUrl).toBe(
      `${env.APP_ORIGIN}/?room=${room.id}&secret=${encodeURIComponent(response.body.secret)}`,
    );
    expect(rooms.create).toHaveBeenCalledWith(
      hashCapability(response.body.secret),
      "atlas-demo",
    );
  });

  it("logs internal failures but returns only the safe error contract", async () => {
    const internalError = new Error("private upstream response body");
    const rooms = { create: vi.fn(async () => Promise.reject(internalError)) };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await request(createApp(env, rooms)).post("/api/rooms").send({});

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      code: "INTERNAL_ERROR",
      message: "요청을 처리하지 못했습니다.",
    });
    expect(JSON.stringify(response.body)).not.toContain("private upstream");
    expect(JSON.stringify(response.body)).not.toContain("stack");
    expect(errorLog).toHaveBeenCalledWith("Request failed", internalError);
  });

  it("authorizes transcription with both the room capability and active presence", async () => {
    const rooms = { create: vi.fn(async () => room) };
    const participantId = randomUUID();
    const verifyCapability = vi.fn(async (_roomId: string, capabilityHash: string) =>
      capabilityHash === hashCapability("valid-room-secret"),
    );
    const getParticipant = vi.fn(
      (_roomId: string, candidateParticipantId: string) =>
        candidateParticipantId === participantId
          ? {
              id: participantId,
              displayName: "민지",
              roleLabel: "PM",
              muted: false,
              speaking: false,
              connected: true,
            }
          : null,
    );
    const fetchImpl = vi.fn(async () => new Response("answer-sdp"));
    const app = createApp(env, rooms, {
      transcription: { verifyCapability, getParticipant, fetchImpl },
    });
    const exchange = (secret: string, candidateParticipantId: string) =>
      request(app)
        .post("/api/openai/transcription-session")
        .set("Content-Type", "application/sdp")
        .set("Authorization", `Bearer ${secret}`)
        .set("X-Room-Id", room.id)
        .set("X-Participant-Id", candidateParticipantId)
        .send("offer-sdp");

    const copiedCapability = await exchange("wrong-room-secret", participantId);
    const staleParticipant = await exchange("valid-room-secret", randomUUID());
    const activeParticipant = await exchange("valid-room-secret", participantId);

    expect(copiedCapability.status).toBe(401);
    expect(staleParticipant.status).toBe(401);
    expect(activeParticipant.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(verifyCapability).toHaveBeenCalledWith(
      room.id,
      hashCapability("valid-room-secret"),
    );
    expect(getParticipant).toHaveBeenCalledWith(room.id, participantId);
  });
});
