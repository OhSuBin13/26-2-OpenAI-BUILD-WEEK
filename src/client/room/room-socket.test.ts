import { beforeEach, describe, expect, it, vi } from "vitest";
import { io } from "socket.io-client";
import { createRoomSocket } from "./room-socket";

vi.mock("socket.io-client", () => ({ io: vi.fn() }));

const auth = {
  roomId: "00000000-0000-4000-8000-000000000010",
  secret: "room-capability-secret-123456789",
  displayName: "민지",
  roleLabel: "PM",
};

function createSocketDouble() {
  const roomListeners = new Set<(payload: unknown) => void>();
  const lifecycleListeners = new Map<string, Set<(payload?: unknown) => void>>();
  const callOrder: string[] = [];
  const socket = {
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      callOrder.push(`on:${event}`);
      if (event === "room:event") roomListeners.add(listener);
      return socket;
    }),
    once: vi.fn((event: string, listener: (payload?: unknown) => void) => {
      callOrder.push(`once:${event}`);
      const listeners = lifecycleListeners.get(event) ?? new Set();
      listeners.add(listener);
      lifecycleListeners.set(event, listeners);
      return socket;
    }),
    off: vi.fn((event: string, listener: (payload: unknown) => void) => {
      callOrder.push(`off:${event}`);
      if (event === "room:event") roomListeners.delete(listener);
      lifecycleListeners.get(event)?.delete(listener);
      return socket;
    }),
    emit: vi.fn(() => socket),
    connect: vi.fn(() => {
      callOrder.push("connect");
      return socket;
    }),
    close: vi.fn(() => socket),
  };

  return {
    callOrder,
    socket,
    dispatch(payload: unknown) {
      roomListeners.forEach((listener) => listener(payload));
    },
    dispatchLifecycle(event: string, payload?: unknown) {
      const listeners = [...(lifecycleListeners.get(event) ?? [])];
      lifecycleListeners.delete(event);
      listeners.forEach((listener) => listener(payload));
    },
  };
}

describe("createRoomSocket", () => {
  beforeEach(() => {
    vi.mocked(io).mockReset();
  });

  it("uses exact room auth, websocket transport, and explicit connection", async () => {
    const fake = createSocketDouble();
    vi.mocked(io).mockReturnValue(fake.socket as never);

    const roomSocket = createRoomSocket(auth);

    expect(io).toHaveBeenCalledWith({
      auth,
      autoConnect: false,
      transports: ["websocket"],
    });
    expect(fake.socket.connect).not.toHaveBeenCalled();

    const connected = roomSocket.connect();
    expect(fake.socket.connect).toHaveBeenCalledTimes(1);
    fake.dispatchLifecycle("connect");
    await expect(connected).resolves.toBeUndefined();
  });

  it("allows subscribing before the explicit connect call", () => {
    const fake = createSocketDouble();
    vi.mocked(io).mockReturnValue(fake.socket as never);
    const roomSocket = createRoomSocket(auth);

    roomSocket.subscribe(vi.fn());
    void roomSocket.connect();

    expect(fake.callOrder.indexOf("on:room:event")).toBeLessThan(
      fake.callOrder.indexOf("connect"),
    );
  });

  it("rejects the explicit connection lifecycle on connect_error", async () => {
    const fake = createSocketDouble();
    vi.mocked(io).mockReturnValue(fake.socket as never);
    const roomSocket = createRoomSocket(auth);

    const connected = roomSocket.connect();
    fake.dispatchLifecycle("connect_error", new Error("ROOM_FULL"));

    await expect(connected).rejects.toThrow("ROOM_FULL");
  });

  it("parses valid inbound room events and drops invalid payloads", () => {
    const fake = createSocketDouble();
    vi.mocked(io).mockReturnValue(fake.socket as never);
    const roomSocket = createRoomSocket(auth);
    const listener = vi.fn();
    roomSocket.subscribe(listener);

    const snapshot = {
      type: "room.snapshot",
      selfParticipantId: "00000000-0000-4000-8000-000000000001",
      participants: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          displayName: "민지",
          roleLabel: "PM",
          muted: false,
          speaking: false,
          connected: true,
        },
      ],
    };
    fake.dispatch(snapshot);
    fake.dispatch({ type: "participant.left", participantId: "not-a-uuid" });
    fake.dispatch({ type: "invented.event" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(snapshot);
  });

  it("sends typed events and supports explicit unsubscribe and idempotent close", () => {
    const fake = createSocketDouble();
    vi.mocked(io).mockReturnValue(fake.socket as never);
    const roomSocket = createRoomSocket(auth);
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    const unsubscribeFirst = roomSocket.subscribe(firstListener);
    roomSocket.subscribe(secondListener);

    roomSocket.send({ type: "participant.mic_changed", muted: true });
    expect(fake.socket.emit).toHaveBeenCalledWith("room:event", {
      type: "participant.mic_changed",
      muted: true,
    });

    unsubscribeFirst();
    unsubscribeFirst();
    fake.dispatch({
      type: "participant.left",
      participantId: "00000000-0000-4000-8000-000000000002",
    });
    expect(firstListener).not.toHaveBeenCalled();
    expect(secondListener).toHaveBeenCalledTimes(1);

    roomSocket.close();
    roomSocket.close();
    expect(fake.socket.off).toHaveBeenCalledTimes(2);
    expect(fake.socket.close).toHaveBeenCalledTimes(1);
    fake.dispatch({
      type: "participant.left",
      participantId: "00000000-0000-4000-8000-000000000002",
    });
    expect(secondListener).toHaveBeenCalledTimes(1);
  });
});
