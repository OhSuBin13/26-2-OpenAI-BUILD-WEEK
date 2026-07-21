import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createPeerAudioSession } from "./peer-audio";

type PeerAudioInput = Parameters<typeof createPeerAudioSession>[0];

const LOCAL_ID = "00000000-0000-4000-8000-000000000001";
const REMOTE_ID = "00000000-0000-4000-8000-000000000002";

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

class FakeAnalyser {
  fftSize = 0;
  level = 128;

  getByteTimeDomainData(values: Uint8Array) {
    values.fill(this.level);
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  readonly analyser = new FakeAnalyser();
  readonly connect = vi.fn();
  readonly createAnalyser = vi.fn(() => this.analyser);
  readonly createMediaStreamSource = vi.fn(() => ({ connect: this.connect }));
  readonly close = vi.fn(async () => undefined);

  constructor() {
    FakeAudioContext.instances.push(this);
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];

  readonly configuration: RTCConfiguration;
  readonly addTrack = vi.fn();
  readonly createOffer = vi.fn(async () => ({ type: "offer", sdp: "offer-sdp" }));
  readonly createAnswer = vi.fn(async () => ({ type: "answer", sdp: "answer-sdp" }));
  readonly setLocalDescription = vi.fn(async () => undefined);
  readonly setRemoteDescription = vi.fn(async () => undefined);
  readonly addIceCandidate = vi.fn(async () => undefined);
  readonly close = vi.fn();
  remoteDescription: RTCSessionDescription | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;

  constructor(configuration: RTCConfiguration) {
    this.configuration = configuration;
    FakePeerConnection.instances.push(this);
  }
}

describe("createPeerAudioSession", () => {
  let animationFrames: Map<number, FrameRequestCallback>;
  let nextAnimationFrame: number;
  let track: FakeAudioTrack;
  let localStream: FakeMediaStream;
  let onSignal: Mock<PeerAudioInput["onSignal"]>;
  let onRemoteStream: Mock<PeerAudioInput["onRemoteStream"]>;
  let onLocalSpeaking: Mock<PeerAudioInput["onLocalSpeaking"]>;

  beforeEach(() => {
    FakeAudioContext.instances = [];
    FakePeerConnection.instances = [];
    animationFrames = new Map();
    nextAnimationFrame = 1;
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("MediaStream", FakeMediaStream);
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        const id = nextAnimationFrame++;
        animationFrames.set(id, callback);
        return id;
      }),
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((id: number) => animationFrames.delete(id)),
    );
    track = new FakeAudioTrack();
    localStream = new FakeMediaStream([track]);
    onSignal = vi.fn();
    onRemoteStream = vi.fn();
    onLocalSpeaking = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function createSession(localParticipantId = LOCAL_ID, remoteParticipantId = REMOTE_ID) {
    return createPeerAudioSession({
      localParticipantId,
      remoteParticipantId,
      localStream: localStream as unknown as MediaStream,
      onSignal,
      onRemoteStream,
      onLocalSpeaking,
    });
  }

  it("adds local tracks and creates one initiator offer only when start runs", async () => {
    const session = createSession();
    const connection = FakePeerConnection.instances[0];

    expect(connection.configuration).toEqual({ iceServers: [] });
    expect(connection.addTrack).not.toHaveBeenCalled();
    expect(FakeAudioContext.instances).toHaveLength(0);

    await Promise.all([session.start(), session.start()]);

    expect(connection.addTrack).toHaveBeenCalledTimes(1);
    expect(connection.addTrack).toHaveBeenCalledWith(track, localStream);
    expect(connection.createOffer).toHaveBeenCalledTimes(1);
    expect(connection.setLocalDescription).toHaveBeenCalledWith({
      type: "offer",
      sdp: "offer-sdp",
    });
    expect(onSignal).toHaveBeenCalledWith({ kind: "offer", sdp: "offer-sdp" });
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it("does not create an offer when the remote UUID is smaller", async () => {
    const session = createSession(REMOTE_ID, LOCAL_ID);

    await session.start();

    expect(FakePeerConnection.instances[0].createOffer).not.toHaveBeenCalled();
    expect(onSignal).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "offer" }));
  });

  it("answers an offer and reports a received remote stream", async () => {
    const session = createSession(REMOTE_ID, LOCAL_ID);
    const connection = FakePeerConnection.instances[0];
    const remoteStream = new FakeMediaStream([new FakeAudioTrack()]);

    await session.start();
    await session.handleSignal({ kind: "offer", sdp: "remote-offer" });
    connection.ontrack?.({ streams: [remoteStream] } as unknown as RTCTrackEvent);

    expect(connection.setRemoteDescription).toHaveBeenCalledWith({
      type: "offer",
      sdp: "remote-offer",
    });
    expect(connection.createAnswer).toHaveBeenCalledTimes(1);
    expect(connection.setLocalDescription).toHaveBeenCalledWith({
      type: "answer",
      sdp: "answer-sdp",
    });
    expect(onSignal).toHaveBeenCalledWith({ kind: "answer", sdp: "answer-sdp" });
    expect(onRemoteStream).toHaveBeenCalledWith(remoteStream);
  });

  it("forwards local ICE and queues remote ICE until a remote description exists", async () => {
    const session = createSession(REMOTE_ID, LOCAL_ID);
    const connection = FakePeerConnection.instances[0];

    connection.onicecandidate?.({
      candidate: {
        candidate: "local-candidate",
        sdpMid: "audio",
        sdpMLineIndex: 0,
      },
    } as RTCPeerConnectionIceEvent);
    expect(onSignal).toHaveBeenCalledWith({
      kind: "ice",
      candidate: "local-candidate",
      sdpMid: "audio",
      sdpMLineIndex: 0,
    });

    const earlyIce = session.handleSignal({
      kind: "ice",
      candidate: "remote-candidate",
      sdpMid: "audio",
      sdpMLineIndex: 0,
    });
    await earlyIce;
    expect(connection.addIceCandidate).not.toHaveBeenCalled();

    await session.handleSignal({ kind: "offer", sdp: "remote-offer" });
    expect(connection.addIceCandidate).toHaveBeenCalledWith({
      candidate: "remote-candidate",
      sdpMid: "audio",
      sdpMLineIndex: 0,
    });
    expect(connection.setRemoteDescription.mock.invocationCallOrder[0]).toBeLessThan(
      connection.addIceCandidate.mock.invocationCallOrder[0],
    );
  });

  it("emits speaking changes only when the threshold state changes", async () => {
    const session = createSession(REMOTE_ID, LOCAL_ID);
    await session.start();
    const analyser = FakeAudioContext.instances[0].analyser;

    const runNextFrame = () => {
      const [id, callback] = [...animationFrames.entries()][0];
      animationFrames.delete(id);
      callback(0);
    };

    runNextFrame();
    expect(onLocalSpeaking).not.toHaveBeenCalled();

    analyser.level = 160;
    runNextFrame();
    runNextFrame();
    expect(onLocalSpeaking).toHaveBeenCalledTimes(1);
    expect(onLocalSpeaking).toHaveBeenLastCalledWith(true);

    analyser.level = 128;
    runNextFrame();
    runNextFrame();
    expect(onLocalSpeaking).toHaveBeenCalledTimes(2);
    expect(onLocalSpeaking).toHaveBeenLastCalledWith(false);
  });

  it("toggles every local audio track and clears an active speaking state on mute", async () => {
    const secondTrack = new FakeAudioTrack();
    localStream = new FakeMediaStream([track, secondTrack]);
    const session = createSession(REMOTE_ID, LOCAL_ID);
    await session.start();
    FakeAudioContext.instances[0].analyser.level = 160;
    const [id, callback] = [...animationFrames.entries()][0];
    animationFrames.delete(id);
    callback(0);

    session.setMuted(true);

    expect(track.enabled).toBe(false);
    expect(secondTrack.enabled).toBe(false);
    expect(onLocalSpeaking).toHaveBeenLastCalledWith(false);

    session.setMuted(false);
    expect(track.enabled).toBe(true);
    expect(secondTrack.enabled).toBe(true);
  });

  it("closes adapter-owned resources without stopping caller-owned local tracks", async () => {
    const session = createSession();
    await session.start();
    const connection = FakePeerConnection.instances[0];
    const audioContext = FakeAudioContext.instances[0];

    session.close();
    session.close();

    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(audioContext.close).toHaveBeenCalledTimes(1);
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    expect(track.stop).not.toHaveBeenCalled();
  });

  it("clears an active speaking state when the peer session closes", async () => {
    const session = createSession(REMOTE_ID, LOCAL_ID);
    await session.start();
    FakeAudioContext.instances[0].analyser.level = 160;
    const [id, callback] = [...animationFrames.entries()][0];
    animationFrames.delete(id);
    callback(0);
    expect(onLocalSpeaking).toHaveBeenLastCalledWith(true);

    session.close();

    expect(onLocalSpeaking).toHaveBeenLastCalledWith(false);
    expect(onLocalSpeaking).toHaveBeenCalledTimes(2);
  });

  it("does not publish a description that finishes after the session closes", async () => {
    const session = createSession();
    const connection = FakePeerConnection.instances[0];
    let resolveOffer!: (description: { type: string; sdp: string }) => void;
    connection.createOffer.mockImplementationOnce(
      () =>
        new Promise<{ type: string; sdp: string }>((resolve) => {
          resolveOffer = resolve;
        }),
    );

    const starting = session.start();
    session.close();
    resolveOffer({ type: "offer", sdp: "late-offer" });
    await starting;

    expect(connection.setLocalDescription).not.toHaveBeenCalled();
    expect(onSignal).not.toHaveBeenCalled();
  });
});
