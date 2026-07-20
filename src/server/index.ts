import "dotenv/config";
import { createServer } from "node:http";
import { eq } from "drizzle-orm";
import { Server as SocketIoServer } from "socket.io";
import { createApp } from "./app";
import { createDb } from "./db/client";
import { participants } from "./db/schema";
import { parseEnv } from "./env";
import { RoomRepository } from "./repositories/room-repository";
import { hashCapability } from "./rooms/capability";
import { registerRoomGateway } from "./rooms/register-room-gateway";
import { RoomService, type ParticipantStore } from "./rooms/room-service";

const env = parseEnv(process.env);
const db = createDb(env.DATABASE_URL);
const roomRepository = new RoomRepository(db);
const participantStore: ParticipantStore = {
  async insert(input) {
    await db.insert(participants).values(input);
  },
  async markLeft(participantId) {
    await db
      .update(participants)
      .set({ leftAt: new Date() })
      .where(eq(participants.id, participantId));
  },
};
const roomService = new RoomService(roomRepository, participantStore, hashCapability);
const app = createApp(env, roomRepository);
const httpServer = createServer(app);
const io = new SocketIoServer(httpServer, {
  cors: { origin: env.APP_ORIGIN },
});

const roomGateway = registerRoomGateway(io, roomService, {
  onEvent: async () => undefined,
});

let shutdownPromise: Promise<void> | null = null;

function closeSocketIo(): Promise<void> {
  return new Promise((resolve) => io.close(() => resolve()));
}

function closeHttpServer(): Promise<void> {
  if (!httpServer.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
  });
}

function shutdown(exitCode = 0): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    try {
      await closeSocketIo();
      await roomGateway.drain();
      await roomService.drain();
      await closeHttpServer();
      await db.$client.end({ timeout: 1 });
      process.exitCode = exitCode;
    } catch (error) {
      console.error("Graceful shutdown failed", error);
      process.exitCode = 1;
    }
  })();
  return shutdownPromise;
}

httpServer.once("error", (error) => {
  console.error("Recap server failed", error);
  void shutdown(1);
});

httpServer.listen(env.PORT, "0.0.0.0", () => {
  console.log(`Recap server listening on 0.0.0.0:${env.PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown();
  });
}
