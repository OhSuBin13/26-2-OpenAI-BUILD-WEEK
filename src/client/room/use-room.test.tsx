// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Participant } from "../../shared/domain";
import type { ServerRoomEvent } from "../../shared/events";
import {
  createPeerAudioSession,
  type PeerAudioSession,
} from "../audio/peer-audio";
import { createRoomSocket, type RoomSocket } from "./room-socket";
import { useRoom } from "./use-room";

vi.mock("../audio/peer-audio", () => ({ createPeerAudioSession: vi.fn() }));
vi.mock("./room-socket", () => ({ createRoomSocket: vi.fn() }));

const SELF_ID = "00000000-0000-4000-8000-000000000001";
const REMOTE_ID = "00000000-0000-4000-8000-000000000002";
const NEW_SELF_ID = "00000000-0000-4000-8000-000000000003";
const joinInput = {
  roomId: "00000000-0000-4000-8000-000000000010",
  secret: "room-capability-secret-123456789",
  displayName: "민지",
  roleLabel: "PM",
};

const participant = (
  id: string,
  displayName: string,
  overrides: Partial<Participant> = {},
): Participant => ({
  id,
  displayName,
  roleLabel: id === SELF_ID ? "PM" : "Engineer",
  muted: false,
  speaking: false,
  connected: true,
  ...overrides,
});

class FakeAudioTrack {
  enabled = true;
  readonly kind = "audio";
  stop = vi.fn();
}

class FakeMediaStream {
  constructor(private readonly tracks: FakeAudioTrack[]) {}

  getTracks() {
    return this.tracks;
  }

  getAudioTracks() {
    return this.tracks;
  }
}

function createSocketDouble() {
  let listener: ((event: ServerRoomEvent) => void) | null = null;
  const unsubscribe = vi.fn(() => {
    listener = null;
  });
  const socket: RoomSocket = {
    connect: vi.fn(async () => undefined),
    send: vi.fn(),
    subscribe: vi.fn((nextListener) => {
      listener = nextListener;
      return unsubscribe;
    }),
    close: vi.fn(),
  };
  return {
    socket,
    unsubscribe,
    dispatch(event: ServerRoomEvent) {
      listener?.(event);
    },
  };
}

describe("useRoom", () => {
  let track: FakeAudioTrack;
  let localStream: FakeMediaStream;
  let getUserMedia: ReturnType<typeof vi.fn>;
  let socketDouble: ReturnType<typeof createSocketDouble>;
  let peerRecords: Array<{
    input: Parameters<typeof createPeerAudioSession>[0];
    session: PeerAudioSession & {
      start: ReturnType<typeof vi.fn>;
      handleSignal: ReturnType<typeof vi.fn>;
      setMuted: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };
  }>;
  let originalMediaDevices: PropertyDescriptor | undefined;

  beforeEach(() => {
    track = new FakeAudioTrack();
    localStream = new FakeMediaStream([track]);
    getUserMedia = vi.fn(async () => localStream as unknown as MediaStream);
    originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);

    socketDouble = createSocketDouble();
    vi.mocked(createRoomSocket).mockReset();
    vi.mocked(createRoomSocket).mockReturnValue(socketDouble.socket);
    peerRecords = [];
    vi.mocked(createPeerAudioSession).mockReset();
    vi.mocked(createPeerAudioSession).mockImplementation((input) => {
      const session = {
        start: vi.fn(async () => undefined),
        handleSignal: vi.fn(async () => undefined),
        setMuted: vi.fn(),
        close: vi.fn(),
      };
      peerRecords.push({ input, session });
      return session;
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    if (originalMediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
    } else {
      Reflect.deleteProperty(navigator, "mediaDevices");
    }
  });

  async function join(result: ReturnType<typeof renderHook<ReturnType<typeof useRoom>, unknown>>["result"]) {
    await act(async () => {
      await result.current.join(joinInput);
    });
  }

  it("requests the exact audio-only stream only after join and subscribes before connecting", async () => {
    const { result } = renderHook(() => useRoom());
    const audio = document.createElement("audio");
    result.current.remoteAudioRef.current = audio;

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(createRoomSocket).not.toHaveBeenCalled();

    await join(result);

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    expect(createRoomSocket).toHaveBeenCalledWith(joinInput);
    expect(socketDouble.socket.subscribe).toHaveBeenCalledTimes(1);
    expect(socketDouble.socket.connect).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(socketDouble.socket.subscribe).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(socketDouble.socket.connect).mock.invocationCallOrder[0]);
    expect(audio.play).toHaveBeenCalled();
    expect(result.current.status).toBe("connecting");
  });

  it("replaces snapshots, upserts joins, and keeps at most one peer for one remote", async () => {
    const { result } = renderHook(() => useRoom());
    await join(result);

    await act(async () => {
      socketDouble.dispatch({
        type: "room.snapshot",
        selfParticipantId: SELF_ID,
        participants: [participant(SELF_ID, "민지"), participant(REMOTE_ID, "준호")],
      });
    });
    expect(result.current.status).toBe("connected");
    expect(result.current.participants.map(({ id }) => id)).toEqual([
      SELF_ID,
      REMOTE_ID,
    ]);
    expect(peerRecords).toHaveLength(1);
    expect(peerRecords[0].session.start).toHaveBeenCalledTimes(1);

    await act(async () => {
      socketDouble.dispatch({
        type: "participant.joined",
        participant: participant(REMOTE_ID, "준호", { speaking: true }),
      });
    });
    expect(result.current.participants).toHaveLength(2);
    expect(result.current.participants.find(({ id }) => id === REMOTE_ID)?.speaking).toBe(
      true,
    );
    expect(peerRecords).toHaveLength(1);

    await act(async () => {
      socketDouble.dispatch({
        type: "room.snapshot",
        selfParticipantId: SELF_ID,
        participants: [participant(SELF_ID, "민지")],
      });
    });
    expect(result.current.participants).toEqual([participant(SELF_ID, "민지")]);
    expect(peerRecords[0].session.close).toHaveBeenCalledTimes(1);

    await act(async () => {
      socketDouble.dispatch({
        type: "room.snapshot",
        selfParticipantId: NEW_SELF_ID,
        participants: [
          participant(NEW_SELF_ID, "민지", { roleLabel: "PM" }),
          participant(REMOTE_ID, "준호"),
        ],
      });
    });
    expect(result.current.selfParticipantId).toBe(NEW_SELF_ID);
    expect(peerRecords).toHaveLength(2);
    expect(peerRecords[1].input.localParticipantId).toBe(NEW_SELF_ID);
    expect(peerRecords[1].input.remoteParticipantId).toBe(REMOTE_ID);
  });

  it("queues signals until peer creation and routes peer signal and speaking callbacks", async () => {
    const { result } = renderHook(() => useRoom());
    await join(result);
    const earlySignal = {
      kind: "ice" as const,
      candidate: "early-candidate",
      sdpMid: "audio",
      sdpMLineIndex: 0,
    };

    act(() => {
      socketDouble.dispatch({
        type: "webrtc.signal",
        fromId: REMOTE_ID,
        signal: earlySignal,
      });
    });
    expect(peerRecords).toHaveLength(0);

    await act(async () => {
      socketDouble.dispatch({
        type: "room.snapshot",
        selfParticipantId: SELF_ID,
        participants: [participant(SELF_ID, "민지"), participant(REMOTE_ID, "준호")],
      });
      await Promise.resolve();
    });
    expect(peerRecords[0].session.handleSignal).toHaveBeenCalledWith(earlySignal);
    expect(peerRecords[0].session.start.mock.invocationCallOrder[0]).toBeLessThan(
      peerRecords[0].session.handleSignal.mock.invocationCallOrder[0],
    );

    act(() => {
      peerRecords[0].input.onSignal({ kind: "offer", sdp: "offer-sdp" });
      peerRecords[0].input.onLocalSpeaking(true);
    });
    expect(socketDouble.socket.send).toHaveBeenCalledWith({
      type: "webrtc.signal",
      targetId: REMOTE_ID,
      signal: { kind: "offer", sdp: "offer-sdp" },
    });
    expect(socketDouble.socket.send).toHaveBeenCalledWith({
      type: "participant.speaking_changed",
      speaking: true,
    });
    expect(result.current.participants.find(({ id }) => id === SELF_ID)?.speaking).toBe(
      true,
    );
  });

  it("mutes local tracks and avatar state even when no remote peer exists", async () => {
    const { result } = renderHook(() => useRoom());
    await join(result);
    act(() => {
      socketDouble.dispatch({
        type: "room.snapshot",
        selfParticipantId: SELF_ID,
        participants: [participant(SELF_ID, "민지")],
      });
    });

    act(() => result.current.toggleMute());

    expect(track.enabled).toBe(false);
    expect(result.current.muted).toBe(true);
    expect(result.current.participants[0].muted).toBe(true);
    expect(socketDouble.socket.send).toHaveBeenCalledWith({
      type: "participant.mic_changed",
      muted: true,
    });

    act(() => result.current.toggleMute());
    expect(track.enabled).toBe(true);
    expect(result.current.muted).toBe(false);
    expect(socketDouble.socket.send).toHaveBeenCalledWith({
      type: "participant.mic_changed",
      muted: false,
    });
  });

  it("reports a room operation error without marking an established socket disconnected", async () => {
    const { result } = renderHook(() => useRoom());
    await join(result);
    act(() => {
      socketDouble.dispatch({
        type: "room.snapshot",
        selfParticipantId: SELF_ID,
        participants: [participant(SELF_ID, "민지")],
      });
      socketDouble.dispatch({
        type: "room.error",
        code: "INVALID_TARGET",
        message: "Target participant is unavailable",
      });
    });

    expect(result.current.status).toBe("connected");
    expect(result.current.error).toBe("Target participant is unavailable");

    act(() => result.current.toggleMute());
    expect(track.enabled).toBe(false);
  });

  it("attaches remote audio, handles play rejection, and retains local media on remote leave", async () => {
    const { result, unmount } = renderHook(() => useRoom());
    const audio = document.createElement("audio");
    Object.defineProperty(audio, "srcObject", {
      configurable: true,
      writable: true,
      value: null,
    });
    result.current.remoteAudioRef.current = audio;
    await join(result);
    vi.mocked(audio.play).mockRejectedValueOnce(new DOMException("blocked"));
    await act(async () => {
      socketDouble.dispatch({
        type: "room.snapshot",
        selfParticipantId: SELF_ID,
        participants: [participant(SELF_ID, "민지"), participant(REMOTE_ID, "준호")],
      });
      await Promise.resolve();
    });
    const remoteStream = new FakeMediaStream([
      new FakeAudioTrack(),
    ]) as unknown as MediaStream;

    await act(async () => {
      peerRecords[0].input.onRemoteStream(remoteStream);
      await Promise.resolve();
    });
    expect(audio.srcObject).toBe(remoteStream);
    expect(audio.play).toHaveBeenCalledTimes(2);

    act(() => peerRecords[0].input.onLocalSpeaking(true));
    expect(result.current.participants[0].speaking).toBe(true);
    peerRecords[0].session.close.mockImplementationOnce(() => {
      peerRecords[0].input.onLocalSpeaking(false);
    });
    act(() => {
      socketDouble.dispatch({ type: "participant.left", participantId: REMOTE_ID });
    });
    expect(peerRecords[0].session.close).toHaveBeenCalledTimes(1);
    expect(audio.srcObject).toBeNull();
    expect(track.stop).not.toHaveBeenCalled();
    expect(result.current.participants).toEqual([participant(SELF_ID, "민지")]);
    expect(socketDouble.socket.send).toHaveBeenLastCalledWith({
      type: "participant.speaking_changed",
      speaking: false,
    });

    unmount();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(socketDouble.unsubscribe).toHaveBeenCalledTimes(1);
    expect(socketDouble.socket.close).toHaveBeenCalledTimes(1);
  });

  it("ignores a retired peer failure after the remote participant leaves", async () => {
    let rejectStart!: (error: Error) => void;
    vi.mocked(createPeerAudioSession).mockImplementationOnce((input) => {
      const session = {
        start: vi.fn(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectStart = reject;
            }),
        ),
        handleSignal: vi.fn(async () => undefined),
        setMuted: vi.fn(),
        close: vi.fn(),
      };
      peerRecords.push({ input, session });
      return session;
    });
    const { result } = renderHook(() => useRoom());
    await join(result);
    act(() => {
      socketDouble.dispatch({
        type: "room.snapshot",
        selfParticipantId: SELF_ID,
        participants: [participant(SELF_ID, "민지"), participant(REMOTE_ID, "준호")],
      });
      socketDouble.dispatch({
        type: "participant.left",
        participantId: REMOTE_ID,
      });
    });

    await act(async () => {
      rejectStart(new Error("late negotiation failure"));
      await Promise.resolve();
    });

    expect(peerRecords[0].session.close).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });

  it("stops acquired media and explains when the room is already full", async () => {
    vi.mocked(socketDouble.socket.connect).mockRejectedValueOnce(
      new Error("ROOM_FULL"),
    );
    const { result } = renderHook(() => useRoom());

    await join(result);

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("This room already has two people.");
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(socketDouble.unsubscribe).toHaveBeenCalledTimes(1);
    expect(socketDouble.socket.close).toHaveBeenCalledTimes(1);
    expect(result.current.participants).toEqual([]);
  });

  it("keeps the generic recoverable message for other join failures", async () => {
    vi.mocked(socketDouble.socket.connect).mockRejectedValueOnce(
      new Error("network unavailable"),
    );
    const { result } = renderHook(() => useRoom());

    await join(result);

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("회의실에 연결하지 못했습니다.");
    expect(track.stop).toHaveBeenCalledTimes(1);
  });
});
