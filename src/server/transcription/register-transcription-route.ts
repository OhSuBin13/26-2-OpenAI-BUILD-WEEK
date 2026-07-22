import express, { type Express } from "express";
import { z } from "zod";

const TranscriptionIdentitySchema = z.object({
  roomId: z.uuid(),
  participantId: z.uuid(),
});

export interface TranscriptionRouteInput {
  apiKey: string;
  authorize(roomId: string, participantId: string, secret: string): Promise<boolean>;
  fetchImpl?: typeof fetch;
  model?: "gpt-realtime-whisper";
}

export function registerTranscriptionRoute(
  app: Express,
  input: TranscriptionRouteInput,
): void {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sessionCounts = new Map<string, number>();

  app.post(
    "/api/openai/transcription-session",
    express.text({ type: "application/sdp", limit: "256kb" }),
    async (request, response) => {
      const identity = TranscriptionIdentitySchema.safeParse({
        roomId: request.header("X-Room-Id"),
        participantId: request.header("X-Participant-Id"),
      });
      const authorization = request.header("Authorization")?.match(/^Bearer\s+(.+)$/i);
      if (!identity.success || !authorization?.[1]) {
        response.status(401).json({ code: "ROOM_UNAVAILABLE" });
        return;
      }
      if (!request.is("application/sdp")) {
        response.status(415).json({ code: "INVALID_SDP" });
        return;
      }
      if (typeof request.body !== "string" || request.body.trim().length === 0) {
        response.status(400).json({ code: "INVALID_SDP" });
        return;
      }

      const { roomId, participantId } = identity.data;
      const secret = authorization[1];
      const authorized = await input.authorize(roomId, participantId, secret);
      if (!authorized) {
        response.status(401).json({ code: "ROOM_UNAVAILABLE" });
        return;
      }

      const sessionKey = `${roomId}:${participantId}`;
      const sessionCount = sessionCounts.get(sessionKey) ?? 0;
      if (sessionCount >= 4) {
        response.status(429).json({ code: "TRANSCRIPTION_SESSION_LIMIT" });
        return;
      }
      sessionCounts.set(sessionKey, sessionCount + 1);

      const form = new FormData();
      form.set("sdp", request.body as string);
      form.set(
        "session",
        JSON.stringify({
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24_000 },
              transcription: {
                model: input.model ?? "gpt-realtime-whisper",
                language: "ko",
                delay: "low",
              },
              turn_detection: null,
            },
          },
        }),
      );

      try {
        const upstream = await fetchImpl("https://api.openai.com/v1/realtime/calls", {
          method: "POST",
          headers: { Authorization: `Bearer ${input.apiKey}` },
          body: form,
        });
        if (!upstream.ok) {
          await upstream.text();
          response.status(502).json({ code: "TRANSCRIPTION_SESSION_FAILED" });
          return;
        }
        const body = await upstream.text();
        response.type("application/sdp").send(body);
      } catch {
        response.status(502).json({ code: "TRANSCRIPTION_SESSION_FAILED" });
      }
    },
  );
}
