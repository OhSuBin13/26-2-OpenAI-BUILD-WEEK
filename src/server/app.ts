import express, { type NextFunction, type Request, type Response } from "express";
import type { Env } from "./env";
import type { RoomRepository } from "./repositories/room-repository";
import { createCapability, hashCapability } from "./rooms/capability";
import { registerTranscriptionRoute } from "./transcription/register-transcription-route";

type RoomCreator = Pick<RoomRepository, "create">;

export interface CreateAppDependencies {
  transcription?: {
    verifyCapability(roomId: string, capabilityHash: string): Promise<boolean>;
    getParticipant(roomId: string, participantId: string): unknown | null;
    fetchImpl?: typeof fetch;
  };
}

export function createApp(
  env: Env,
  rooms: RoomCreator,
  dependencies: CreateAppDependencies = {},
) {
  const app = express();
  app.use(express.json());

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.post("/api/rooms", async (_request, response, next) => {
    try {
      const secret = createCapability();
      const room = await rooms.create(hashCapability(secret), "atlas-demo");
      const inviteUrl = `${env.APP_ORIGIN}/?room=${room.id}&secret=${encodeURIComponent(secret)}`;
      response.status(201).json({ roomId: room.id, secret, inviteUrl });
    } catch (error) {
      next(error);
    }
  });

  if (dependencies.transcription) {
    const transcription = dependencies.transcription;
    registerTranscriptionRoute(app, {
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_TRANSCRIBE_MODEL,
      fetchImpl: transcription.fetchImpl,
      authorize: async (roomId, participantId, secret) => {
        const capabilityValid = await transcription.verifyCapability(
          roomId,
          hashCapability(secret),
        );
        return (
          capabilityValid &&
          transcription.getParticipant(roomId, participantId) !== null
        );
      },
    });
  }

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    console.error("Request failed", error);
    response.status(500).json({
      code: "INTERNAL_ERROR",
      message: "요청을 처리하지 못했습니다.",
    });
  });

  return app;
}
