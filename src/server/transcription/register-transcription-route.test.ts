import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { registerTranscriptionRoute } from "./register-transcription-route";

describe("registerTranscriptionRoute", () => {
  it("exchanges authorized browser SDP without exposing the server API key", async () => {
    const roomId = randomUUID();
    const participantId = randomUUID();
    const authorize = vi.fn(async () => true);
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response("answer-sdp", {
        status: 200,
        headers: { "Content-Type": "application/sdp" },
      }),
    );
    const app = express();
    registerTranscriptionRoute(app, {
      apiKey: "server-only-api-key",
      authorize,
      fetchImpl,
    });

    const response = await request(app)
      .post("/api/openai/transcription-session")
      .set("Content-Type", "application/sdp")
      .set("Authorization", "Bearer room-secret")
      .set("X-Room-Id", roomId)
      .set("X-Participant-Id", participantId)
      .send("offer-sdp");

    expect(response.status).toBe(200);
    expect(response.text).toBe("answer-sdp");
    expect(response.headers["content-type"]).toMatch(/^application\/sdp/);
    expect(authorize).toHaveBeenCalledWith(roomId, participantId, "room-secret");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call!;
    expect(url).toBe("https://api.openai.com/v1/realtime/calls");
    expect(init).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer server-only-api-key" },
    });
    const form = init?.body as FormData;
    expect(form.get("sdp")).toBe("offer-sdp");
    expect(JSON.parse(String(form.get("session")))).toEqual({
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24_000 },
          transcription: {
            model: "gpt-realtime-whisper",
            language: "ko",
            delay: "low",
          },
          turn_detection: null,
        },
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("server-only-api-key");
  });

  it("rejects malformed UUIDs before authorization or upstream work", async () => {
    const authorize = vi.fn(async () => true);
    const fetchImpl = vi.fn(async () => new Response("answer-sdp"));
    const app = express();
    registerTranscriptionRoute(app, {
      apiKey: "server-only-api-key",
      authorize,
      fetchImpl,
    });

    const response = await request(app)
      .post("/api/openai/transcription-session")
      .set("Content-Type", "application/sdp")
      .set("Authorization", "Bearer room-secret")
      .set("X-Room-Id", "not-a-uuid")
      .set("X-Participant-Id", randomUUID())
      .send("offer-sdp");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ code: "ROOM_UNAVAILABLE" });
    expect(authorize).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a missing Bearer credential before authorization or upstream work", async () => {
    const authorize = vi.fn(async () => true);
    const fetchImpl = vi.fn(async () => new Response("answer-sdp"));
    const app = express();
    registerTranscriptionRoute(app, {
      apiKey: "server-only-api-key",
      authorize,
      fetchImpl,
    });

    const response = await request(app)
      .post("/api/openai/transcription-session")
      .set("Content-Type", "application/sdp")
      .set("X-Room-Id", randomUUID())
      .set("X-Participant-Id", randomUUID())
      .send("offer-sdp");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ code: "ROOM_UNAVAILABLE" });
    expect(authorize).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a well-formed identity when room authorization fails", async () => {
    const authorize = vi.fn(async () => false);
    const fetchImpl = vi.fn(async () => new Response("answer-sdp"));
    const app = express();
    registerTranscriptionRoute(app, {
      apiKey: "server-only-api-key",
      authorize,
      fetchImpl,
    });

    const response = await request(app)
      .post("/api/openai/transcription-session")
      .set("Content-Type", "application/sdp")
      .set("Authorization", "Bearer copied-or-stale-secret")
      .set("X-Room-Id", randomUUID())
      .set("X-Participant-Id", randomUUID())
      .send("offer-sdp");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ code: "ROOM_UNAVAILABLE" });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects unsupported or empty SDP payloads before authorization and upstream work", async () => {
    const authorize = vi.fn(async () => true);
    const fetchImpl = vi.fn(async () => new Response("answer-sdp"));
    const app = express();
    registerTranscriptionRoute(app, {
      apiKey: "server-only-api-key",
      authorize,
      fetchImpl,
    });
    const identityHeaders = {
      Authorization: "Bearer room-secret",
      "X-Room-Id": randomUUID(),
      "X-Participant-Id": randomUUID(),
    };

    const unsupported = await request(app)
      .post("/api/openai/transcription-session")
      .set(identityHeaders)
      .set("Content-Type", "application/json")
      .send({ sdp: "offer-sdp" });
    const empty = await request(app)
      .post("/api/openai/transcription-session")
      .set(identityHeaders)
      .set("Content-Type", "application/sdp")
      .send("");

    expect(unsupported.status).toBe(415);
    expect(unsupported.body).toEqual({ code: "INVALID_SDP" });
    expect(empty.status).toBe(400);
    expect(empty.body).toEqual({ code: "INVALID_SDP" });
    expect(authorize).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows four session attempts per active participant and rejects the fifth", async () => {
    const roomId = randomUUID();
    const participantId = randomUUID();
    const authorize = vi.fn(async () => true);
    const fetchImpl = vi.fn(async () => new Response("answer-sdp"));
    const app = express();
    registerTranscriptionRoute(app, {
      apiKey: "server-only-api-key",
      authorize,
      fetchImpl,
    });

    const makeRequest = () =>
      request(app)
        .post("/api/openai/transcription-session")
        .set("Content-Type", "application/sdp")
        .set("Authorization", "Bearer room-secret")
        .set("X-Room-Id", roomId)
        .set("X-Participant-Id", participantId)
        .send("offer-sdp");

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await makeRequest();
      expect(response.status).toBe(200);
    }
    const rejected = await makeRequest();

    expect(rejected.status).toBe(429);
    expect(rejected.body).toEqual({ code: "TRANSCRIPTION_SESSION_LIMIT" });
    expect(authorize).toHaveBeenCalledTimes(5);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("maps upstream HTTP failures to a safe 502 response", async () => {
    const upstream = new Response("private upstream diagnostic and request id", {
      status: 400,
    });
    const readUpstreamBody = vi.spyOn(upstream, "text");
    const fetchImpl = vi.fn(async () => upstream);
    const app = express();
    registerTranscriptionRoute(app, {
      apiKey: "server-only-api-key",
      authorize: vi.fn(async () => true),
      fetchImpl,
    });

    const response = await request(app)
      .post("/api/openai/transcription-session")
      .set("Content-Type", "application/sdp")
      .set("Authorization", "Bearer room-secret")
      .set("X-Room-Id", randomUUID())
      .set("X-Participant-Id", randomUUID())
      .send("offer-sdp");

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ code: "TRANSCRIPTION_SESSION_FAILED" });
    expect(JSON.stringify(response.body)).not.toContain("private upstream");
    expect(JSON.stringify(response.body)).not.toContain("server-only-api-key");
    expect(readUpstreamBody).toHaveBeenCalledTimes(1);
  });

  it("maps upstream network failures to the same safe 502 response", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("private network failure details");
    });
    const app = express();
    registerTranscriptionRoute(app, {
      apiKey: "server-only-api-key",
      authorize: vi.fn(async () => true),
      fetchImpl,
    });

    const response = await request(app)
      .post("/api/openai/transcription-session")
      .set("Content-Type", "application/sdp")
      .set("Authorization", "Bearer room-secret")
      .set("X-Room-Id", randomUUID())
      .set("X-Participant-Id", randomUUID())
      .send("offer-sdp");

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ code: "TRANSCRIPTION_SESSION_FAILED" });
    expect(response.text).not.toContain("private network failure");
    expect(response.text).not.toContain("server-only-api-key");
  });

  it("counts failed upstream exchanges as attempts", async () => {
    const roomId = randomUUID();
    const participantId = randomUUID();
    const fetchImpl = vi.fn(async () => new Response("private failure", { status: 503 }));
    const app = express();
    registerTranscriptionRoute(app, {
      apiKey: "server-only-api-key",
      authorize: vi.fn(async () => true),
      fetchImpl,
    });
    const makeRequest = () =>
      request(app)
        .post("/api/openai/transcription-session")
        .set("Content-Type", "application/sdp")
        .set("Authorization", "Bearer room-secret")
        .set("X-Room-Id", roomId)
        .set("X-Participant-Id", participantId)
        .send("offer-sdp");

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await makeRequest()).status).toBe(502);
    }
    expect((await makeRequest()).status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("keeps the allowance isolated by participant and enforces it concurrently", async () => {
    const roomId = randomUUID();
    const firstParticipantId = randomUUID();
    const secondParticipantId = randomUUID();
    const fetchImpl = vi.fn(async () => new Response("answer-sdp"));
    const app = express();
    registerTranscriptionRoute(app, {
      apiKey: "server-only-api-key",
      authorize: vi.fn(async () => true),
      fetchImpl,
    });
    const makeRequest = (participantId: string) =>
      request(app)
        .post("/api/openai/transcription-session")
        .set("Content-Type", "application/sdp")
        .set("Authorization", "Bearer room-secret")
        .set("X-Room-Id", roomId)
        .set("X-Participant-Id", participantId)
        .send("offer-sdp");

    const firstParticipantResults = await Promise.all(
      Array.from({ length: 5 }, () => makeRequest(firstParticipantId)),
    );
    const secondParticipantResult = await makeRequest(secondParticipantId);

    expect(firstParticipantResults.map((response) => response.status).sort()).toEqual([
      200,
      200,
      200,
      200,
      429,
    ]);
    expect(secondParticipantResult.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });
});
