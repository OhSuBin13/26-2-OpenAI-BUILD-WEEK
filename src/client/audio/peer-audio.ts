import type { ClientRoomEvent, ServerRoomEvent } from "../../shared/events";

export type OutboundRtcSignal = Extract<
  ClientRoomEvent,
  { type: "webrtc.signal" }
>["signal"];
export type InboundRtcSignal = Extract<
  ServerRoomEvent,
  { type: "webrtc.signal" }
>["signal"];

export interface PeerAudioSession {
  start(): Promise<void>;
  handleSignal(signal: InboundRtcSignal): Promise<void>;
  setMuted(muted: boolean): void;
  close(): void;
}

export function createPeerAudioSession(input: {
  localParticipantId: string;
  remoteParticipantId: string;
  localStream: MediaStream;
  onSignal(signal: OutboundRtcSignal): void;
  onRemoteStream(stream: MediaStream): void;
  onLocalSpeaking(speaking: boolean): void;
}): PeerAudioSession {
  const peerConnection = new RTCPeerConnection({ iceServers: [] });
  const queuedIce: Extract<InboundRtcSignal, { kind: "ice" }>[] = [];
  let audioContext: AudioContext | null = null;
  let animationFrame: number | null = null;
  let closed = false;
  let hasRemoteDescription = false;
  let lastSpeaking = false;
  let startPromise: Promise<void> | null = null;
  let signalQueue = Promise.resolve();

  peerConnection.ontrack = (event) => {
    if (closed) return;
    const [stream] = event.streams;
    if (stream) input.onRemoteStream(stream);
  };

  peerConnection.onicecandidate = (event) => {
    if (closed || !event.candidate) return;
    input.onSignal({
      kind: "ice",
      candidate: event.candidate.candidate,
      sdpMid: event.candidate.sdpMid,
      sdpMLineIndex: event.candidate.sdpMLineIndex,
    });
  };

  const emitDescription = async (kind: "offer" | "answer"): Promise<void> => {
    const description =
      kind === "offer"
        ? await peerConnection.createOffer()
        : await peerConnection.createAnswer();
    if (closed) return;
    if (!description.sdp) throw new Error(`WebRTC ${kind} did not include SDP`);
    await peerConnection.setLocalDescription(description);
    if (closed) return;
    input.onSignal({ kind, sdp: description.sdp });
  };

  const flushQueuedIce = async (): Promise<void> => {
    while (queuedIce.length > 0) {
      if (closed) {
        queuedIce.length = 0;
        return;
      }
      const signal = queuedIce.shift();
      if (!signal) continue;
      await peerConnection.addIceCandidate({
        candidate: signal.candidate,
        sdpMid: signal.sdpMid,
        sdpMLineIndex: signal.sdpMLineIndex,
      });
    }
  };

  const applySignal = async (signal: InboundRtcSignal): Promise<void> => {
    if (closed) return;
    if (signal.kind === "ice") {
      if (!hasRemoteDescription) {
        queuedIce.push(signal);
        return;
      }
      await peerConnection.addIceCandidate({
        candidate: signal.candidate,
        sdpMid: signal.sdpMid,
        sdpMLineIndex: signal.sdpMLineIndex,
      });
      return;
    }

    await peerConnection.setRemoteDescription({
      type: signal.kind,
      sdp: signal.sdp,
    });
    if (closed) return;
    hasRemoteDescription = true;
    await flushQueuedIce();
    if (!closed && signal.kind === "offer") await emitDescription("answer");
  };

  const startAnalyser = (): void => {
    audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    audioContext.createMediaStreamSource(input.localStream).connect(analyser);
    const levels = new Uint8Array(analyser.fftSize);

    const detectSpeaking = () => {
      if (closed) return;
      analyser.getByteTimeDomainData(levels);
      const rms = Math.sqrt(
        levels.reduce(
          (sum, level) => sum + ((level - 128) / 128) ** 2,
          0,
        ) / levels.length,
      );
      const speaking =
        input.localStream.getAudioTracks().some((track) => track.enabled) &&
        rms > 0.04;
      if (speaking !== lastSpeaking) {
        lastSpeaking = speaking;
        input.onLocalSpeaking(speaking);
      }
      animationFrame = requestAnimationFrame(detectSpeaking);
    };

    animationFrame = requestAnimationFrame(detectSpeaking);
  };

  return {
    start() {
      if (startPromise) return startPromise;
      startPromise = (async () => {
        if (closed) return;
        input.localStream
          .getTracks()
          .forEach((track) => peerConnection.addTrack(track, input.localStream));
        startAnalyser();
        if (input.localParticipantId < input.remoteParticipantId) {
          await emitDescription("offer");
        }
      })();
      return startPromise;
    },

    handleSignal(signal) {
      const pending = signalQueue.then(() => applySignal(signal));
      signalQueue = pending.catch(() => undefined);
      return pending;
    },

    setMuted(muted) {
      input.localStream.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
      if (muted && lastSpeaking) {
        lastSpeaking = false;
        input.onLocalSpeaking(false);
      }
    },

    close() {
      if (closed) return;
      closed = true;
      if (lastSpeaking) {
        lastSpeaking = false;
        input.onLocalSpeaking(false);
      }
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      if (audioContext) void audioContext.close().catch(() => undefined);
      peerConnection.close();
    },
  };
}
