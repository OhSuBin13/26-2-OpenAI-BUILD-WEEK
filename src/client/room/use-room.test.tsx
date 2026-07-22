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
import { createRealtimeTranscription } from "../transcript/realtime-transcription";
import { createRoomSocket, type RoomSocket } from "./room-socket";
import { useRoom } from "./use-room";

vi.mock("../audio/peer-audio", () => ({ createPeerAudioSession: vi.fn() }));
vi.mock("../transcript/realtime-transcription", () => ({
  createRealtimeTranscription: vi.fn(),
}));
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
  private enabledValue = true;
  readonly kind = "audio";
  stop = vi.fn();
  setEnabled = vi.fn((next: boolean) => {
    this.enabledValue = next;
  });

  get enabled() {
    return this.enabledValue;
  }

  set enabled(next: boolean) {
    this.setEnabled(next);
  }
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
  let transcriptionRecords: Array<{
    input: Parameters<typeof createRealtimeTranscription>[0];
    session: ReturnType<typeof createRealtimeTranscription> & {
      start: ReturnType<typeof vi.fn>;
      commit: ReturnType<typeof vi.fn>;
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
    transcriptionRecords = [];
    vi.mocked(createRealtimeTranscription).mockReset();
    vi.mocked(createRealtimeTranscription).mockImplementation((input) => {
      const session = {
        start: vi.fn(async () => undefined),
        commit: vi.fn(),
        setMuted: vi.fn(),
        close: vi.fn(async () => undefined),
      };
      transcriptionRecords.push({ input, session });
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

  it("starts one transcription per snapshot identity with the same microphone stream", async () => {
    const { result } = renderHook(() => useRoom());
    await join(result);

    expect(createRealtimeTranscription).not.toHaveBeenCalled();

    act(() => {
      socketDouble.dispatch({
        type: "room.snapshot",
        selfParticipantId: SELF_ID,
        meetingElapsedMs: 42_000,
        participants: [participant(SELF_ID, "민지")],
      });
      socketDouble.dispatch({
        type: "room.snapshot",
        selfParticipantId: SELF_ID,
        meetingElapsedMs: 43_000,
        participants: [participant(SELF_ID, "민지")],
      });
    });

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(createRealtimeTranscription).toHaveBeenCalledTimes(1);
    expect(transcriptionRecords[0].input).toEqual(
      expect.objectContaining({
        stream: localStream,
        roomId: joinInput.roomId,
        participantId: SELF_ID,
        secret: joinInput.secret,
        meetingOffsetMs: 42_000,
      }),
    );
    expect(transcriptionRecords[0].session.start).toHaveBeenCalledTimes(1);
  });

  it("replaces transcription for a changed self identity and ignores its retired callbacks and failure", async () => {
    let rejectFirstStart!: (error: Error) => void;
    vi.mocked(createRealtimeTranscription).mockImplementationOnce((input) => {
      const session = {
        start: vi.fn(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectFirstStart = reject;
            }),
        ),
        commit: vi.fn(),
        setMuted: vi.fn(),
        close: vi.fn(async () => undefined),
      };
      transcriptionRecords.push({ input, session });
      return session;
    });
    const { result } = renderHook(() => useRoom());
    await join(result);
    act(() => {
      socketDouble.dispatch({
        type: "room.snapshot",
        selfParticipantId: SELF_ID,
        participants: [participant(SELF_ID, "민지")],
      });
      socketDouble.dispatch({
        type: "room.snapshot",
        selfParticipantId: NEW_SELF_ID,
        participants: [participant(NEW_SELF_ID, "민지", { roleLabel: "PM" })],
      });
    });

    expect(transcriptionRecords).toHaveLength(2);
    expect(transcriptionRecords[0].session.close).toHaveBeenCalledTimes(1);
    expect(transcriptionRecords[1].input.participantId).toBe(NEW_SELF_ID);

    act(() => {
      transcriptionRecords[0].input.onPartial("retired-item", "무시");
      transcriptionRecords[0].input.onFinal("retired-item", "무시", 0, 10);
    });
    await act(async () => {
      rejectFirstStart(new Error("late transcription failure"));
      await Promise.resolve();
    });

    expect(socketDouble.socket.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "retired-item" }),
    );
    expect(result.current.status).toBe("connected");
    expect(result.current.error).toBeNull();
  });

  it("keeps the room connected when the active transcription cannot start", async () => {
    vi.mocked(createRealtimeTranscription).mockImplementationOnce((input) => {
      const session = {
        start: vi.fn(async () => {
          throw new Error("transcription unavailable");
        }),
        commit: vi.fn(),
        setMuted: vi.fn(),
        close: vi.fn(async () => undefined),
      };
      transcriptionRecords.push({ input, session });
      return session;
    });
    const { result } = renderHook(() => useRoom());
    await join(result);

    await act(async () => {
      socketDouble.dispatch({
        type: "room.snapshot",
        selfParticipantId: SELF_ID,
        participants: [participant(SELF_ID, "민지")],
      });
      await Promise.resolve();
    });

    expect(result.current.status).toBe("connected");
    expect(result.current.error).toBe("실시간 회의록을 시작하지 못했습니다.");
    expect(track.stop).not.toHaveBeenCalled();
    expect(socketDouble.socket.close).not.toHaveBeenCalled();
    expect(transcriptionRecords[0].session.close).toHaveBeenCalledTimes(1);

    await act(async () => {
      socketDouble.dispatch({
        type: "room.snapshot",
        selfParticipantId: SELF_ID,
        participants: [participant(SELF_ID, "민지")],
      });
      await Promise.resolve();
    });
    expect(transcriptionRecords).toHaveLength(2);
    expect(transcriptionRecords[1].session.start).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });

  it("keeps the room and peer connected when transcription construction throws", async () => {
    vi.mocked(createRealtimeTranscription).mockImplementationOnce(() => {
      throw new Error("RTCPeerConnection unavailable");
    });
    const { result } = renderHook(() => useRoom());
    await join(result);

    act(() => {
      socketDouble.dispatch({
        type: "room.snapshot",
        selfParticipantId: SELF_ID,
        participants: [participant(SELF_ID, "민지"), participant(REMOTE_ID, "준호")],
      });
    });

    expect(result.current.status).toBe("connected");
    expect(result.current.error).toBe("실시간 회의록을 시작하지 못했습니다.");
    expect(peerRecords).toHaveLength(1);
    expect(track.stop).not.toHaveBeenCalled();
    expect(socketDouble.socket.close).not.toHaveBeenCalled();
  });

  it("reports an established transcription channel failure and retries on a later snapshot", async () => {
    const { result } = renderHook(() => useRoom());
    await join(result);
    act(() => {
      socketDouble.dispatch({
        type: "room.snapshot",
        selfParticipantId: SELF_ID,
        participants: [participant(SELF_ID, "민지")],
      });
    });

    act(() => transcriptionRecords[0].input.onError?.());

    expect(result.current.status).toBe("connected");
    expect(result.current.error).toBe("실시간 회의록을 시작하지 못했습니다.");
    expect(transcriptionRecords[0].session.close).toHaveBeenCalledTimes(1);
    expect(track.stop).not.toHaveBeenCalled();
    expect(socketDouble.socket.close).not.toHaveBeenCalled();

    await act(async () => {
      socketDouble.dispatch({
        type: "room.snapshot",
        selfParticipantId: SELF_ID,
        participants: [participant(SELF_ID, "민지")],
      });
      await Promise.resolve();
    });

    expect(transcriptionRecords).toHaveLength(2);
    expect(result.current.error).toBeNull();
  });

  it("applies the current muted snapshot to a replacement transcription before the track", async () => {
    const { result } = renderHook(() => useRoom());
    await join(result);
    const mutedSelf = participant(SELF_ID, "민지", { muted: true });
    act(() => {
      socketDouble.dispatch({
        type: "room.snapshot",
        selfParticipantId: SELF_ID,
        participants: [mutedSelf],
      });
    });
    act(() => transcriptionRecords[0].input.onError?.());
    track.setEnabled.mockClear();

    await act(async () => {
      socketDouble.dispatch({
        type: "room.snapshot",
        selfParticipantId: SELF_ID,
        participants: [mutedSelf],
      });
      await Promise.resolve();
    });

    expect(transcriptionRecords).toHaveLength(2);
    expect(transcriptionRecords[1].session.setMuted).toHaveBeenCalledWith(true);
    expect(
      transcriptionRecords[1].session.setMuted.mock.invocationCallOrder[0],
    ).toBeLessThan(track.setEnabled.mock.invocationCallOrder[0]);
  });

  it("forwards local transcript events and invokes Recap once from single or split final phrases", async () => {
    const { result } = renderHook(() => useRoom());
    await join(result);
    act(() => {
      socketDouble.dispatch({
        type: "room.snapshot",
        selfParticipantId: SELF_ID,
        participants: [participant(SELF_ID, "민지")],
      });
    });
    const { input } = transcriptionRecords[0];

    act(() => {
      input.onPartial("partial-only", "리캡아, 무시해");
      input.onFinal("single", "recap, 이번 결정은 뭐야?", 100, 300);
      input.onFinal("single", "recap, 이번 결정은 뭐야?", 100, 300);
      input.onFinal("split-prefix", "리캡아", 400, 500);
      input.onFinal("split-question", "다음 일정은 언제야?", 500, 800);
      input.onFinal("after-trigger", "추가 발화", 800, 900);
      input.onFinal("reverse-question", "역순 완료 질문은 뭐야?", 1_200, 1_500);
      input.onFinal("reverse-prefix", "리캡아", 900, 1_200);
    });

    expect(socketDouble.socket.send).toHaveBeenCalledWith({
      type: "transcript.partial",
      itemId: "partial-only",
      text: "리캡아, 무시해",
    });
    expect(socketDouble.socket.send).toHaveBeenCalledWith({
      type: "transcript.final",
      itemId: "single",
      text: "recap, 이번 결정은 뭐야?",
      startMs: 100,
      endMs: 300,
    });
    const asks = vi
      .mocked(socketDouble.socket.send)
      .mock.calls.map(([event]) => event)
      .filter((event) => event.type === "ai.ask");
    expect(asks).toEqual([
      { type: "ai.ask", question: "이번 결정은 뭐야?" },
      { type: "ai.ask", question: "다음 일정은 언제야?" },
      { type: "ai.ask", question: "역순 완료 질문은 뭐야?" },
    ]);
    expect(
      vi.mocked(socketDouble.socket.send).mock.calls.filter(
        ([event]) => event.type === "transcript.final" && event.itemId === "single",
      ),
    ).toHaveLength(1);
    expect(result.current.transcriptFinals).toEqual([]);
    expect(result.current.transcriptPartials).toEqual([]);
    const finalCall = vi.mocked(socketDouble.socket.send).mock.calls.findIndex(
      ([event]) => event.type === "transcript.final" && event.itemId === "single",
    );
    const askCall = vi.mocked(socketDouble.socket.send).mock.calls.findIndex(
      ([event]) => event.type === "ai.ask" && event.question === "이번 결정은 뭐야?",
    );
    expect(finalCall).toBeLessThan(askCall);
  });

  it("accumulates synchronized partials, finalizes them idempotently, and ignores late deltas", async () => {
    const { result } = renderHook(() => useRoom());
    await join(result);
    act(() => {
      socketDouble.dispatch({
        type: "room.snapshot",
        selfParticipantId: SELF_ID,
        participants: [participant(SELF_ID, "민지"), participant(REMOTE_ID, "준호")],
      });
      socketDouble.dispatch({
        type: "transcript.partial",
        participantId: REMOTE_ID,
        itemId: "remote-item",
        text: "안녕",
      });
      socketDouble.dispatch({
        type: "transcript.partial",
        participantId: REMOTE_ID,
        itemId: "remote-item",
        text: "하세요",
      });
    });
    expect(result.current.transcriptPartials).toEqual([
      { participantId: REMOTE_ID, itemId: "remote-item", text: "안녕하세요" },
    ]);

    act(() => {
      socketDouble.dispatch({
        type: "transcript.partial",
        participantId: REMOTE_ID,
        itemId: "failed-item",
        text: "지워질 중간 기록",
      });
      socketDouble.dispatch({
        type: "transcript.partial",
        participantId: REMOTE_ID,
        itemId: "failed-item",
        text: "",
      });
    });
    expect(result.current.transcriptPartials).toEqual([
      { participantId: REMOTE_ID, itemId: "remote-item", text: "안녕하세요" },
    ]);

    const finalSegment = {
      id: "00000000-0000-4000-8000-000000000099",
      itemId: "remote-item",
      participantId: REMOTE_ID,
      displayName: "준호",
      text: "안녕하세요",
      startMs: 1_000,
      endMs: 2_000,
    };
    act(() => {
      socketDouble.dispatch({ type: "transcript.final", segment: finalSegment });
      socketDouble.dispatch({ type: "transcript.final", segment: finalSegment });
      socketDouble.dispatch({
        type: "transcript.partial",
        participantId: REMOTE_ID,
        itemId: "remote-item",
        text: " 늦은 델타",
      });
    });

    expect(result.current.transcriptFinals).toEqual([finalSegment]);
    expect(result.current.transcriptPartials).toEqual([]);

    await act(async () => {
      await result.current.join({ ...joinInput, displayName: "재입장" });
    });
    expect(result.current.transcriptFinals).toEqual([]);
    expect(result.current.transcriptPartials).toEqual([]);

    act(() => {
      socketDouble.dispatch({
        type: "room.snapshot",
        selfParticipantId: SELF_ID,
        participants: [participant(SELF_ID, "재입장")],
      });
      socketDouble.dispatch({
        type: "transcript.partial",
        participantId: SELF_ID,
        itemId: "new-join-item",
        text: "새 기록",
      });
    });
    expect(result.current.transcriptPartials).toHaveLength(1);

    await act(async () => {
      await result.current.leave();
    });
    expect(result.current.transcriptFinals).toEqual([]);
    expect(result.current.transcriptPartials).toEqual([]);
  });

  it("disables the microphone but keeps the socket alive while close drains its final transcript", async () => {
    let resolveDrain!: () => void;
    vi.mocked(createRealtimeTranscription).mockImplementationOnce((input) => {
      const session = {
        start: vi.fn(async () => undefined),
        commit: vi.fn(),
        setMuted: vi.fn(),
        close: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              resolveDrain = resolve;
            }),
        ),
      };
      transcriptionRecords.push({ input, session });
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
        type: "transcript.partial",
        participantId: SELF_ID,
        itemId: "pending-item",
        text: "아직 전송 중",
      });
    });

    track.setEnabled.mockClear();
    const leaving = result.current.leave();
    expect(leaving).toBeInstanceOf(Promise);
    expect(transcriptionRecords[0].session.close).toHaveBeenCalledTimes(1);
    expect(track.enabled).toBe(false);
    expect(
      transcriptionRecords[0].session.close.mock.invocationCallOrder[0],
    ).toBeLessThan(track.setEnabled.mock.invocationCallOrder[0]);
    expect(peerRecords[0].session.close).toHaveBeenCalledTimes(1);
    expect(result.current.transcriptPartials).toHaveLength(1);
    expect(socketDouble.socket.close).not.toHaveBeenCalled();
    expect(track.stop).not.toHaveBeenCalled();

    act(() => {
      transcriptionRecords[0].input.onFinal(
        "drained-final",
        "종료 직전 발화",
        900,
        1_000,
      );
    });
    expect(socketDouble.socket.send).toHaveBeenCalledWith({
      type: "transcript.final",
      itemId: "drained-final",
      text: "종료 직전 발화",
      startMs: 900,
      endMs: 1_000,
    });

    await act(async () => {
      resolveDrain();
      await leaving;
    });

    expect(socketDouble.socket.close).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(result.current.transcriptFinals).toEqual([]);
    expect(result.current.transcriptPartials).toEqual([]);
  });

  it("waits for the previous transcription drain before acquiring media for a new join", async () => {
    let resolveDrain!: () => void;
    vi.mocked(createRealtimeTranscription).mockImplementationOnce((input) => {
      const session = {
        start: vi.fn(async () => undefined),
        commit: vi.fn(),
        setMuted: vi.fn(),
        close: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              resolveDrain = resolve;
            }),
        ),
      };
      transcriptionRecords.push({ input, session });
      return session;
    });
    const { result } = renderHook(() => useRoom());
    await join(result);
    act(() => {
      socketDouble.dispatch({
        type: "room.snapshot",
        selfParticipantId: SELF_ID,
        participants: [participant(SELF_ID, "민지")],
      });
    });

    let rejoining!: Promise<void>;
    act(() => {
      rejoining = result.current.join({ ...joinInput, displayName: "재입장" });
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(socketDouble.socket.close).not.toHaveBeenCalled();

    await act(async () => {
      resolveDrain();
      await rejoining;
    });

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(socketDouble.socket.close).toHaveBeenCalledTimes(1);
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

    track.setEnabled.mockClear();
    act(() => result.current.toggleMute());

    expect(track.enabled).toBe(false);
    expect(transcriptionRecords[0].session.setMuted).toHaveBeenCalledWith(true);
    expect(
      transcriptionRecords[0].session.setMuted.mock.invocationCallOrder[0],
    ).toBeLessThan(track.setEnabled.mock.invocationCallOrder[0]);
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

  it("notifies transcription before muting both the microphone track and peer session", async () => {
    const { result } = renderHook(() => useRoom());
    await join(result);
    act(() => {
      socketDouble.dispatch({
        type: "room.snapshot",
        selfParticipantId: SELF_ID,
        participants: [participant(SELF_ID, "민지"), participant(REMOTE_ID, "준호")],
      });
    });
    track.setEnabled.mockClear();
    transcriptionRecords[0].session.setMuted.mockClear();
    peerRecords[0].session.setMuted.mockClear();

    act(() => result.current.toggleMute());

    const transcriptionMuteOrder =
      transcriptionRecords[0].session.setMuted.mock.invocationCallOrder[0];
    expect(transcriptionMuteOrder).toBeLessThan(
      track.setEnabled.mock.invocationCallOrder[0],
    );
    expect(transcriptionMuteOrder).toBeLessThan(
      peerRecords[0].session.setMuted.mock.invocationCallOrder[0],
    );
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

    await act(async () => {
      unmount();
      await Promise.resolve();
    });
    expect(transcriptionRecords[0].session.close).toHaveBeenCalledTimes(1);
    expect(
      transcriptionRecords[0].session.close.mock.invocationCallOrder[0],
    ).toBeLessThan(track.stop.mock.invocationCallOrder[0]);
    expect(
      transcriptionRecords[0].session.close.mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(socketDouble.socket.close).mock.invocationCallOrder[0],
    );
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
