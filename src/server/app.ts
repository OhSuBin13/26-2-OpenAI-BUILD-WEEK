import express, { type NextFunction, type Request, type Response } from "express";
import type { Env } from "./env";
import type { RoomRepository } from "./repositories/room-repository";
import { createCapability, hashCapability } from "./rooms/capability";

type RoomCreator = Pick<RoomRepository, "create">;

export function createApp(env: Env, rooms: RoomCreator) {
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

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    console.error("Request failed", error);
    response.status(500).json({
      code: "INTERNAL_ERROR",
      message: "요청을 처리하지 못했습니다.",
    });
  });

  return app;
}
