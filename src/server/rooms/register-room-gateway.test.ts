import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as SocketIoServer } from "socket.io";
import { io as connectSocket, type Socket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  ServerRoomEventSchema,
  type ClientRoomEvent,
  type ServerRoomEvent,
} from "../../shared/events";
import { hashCapability } from "./capability";
import {
  registerRoomGateway,
  type RoomEventHooks,
} from "./register-room-gateway";
import { RoomService, type ParticipantStore } from "./room-service";

type ServerEventOfType<Type extends ServerRoomEvent["type"]> = Extract<
  ServerRoomEvent,
  { type: Type }
>;

const firstRoomId = randomUUID();
const secondRoomId = randomUUID();
const firstSecret = "first-room-capability-secret-123456";
const secondSecret = "second-room-capability-secret-12345";
const roomCapabilities = new Map<string, string>([
  [firstRoomId, hashCapability(firstSecret)],
  [secondRoomId, hashCapability(secondSecret)],
]);
const roomMeetings = new Map<string, string>([
  [firstRoomId, randomUUID()],
  [secondRoomId, randomUUID()],
]);

const authFor = (
  roomId: string,
  secret: string,
  displayName = "민지",
  roleLabel = "PM",
) => ({ roomId, secret, displayName, roleLabel });

function waitForRoomEvent<Type extends ServerRoomEvent["type"]>(
  socket: Socket,
  type: Type,
): Promise<ServerEventOfType<Type>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${type}`));
    }, 1_000);
    const onEvent = (raw: unknown) => {
      const parsed = ServerRoomEventSchema.safeParse(raw);
      if (!parsed.success) {
        cleanup();
        reject(parsed.error);
        return;
      }
      if (parsed.data.type !== type) return;
      cleanup();
      resolve(parsed.data as ServerEventOfType<Type>);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("room:event", onEvent);
    };
    socket.on("room:event", onEvent);
  });
}

describe("registerRoomGateway", () => {
  let httpServer: HttpServer;
  let io: SocketIoServer;
  let baseUrl: string;
  let clients: Socket[];
  let gateway: ReturnType<typeof registerRoomGateway>;
  let rooms: RoomService;
  let hooks: { onEvent: Mock<RoomEventHooks["onEvent"]> };
  let repository: {
    verifyCapability: Mock<(roomId: string, hash: string) => Promise<boolean>>;
    getMeetingId: Mock<(roomId: string) => Promise<string | null>>;
  };
  let participantStore: {
    insert: Mock<ParticipantStore["insert"]>;
    markLeft: Mock<ParticipantStore["markLeft"]>;
  };

  beforeEach(async () => {
    clients = [];
    repository = {
      verifyCapability: vi.fn(async (roomId: string, hash: string) => {
        return roomCapabilities.get(roomId) === hash;
      }),
      getMeetingId: vi.fn(async (roomId: string) => roomMeetings.get(roomId) ?? null),
    };
    participantStore = {
      insert: vi.fn(async () => undefined),
      markLeft: vi.fn(async () => undefined),
    };
    rooms = new RoomService(repository, participantStore, hashCapability);
    hooks = { onEvent: vi.fn(async () => undefined) };
    httpServer = createServer();
    io = new SocketIoServer(httpServer);
    gateway = registerRoomGateway(io, rooms, hooks);

    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const client of clients) {
      client.removeAllListeners();
      client.close();
    }
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await gateway.drain();
    if (httpServer.listening) {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  async function openClient(auth: Record<string, unknown>) {
    const socket = connectSocket(baseUrl, {
      auth,
      autoConnect: false,
      forceNew: true,
      reconnection: false,
      transports: ["websocket"],
    });
    clients.push(socket);
    const snapshot = waitForRoomEvent(socket, "room.snapshot");
    const connected = new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("connect_error", reject);
    });
    socket.connect();
    try {
      await connected;
    } catch (error) {
      void snapshot.catch(() => undefined);
      throw error;
    }
    return { socket, snapshot: await snapshot };
  }

  async function expectRejected(auth: Record<string, unknown>) {
    const socket = connectSocket(baseUrl, {
      auth,
      autoConnect: false,
      forceNew: true,
      reconnection: false,
      transports: ["websocket"],
    });
    clients.push(socket);
    const rejected = new Promise<Error>((resolve) => {
      socket.once("connect_error", resolve);
    });
    socket.connect();
    return rejected;
  }

  it("emits snapshots plus room-scoped join and leave events", async () => {
    const first = await openClient(authFor(firstRoomId, firstSecret));
    const joined = waitForRoomEvent(first.socket, "participant.joined");

    const second = await openClient(
      authFor(firstRoomId, firstSecret, "준호", "Backend"),
    );

    expect(first.snapshot.participants).toHaveLength(1);
    expect(second.snapshot.participants).toHaveLength(2);
    await expect(joined).resolves.toMatchObject({
      participant: { id: second.snapshot.selfParticipantId, displayName: "준호" },
    });

    const left = waitForRoomEvent(first.socket, "participant.left");
    second.socket.disconnect();
    await expect(left).resolves.toMatchObject({
      participantId: second.snapshot.selfParticipantId,
    });
  });

  it("relays mic and speaking changes only inside the sender room", async () => {
    const first = await openClient(authFor(firstRoomId, firstSecret));
    const second = await openClient(
      authFor(firstRoomId, firstSecret, "준호", "Backend"),
    );
    const outsider = await openClient(authFor(secondRoomId, secondSecret, "리나", "QA"));
    const outsiderEvents: ServerRoomEvent[] = [];
    outsider.socket.on("room:event", (raw) => {
      const parsed = ServerRoomEventSchema.safeParse(raw);
      if (parsed.success) outsiderEvents.push(parsed.data);
    });

    const micChanged = waitForRoomEvent(second.socket, "participant.mic_changed");
    first.socket.emit("room:event", { type: "participant.mic_changed", muted: true });
    await expect(micChanged).resolves.toMatchObject({
      participantId: first.snapshot.selfParticipantId,
      muted: true,
    });

    const speakingChanged = waitForRoomEvent(
      second.socket,
      "participant.speaking_changed",
    );
    first.socket.emit("room:event", {
      type: "participant.speaking_changed",
      speaking: true,
    });
    await expect(speakingChanged).resolves.toMatchObject({
      participantId: first.snapshot.selfParticipantId,
      speaking: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(outsiderEvents).toEqual([]);
  });

  it("rejects a valid third participant with ROOM_FULL", async () => {
    await openClient(authFor(firstRoomId, firstSecret));
    await openClient(authFor(firstRoomId, firstSecret, "준호", "Backend"));

    const error = await expectRejected(
      authFor(firstRoomId, firstSecret, "Third", "Guest"),
    );

    expect(error.message).toBe("ROOM_FULL");
  });

  it("maps malformed auth and invalid capabilities to ROOM_UNAVAILABLE", async () => {
    const malformed = await expectRejected({
      roomId: "not-a-uuid",
      secret: "short",
      displayName: "",
      roleLabel: "",
    });
    const invalidCapability = await expectRejected(
      authFor(firstRoomId, "wrong-capability-secret-123456789"),
    );

    expect(malformed.message).toBe("ROOM_UNAVAILABLE");
    expect(invalidCapability.message).toBe("ROOM_UNAVAILABLE");
    expect(malformed.message).not.toContain("uuid");
    expect(repository.getMeetingId).not.toHaveBeenCalled();
  });

  it("rolls back an aborted admission before queued valid joins consume capacity", async () => {
    let releaseInsert: () => void = () => {};
    const insertGate = new Promise<void>((resolve) => {
      releaseInsert = resolve;
    });
    let releaseMarkLeft: () => void = () => {};
    const markLeftGate = new Promise<void>((resolve) => {
      releaseMarkLeft = resolve;
    });
    participantStore.insert.mockImplementationOnce(async () => insertGate);
    participantStore.markLeft.mockImplementationOnce(async () => markLeftGate);
    const joinSpy = vi.spyOn(rooms, "join");
    const aborted = connectSocket(baseUrl, {
      auth: authFor(firstRoomId, firstSecret, "Aborted", "Guest"),
      autoConnect: false,
      forceNew: true,
      reconnection: false,
      transports: ["websocket"],
    });
    clients.push(aborted);
    const transportClosedAtServer = new Promise<void>((resolve) => {
      io.engine.once("connection", (transport) => {
        transport.once("close", () => resolve());
      });
    });

    aborted.connect();
    await vi.waitFor(() => expect(participantStore.insert).toHaveBeenCalledTimes(1));
    const transportClosed = new Promise<void>((resolve) => {
      aborted.io.once("close", () => resolve());
    });
    aborted.close();
    await transportClosed;
    await transportClosedAtServer;

    const firstPending = openClient(authFor(firstRoomId, firstSecret));
    const secondPending = openClient(
      authFor(firstRoomId, firstSecret, "준호", "Backend"),
    );
    const pendingResults = Promise.allSettled([firstPending, secondPending]);
    await vi.waitFor(() => expect(joinSpy).toHaveBeenCalledTimes(3));

    let drainSettled = false;
    const draining = gateway.drain().then(() => {
      drainSettled = true;
    });
    await Promise.resolve();
    expect(drainSettled).toBe(false);

    releaseInsert();
    await vi.waitFor(() => expect(participantStore.markLeft).toHaveBeenCalledTimes(1));
    expect(drainSettled).toBe(false);
    releaseMarkLeft();

    const results = await pendingResults;
    await draining;
    expect(participantStore.markLeft).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const snapshots = results
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value.snapshot);
    expect(snapshots).toHaveLength(2);
    const selfParticipantIds = snapshots.map((snapshot) => snapshot.selfParticipantId);
    expect(new Set(selfParticipantIds).size).toBe(2);
    for (const snapshot of snapshots) {
      expect(snapshot.participants).toContainEqual(
        expect.objectContaining({ id: snapshot.selfParticipantId }),
      );
      expect(snapshot.participants.length).toBeGreaterThanOrEqual(1);
      expect(snapshot.participants.length).toBeLessThanOrEqual(2);
    }
    expect(snapshots.some((snapshot) => snapshot.participants.length === 2)).toBe(true);
    expect(
      rooms
        .snapshot(firstRoomId)
        .map((participant) => participant.id)
        .sort(),
    ).toEqual(selfParticipantIds.sort());
  });

  it("relays WebRTC signals only to a target in the same room", async () => {
    const first = await openClient(authFor(firstRoomId, firstSecret));
    const second = await openClient(
      authFor(firstRoomId, firstSecret, "준호", "Backend"),
    );
    const signal = waitForRoomEvent(second.socket, "webrtc.signal");

    first.socket.emit("room:event", {
      type: "webrtc.signal",
      targetId: second.snapshot.selfParticipantId,
      signal: { kind: "offer", sdp: "v=0" },
    });

    await expect(signal).resolves.toEqual({
      type: "webrtc.signal",
      fromId: first.snapshot.selfParticipantId,
      signal: { kind: "offer", sdp: "v=0" },
    });
  });

  it("does not relay WebRTC signals to a participant in another room", async () => {
    const target = await openClient(authFor(firstRoomId, firstSecret));
    const sender = await openClient(authFor(secondRoomId, secondSecret, "리나", "QA"));
    const targetSignals: ServerRoomEvent[] = [];
    target.socket.on("room:event", (raw) => {
      const parsed = ServerRoomEventSchema.safeParse(raw);
      if (parsed.success && parsed.data.type === "webrtc.signal") {
        targetSignals.push(parsed.data);
      }
    });
    const roomError = waitForRoomEvent(sender.socket, "room.error");

    sender.socket.emit("room:event", {
      type: "webrtc.signal",
      targetId: target.snapshot.selfParticipantId,
      signal: { kind: "answer", sdp: "v=0" },
    });

    await expect(roomError).resolves.toMatchObject({ code: "INVALID_TARGET" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(targetSignals).toEqual([]);
  });

  it("forwards every non-realtime event to hooks with room identity", async () => {
    const client = await openClient(authFor(firstRoomId, firstSecret));
    const events: ClientRoomEvent[] = [
      { type: "transcript.partial", itemId: "item-1", text: "진행 중" },
      {
        type: "transcript.final",
        itemId: "item-1",
        text: "최종 발화",
        startMs: 100,
        endMs: 500,
      },
      { type: "ai.ask", question: "보류 이유는?" },
      { type: "ai.stop" },
      { type: "decision.respond", token: "x".repeat(32), response: "확정" },
    ];

    for (const [index, event] of events.entries()) {
      client.socket.emit("room:event", event);
      await vi.waitFor(() => expect(hooks.onEvent).toHaveBeenCalledTimes(index + 1));
    }
    for (const event of events) {
      expect(hooks.onEvent).toHaveBeenCalledWith({
        roomId: firstRoomId,
        participantId: client.snapshot.selfParticipantId,
        event,
      });
    }
  });

  it("preserves non-realtime hook order while an earlier event is pending", async () => {
    let releaseFinal: () => void = () => {};
    const finalGate = new Promise<void>((resolve) => {
      releaseFinal = resolve;
    });
    const order: string[] = [];
    hooks.onEvent.mockImplementation(async ({ event }) => {
      order.push(`start:${event.type}`);
      if (event.type === "transcript.final") await finalGate;
      order.push(`end:${event.type}`);
    });
    const client = await openClient(authFor(firstRoomId, firstSecret));
    const invalidEvent = waitForRoomEvent(client.socket, "room.error");

    client.socket.emit("room:event", {
      type: "transcript.final",
      itemId: "item-ordered",
      text: "최종 발화",
      startMs: 100,
      endMs: 500,
    });
    client.socket.emit("room:event", { type: "ai.ask", question: "방금 발화는?" });
    client.socket.emit("room:event", { type: "participant.mic_changed", muted: "bad" });

    await invalidEvent;
    expect(hooks.onEvent).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["start:transcript.final"]);

    releaseFinal();
    await vi.waitFor(() => expect(hooks.onEvent).toHaveBeenCalledTimes(2));
    expect(order).toEqual([
      "start:transcript.final",
      "end:transcript.final",
      "start:ai.ask",
      "end:ai.ask",
    ]);
  });

  it("keeps participant context until accepted final transcripts finish after disconnect", async () => {
    let releaseFirstFinal: () => void = () => {};
    const firstFinalGate = new Promise<void>((resolve) => {
      releaseFirstFinal = resolve;
    });
    const participantWasPresent: boolean[] = [];
    hooks.onEvent.mockImplementation(async ({ roomId, participantId, event }) => {
      if (event.type !== "transcript.final") return;
      participantWasPresent.push(rooms.getParticipant(roomId, participantId) !== null);
      if (event.itemId === "item-first") await firstFinalGate;
    });
    const client = await openClient(authFor(firstRoomId, firstSecret));
    const invalidEvent = waitForRoomEvent(client.socket, "room.error");
    const serverSocket = io.sockets.sockets.get(client.socket.id ?? "");
    expect(serverSocket).toBeDefined();
    const disconnected = new Promise<void>((resolve) => {
      serverSocket?.once("disconnect", () => resolve());
    });

    client.socket.emit("room:event", {
      type: "transcript.final",
      itemId: "item-first",
      text: "첫 번째 최종 발화",
      startMs: 100,
      endMs: 500,
    });
    await vi.waitFor(() => expect(hooks.onEvent).toHaveBeenCalledTimes(1));
    client.socket.emit("room:event", {
      type: "transcript.final",
      itemId: "item-second",
      text: "두 번째 최종 발화",
      startMs: 600,
      endMs: 900,
    });
    client.socket.emit("room:event", { type: "participant.mic_changed", muted: "bad" });
    await invalidEvent;

    client.socket.disconnect();
    await disconnected;
    let drainSettled = false;
    const draining = gateway.drain().then(() => {
      drainSettled = true;
    });
    await Promise.resolve();
    expect(drainSettled).toBe(false);

    releaseFirstFinal();
    await draining;

    expect(participantWasPresent).toEqual([true, true]);
    expect(participantStore.markLeft).toHaveBeenCalledWith(
      client.snapshot.selfParticipantId,
    );
    expect(rooms.getParticipant(firstRoomId, client.snapshot.selfParticipantId)).toBeNull();
  });

  it("cancels an ai.ask that is still waiting for transcript persistence", async () => {
    let releaseFinal: () => void = () => {};
    const finalGate = new Promise<void>((resolve) => {
      releaseFinal = resolve;
    });
    hooks.onEvent.mockImplementation(async ({ event }) => {
      if (event.type === "transcript.final") await finalGate;
    });
    const client = await openClient(authFor(firstRoomId, firstSecret));
    const invalidEvent = waitForRoomEvent(client.socket, "room.error");

    client.socket.emit("room:event", {
      type: "transcript.final",
      itemId: "item-before-stop",
      text: "최종 발화",
      startMs: 100,
      endMs: 500,
    });
    client.socket.emit("room:event", { type: "ai.ask", question: "방금 발화는?" });
    client.socket.emit("room:event", { type: "ai.stop" });
    client.socket.emit("room:event", { type: "participant.mic_changed", muted: "bad" });

    await invalidEvent;
    expect(hooks.onEvent).toHaveBeenCalledTimes(2);
    expect(
      hooks.onEvent.mock.calls.some(([input]) => input.event.type === "ai.stop"),
    ).toBe(true);
    releaseFinal();
    await gateway.drain();
    expect(
      hooks.onEvent.mock.calls.some(([input]) => input.event.type === "ai.ask"),
    ).toBe(false);
  });

  it("does not block live transcript partials behind a pending ai.ask", async () => {
    let releaseAsk: () => void = () => {};
    const askGate = new Promise<void>((resolve) => {
      releaseAsk = resolve;
    });
    hooks.onEvent.mockImplementation(async ({ event }) => {
      if (event.type === "ai.ask") await askGate;
    });
    const client = await openClient(authFor(firstRoomId, firstSecret));
    client.socket.emit("room:event", { type: "ai.ask", question: "보류 이유는?" });
    await vi.waitFor(() => expect(hooks.onEvent).toHaveBeenCalledTimes(1));
    const invalidEvent = waitForRoomEvent(client.socket, "room.error");

    client.socket.emit("room:event", {
      type: "transcript.partial",
      itemId: "item-live",
      text: "진행 중",
    });
    client.socket.emit("room:event", { type: "participant.mic_changed", muted: "bad" });

    await invalidEvent;
    expect(hooks.onEvent).toHaveBeenCalledTimes(2);
    expect(hooks.onEvent.mock.calls[1]?.[0].event).toEqual({
      type: "transcript.partial",
      itemId: "item-live",
      text: "진행 중",
    });
    releaseAsk();
    await gateway.drain();
  });

  it("rejects malformed room events without invoking hooks", async () => {
    const client = await openClient(authFor(firstRoomId, firstSecret));
    const roomError = waitForRoomEvent(client.socket, "room.error");

    client.socket.emit("room:event", {
      type: "participant.mic_changed",
      muted: "yes",
    });

    await expect(roomError).resolves.toMatchObject({ code: "INVALID_EVENT" });
    expect(hooks.onEvent).not.toHaveBeenCalled();
  });
});
