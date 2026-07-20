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
});
