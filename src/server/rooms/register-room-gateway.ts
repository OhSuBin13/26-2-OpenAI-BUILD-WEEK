import type { Server } from "socket.io";
import { z } from "zod";
import {
  ClientRoomEventSchema,
  ServerRoomEventSchema,
  type ClientRoomEvent,
  type ServerRoomEvent,
} from "../../shared/events";
import type { RoomService } from "./room-service";

const AuthSchema = z.object({
  roomId: z.uuid(),
  secret: z.string().min(20),
  displayName: z.string().trim().min(1).max(40),
  roleLabel: z.string().trim().min(1).max(40),
});

export interface RoomEventHooks {
  onEvent(input: {
    roomId: string;
    participantId: string;
    event: ClientRoomEvent;
  }): Promise<void>;
}

export interface RoomGatewayLifecycle {
  drain(): Promise<void>;
}

const parseServerEvent = (event: ServerRoomEvent): ServerRoomEvent =>
  ServerRoomEventSchema.parse(event);

export function registerRoomGateway(
  io: Server,
  rooms: RoomService,
  hooks: RoomEventHooks,
): RoomGatewayLifecycle {
  const inFlight = new Set<Promise<void>>();
  const transcriptQueues = new Map<string, Promise<void>>();
  const stopGenerations = new Map<string, number>();

  const track = (task: Promise<void>): Promise<void> => {
    inFlight.add(task);
    void task.then(
      () => inFlight.delete(task),
      () => inFlight.delete(task),
    );
    return task;
  };

  io.use(async (socket, next) => {
    const admissionController = new AbortController();
    const abortAdmission = () => admissionController.abort();
    socket.conn.once("close", abortAdmission);
    if (socket.conn.readyState !== "open") admissionController.abort();
    let settleAdmission: () => void = () => {};
    let admissionSettled = false;
    const admission = track(
      new Promise<void>((resolve) => {
        settleAdmission = () => {
          if (admissionSettled) return;
          admissionSettled = true;
          resolve();
        };
      }),
    );
    void admission;

    try {
      const auth = AuthSchema.parse(socket.handshake.auth);
      const participant = await rooms.join(auth, admissionController.signal);
      socket.data.roomId = auth.roomId;
      socket.data.participantId = participant.id;
      let admissionPending = true;
      const releaseAdmission = () => {
        if (!admissionPending) return;
        admissionPending = false;
        socket.conn.off("close", releaseAdmission);
        const cleanup = rooms
          .leave(auth.roomId, participant.id)
          .catch((error: unknown) => {
            console.error("Pending admission cleanup failed", error);
          });
        track(cleanup);
        void cleanup.then(settleAdmission);
      };
      socket.data.acceptAdmission = () => {
        admissionPending = false;
        socket.conn.off("close", releaseAdmission);
        settleAdmission();
      };
      socket.conn.off("close", abortAdmission);
      socket.conn.once("close", releaseAdmission);
      if (admissionController.signal.aborted || socket.conn.readyState !== "open") {
        releaseAdmission();
        next(new Error("ROOM_UNAVAILABLE"));
        return;
      }
      next();
    } catch (error) {
      socket.conn.off("close", abortAdmission);
      settleAdmission();
      const code =
        error instanceof Error && error.message === "ROOM_FULL"
          ? "ROOM_FULL"
          : "ROOM_UNAVAILABLE";
      next(new Error(code));
    }
  });

  io.on("connection", (socket) => {
    const roomId = socket.data.roomId as string;
    const participantId = socket.data.participantId as string;
    const acceptAdmission = socket.data.acceptAdmission as (() => void) | undefined;
    acceptAdmission?.();
    delete socket.data.acceptAdmission;
    socket.join(roomId);
    socket.join(participantId);

    socket.emit(
      "room:event",
      parseServerEvent({
        type: "room.snapshot",
        selfParticipantId: participantId,
        participants: rooms.snapshot(roomId),
      }),
    );
    const participant = rooms.getParticipant(roomId, participantId);
    if (participant) {
      socket.to(roomId).emit(
        "room:event",
        parseServerEvent({ type: "participant.joined", participant }),
      );
    }

    const reportEventFailure = (error: unknown) => {
      console.error("Room event failed", error);
      socket.emit(
        "room:event",
        parseServerEvent({
          type: "room.error",
          code: "INTERNAL_ERROR",
          message: "요청을 처리하지 못했습니다.",
        }),
      );
    };

    const invokeHook = async (event: ClientRoomEvent): Promise<void> => {
      try {
        await hooks.onEvent({ roomId, participantId, event });
      } catch (error) {
        reportEventFailure(error);
      }
    };

    const enqueueTranscriptFinal = (event: ClientRoomEvent): void => {
      const previous = transcriptQueues.get(roomId) ?? Promise.resolve();
      const current = previous.then(() => invokeHook(event));
      transcriptQueues.set(roomId, current);
      track(current);
      void current.then(() => {
        if (transcriptQueues.get(roomId) === current) transcriptQueues.delete(roomId);
      });
    };

    const invokeAfterTranscriptFinals = (event: ClientRoomEvent): void => {
      const generation = stopGenerations.get(roomId) ?? 0;
      const transcriptBarrier = transcriptQueues.get(roomId) ?? Promise.resolve();
      const task = transcriptBarrier.then(async () => {
        if ((stopGenerations.get(roomId) ?? 0) !== generation) return;
        await invokeHook(event);
      });
      track(task);
    };

    const handleEvent = (raw: unknown): void => {
      const parsed = ClientRoomEventSchema.safeParse(raw);
      if (!parsed.success) {
        socket.emit(
          "room:event",
          parseServerEvent({
            type: "room.error",
            code: "INVALID_EVENT",
            message: "Invalid room event",
          }),
        );
        return;
      }

      const event = parsed.data;
      if (event.type === "participant.mic_changed") {
        rooms.setMuted(roomId, participantId, event.muted);
        socket.to(roomId).emit(
          "room:event",
          parseServerEvent({ ...event, participantId }),
        );
        return;
      }
      if (event.type === "participant.speaking_changed") {
        rooms.setSpeaking(roomId, participantId, event.speaking);
        socket.to(roomId).emit(
          "room:event",
          parseServerEvent({ ...event, participantId }),
        );
        return;
      }
      if (event.type === "webrtc.signal") {
        if (!rooms.getParticipant(roomId, event.targetId)) {
          socket.emit(
            "room:event",
            parseServerEvent({
              type: "room.error",
              code: "INVALID_TARGET",
              message: "Target participant is unavailable",
            }),
          );
          return;
        }
        io.to(event.targetId).emit(
          "room:event",
          parseServerEvent({
            type: "webrtc.signal",
            fromId: participantId,
            signal: event.signal,
          }),
        );
        return;
      }

      if (event.type === "transcript.final") {
        enqueueTranscriptFinal(event);
        return;
      }
      if (event.type === "ai.ask") {
        invokeAfterTranscriptFinals(event);
        return;
      }
      if (event.type === "ai.stop") {
        stopGenerations.set(roomId, (stopGenerations.get(roomId) ?? 0) + 1);
        track(invokeHook(event));
        return;
      }
      track(invokeHook(event));
    };

    socket.on("room:event", (raw: unknown) => {
      try {
        handleEvent(raw);
      } catch (error) {
        reportEventFailure(error);
      }
    });

    socket.on("disconnect", () => {
      const transcriptBarrier = transcriptQueues.get(roomId) ?? Promise.resolve();
      const leaving = (async () => {
        try {
          await transcriptBarrier;
          await rooms.leave(roomId, participantId);
        } catch (error) {
          console.error("Participant leave failed", error);
        } finally {
          io.to(roomId).emit(
            "room:event",
            parseServerEvent({ type: "participant.left", participantId }),
          );
        }
      })();
      track(leaving);
    });
  });

  return {
    async drain() {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
  };
}
