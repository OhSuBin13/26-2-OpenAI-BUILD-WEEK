import { io } from "socket.io-client";
import {
  ServerRoomEventSchema,
  type ClientRoomEvent,
  type ServerRoomEvent,
} from "../../shared/events";

export interface RoomSocketAuth {
  roomId: string;
  secret: string;
  displayName: string;
  roleLabel: string;
}

export interface RoomSocket {
  connect(): Promise<void>;
  send(event: ClientRoomEvent): void;
  subscribe(listener: (event: ServerRoomEvent) => void): () => void;
  close(): void;
}

export function createRoomSocket(auth: RoomSocketAuth): RoomSocket {
  const socket = io({
    auth,
    autoConnect: false,
    transports: ["websocket"],
  });
  const inboundListeners = new Set<(payload: unknown) => void>();
  let closed = false;
  let connectionPromise: Promise<void> | null = null;
  let rejectPendingConnection: ((error: Error) => void) | null = null;

  return {
    connect() {
      if (closed) return Promise.reject(new Error("Room socket is closed"));
      if (socket.connected) return Promise.resolve();
      if (connectionPromise) return connectionPromise;

      connectionPromise = new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          socket.off("connect", handleConnect);
          socket.off("connect_error", handleConnectError);
          rejectPendingConnection = null;
          connectionPromise = null;
        };
        const handleConnect = () => {
          cleanup();
          resolve();
        };
        const handleConnectError = (error: unknown) => {
          cleanup();
          reject(
            error instanceof Error
              ? error
              : new Error("Room socket connection failed"),
          );
        };
        rejectPendingConnection = (error) => {
          cleanup();
          reject(error);
        };
        socket.once("connect", handleConnect);
        socket.once("connect_error", handleConnectError);
        try {
          socket.connect();
        } catch (error) {
          handleConnectError(error);
        }
      });
      return connectionPromise;
    },

    send(event) {
      if (!closed) socket.emit("room:event", event);
    },

    subscribe(listener) {
      if (closed) return () => undefined;
      const handleInbound = (payload: unknown) => {
        const parsed = ServerRoomEventSchema.safeParse(payload);
        if (parsed.success) listener(parsed.data);
      };
      inboundListeners.add(handleInbound);
      socket.on("room:event", handleInbound);
      let subscribed = true;

      return () => {
        if (!subscribed) return;
        subscribed = false;
        inboundListeners.delete(handleInbound);
        socket.off("room:event", handleInbound);
      };
    },

    close() {
      if (closed) return;
      closed = true;
      rejectPendingConnection?.(new Error("Room socket closed while connecting"));
      inboundListeners.forEach((listener) => {
        socket.off("room:event", listener);
      });
      inboundListeners.clear();
      socket.close();
    },
  };
}
