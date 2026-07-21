import { useCallback, useEffect, useRef, useState } from "react";
import type { Participant } from "../../shared/domain";
import type { ServerRoomEvent } from "../../shared/events";
import {
  createPeerAudioSession,
  type InboundRtcSignal,
  type PeerAudioSession,
} from "../audio/peer-audio";
import {
  createRoomSocket,
  type RoomSocket,
  type RoomSocketAuth,
} from "./room-socket";

export type RoomConnectionStatus =
  | "idle"
  | "joining"
  | "connecting"
  | "connected"
  | "error";

interface ActivePeer {
  localParticipantId: string;
  remoteParticipantId: string;
  session: PeerAudioSession;
  ready: Promise<void>;
}

const playBestEffort = (audio: HTMLAudioElement | null): void => {
  if (!audio) return;
  try {
    void audio.play().catch(() => undefined);
  } catch {
    // Browsers may reject play before media is attached or user activation is available.
  }
};

export function useRoom() {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [selfParticipantId, setSelfParticipantId] = useState<string | null>(null);
  const [status, setStatus] = useState<RoomConnectionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const participantsRef = useRef<Participant[]>([]);
  const selfParticipantIdRef = useRef<string | null>(null);
  const mutedRef = useRef(false);
  const socketRef = useRef<RoomSocket | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<ActivePeer | null>(null);
  const pendingSignalsRef = useRef(new Map<string, InboundRtcSignal[]>());
  const joinGenerationRef = useRef(0);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  const replaceParticipants = useCallback((next: Participant[]) => {
    participantsRef.current = next;
    setParticipants(next);
  }, []);

  const updateParticipants = useCallback(
    (update: (current: Participant[]) => Participant[]) => {
      replaceParticipants(update(participantsRef.current));
    },
    [replaceParticipants],
  );

  const detachRemoteAudio = useCallback(() => {
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
  }, []);

  const closePeer = useCallback(() => {
    peerRef.current?.session.close();
    peerRef.current = null;
    detachRemoteAudio();
  }, [detachRemoteAudio]);

  const teardown = useCallback(
    (stopLocalStream: boolean) => {
      closePeer();
      pendingSignalsRef.current.clear();
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      socketRef.current?.close();
      socketRef.current = null;
      if (stopLocalStream) {
        localStreamRef.current
          ?.getTracks()
          .forEach((track) => track.stop());
        localStreamRef.current = null;
      }
      detachRemoteAudio();
    },
    [closePeer, detachRemoteAudio],
  );

  useEffect(
    () => () => {
      joinGenerationRef.current += 1;
      teardown(true);
    },
    [teardown],
  );

  const join = useCallback(
    async (input: RoomSocketAuth): Promise<void> => {
      const generation = joinGenerationRef.current + 1;
      joinGenerationRef.current = generation;
      teardown(true);
      replaceParticipants([]);
      selfParticipantIdRef.current = null;
      setSelfParticipantId(null);
      mutedRef.current = false;
      setMuted(false);
      setError(null);
      setStatus("joining");
      const audioAtJoin = remoteAudioRef.current;
      playBestEffort(audioAtJoin);

      try {
        const localStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
          video: false,
        });
        if (joinGenerationRef.current !== generation) {
          localStream.getTracks().forEach((track) => track.stop());
          return;
        }
        localStreamRef.current = localStream;
        if (!audioAtJoin) playBestEffort(remoteAudioRef.current);

        const socket = createRoomSocket(input);
        socketRef.current = socket;

        const setParticipantState = (
          participantId: string,
          state: Partial<Pick<Participant, "muted" | "speaking">>,
        ) => {
          updateParticipants((current) =>
            current.map((participant) =>
              participant.id === participantId
                ? { ...participant, ...state }
                : participant,
            ),
          );
        };

        const reportPeerFailure = (peer: ActivePeer) => {
          if (
            joinGenerationRef.current !== generation ||
            peerRef.current !== peer
          ) {
            return;
          }
          setError("상대방 오디오 연결에 실패했습니다.");
        };

        const runSignalAfterStart = (
          peer: ActivePeer,
          signal: InboundRtcSignal,
        ): void => {
          void peer.ready
            .then(() => peer.session.handleSignal(signal))
            .catch(() => reportPeerFailure(peer));
        };

        const ensurePeer = (
          remoteParticipantId: string,
          localParticipantId: string,
        ): void => {
          const currentPeer = peerRef.current;
          if (
            currentPeer?.remoteParticipantId === remoteParticipantId &&
            currentPeer.localParticipantId === localParticipantId
          ) {
            return;
          }
          closePeer();
          let activePeer: ActivePeer | null = null;
          const isCurrentPeer = () =>
            joinGenerationRef.current === generation &&
            peerRef.current === activePeer;
          const session = createPeerAudioSession({
            localParticipantId,
            remoteParticipantId,
            localStream,
            onSignal(signal) {
              if (!isCurrentPeer()) return;
              socket.send({
                type: "webrtc.signal",
                targetId: remoteParticipantId,
                signal,
              });
            },
            onRemoteStream(stream) {
              if (!isCurrentPeer()) return;
              const audio = remoteAudioRef.current;
              if (!audio) return;
              audio.srcObject = stream;
              playBestEffort(audio);
            },
            onLocalSpeaking(speaking) {
              if (!isCurrentPeer()) return;
              setParticipantState(localParticipantId, { speaking });
              socket.send({ type: "participant.speaking_changed", speaking });
            },
          });
          if (mutedRef.current) session.setMuted(true);
          const ready = session.start();
          activePeer = {
            localParticipantId,
            remoteParticipantId,
            session,
            ready,
          };
          peerRef.current = activePeer;
          void ready.catch(() => {
            if (activePeer) reportPeerFailure(activePeer);
          });
          const pending = pendingSignalsRef.current.get(remoteParticipantId) ?? [];
          pendingSignalsRef.current.delete(remoteParticipantId);
          pending.forEach((signal) => {
            if (activePeer) runSignalAfterStart(activePeer, signal);
          });
        };

        const closeRemotePeer = (participantId?: string): void => {
          if (
            participantId &&
            peerRef.current?.remoteParticipantId !== participantId
          ) {
            return;
          }
          closePeer();
        };

        const handleRoomEvent = (event: ServerRoomEvent): void => {
          if (joinGenerationRef.current !== generation) return;
          if (event.type === "room.snapshot") {
            const previousSelfId = selfParticipantIdRef.current;
            if (previousSelfId && previousSelfId !== event.selfParticipantId) {
              closePeer();
              pendingSignalsRef.current.clear();
            }
            selfParticipantIdRef.current = event.selfParticipantId;
            setSelfParticipantId(event.selfParticipantId);
            replaceParticipants([...event.participants]);
            const self = event.participants.find(
              ({ id }) => id === event.selfParticipantId,
            );
            const snapshotMuted = self?.muted ?? false;
            mutedRef.current = snapshotMuted;
            setMuted(snapshotMuted);
            localStream.getAudioTracks().forEach((track) => {
              track.enabled = !snapshotMuted;
            });
            const remote = event.participants.find(
              ({ id }) => id !== event.selfParticipantId,
            );
            if (remote) {
              ensurePeer(remote.id, event.selfParticipantId);
            } else {
              closeRemotePeer();
            }
            setStatus("connected");
            return;
          }

          if (event.type === "participant.joined") {
            updateParticipants((current) => {
              const existingIndex = current.findIndex(
                ({ id }) => id === event.participant.id,
              );
              if (existingIndex < 0) return [...current, event.participant];
              const next = [...current];
              next[existingIndex] = event.participant;
              return next;
            });
            const localParticipantId = selfParticipantIdRef.current;
            if (
              localParticipantId &&
              event.participant.id !== localParticipantId
            ) {
              ensurePeer(event.participant.id, localParticipantId);
            }
            return;
          }

          if (event.type === "participant.left") {
            updateParticipants((current) =>
              current.filter(({ id }) => id !== event.participantId),
            );
            pendingSignalsRef.current.delete(event.participantId);
            closeRemotePeer(event.participantId);
            return;
          }

          if (event.type === "participant.mic_changed") {
            setParticipantState(event.participantId, { muted: event.muted });
            return;
          }

          if (event.type === "participant.speaking_changed") {
            setParticipantState(event.participantId, {
              speaking: event.speaking,
            });
            return;
          }

          if (event.type === "webrtc.signal") {
            const peer = peerRef.current;
            if (peer?.remoteParticipantId === event.fromId) {
              runSignalAfterStart(peer, event.signal);
            } else {
              const pending =
                pendingSignalsRef.current.get(event.fromId) ?? [];
              pending.push(event.signal);
              pendingSignalsRef.current.set(event.fromId, pending);
            }
            return;
          }

          if (event.type === "room.error") {
            setError(event.message);
            if (!selfParticipantIdRef.current) setStatus("error");
          }
        };

        unsubscribeRef.current = socket.subscribe(handleRoomEvent);
        setStatus("connecting");
        await socket.connect();
      } catch (joinError) {
        if (joinGenerationRef.current !== generation) return;
        teardown(true);
        replaceParticipants([]);
        selfParticipantIdRef.current = null;
        setSelfParticipantId(null);
        setError(
          joinError instanceof Error && joinError.message === "ROOM_FULL"
            ? "This room already has two people."
            : "회의실에 연결하지 못했습니다.",
        );
        setStatus("error");
      }
    },
    [closePeer, replaceParticipants, teardown, updateParticipants],
  );

  const toggleMute = useCallback(() => {
    const nextMuted = !mutedRef.current;
    mutedRef.current = nextMuted;
    setMuted(nextMuted);
    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    peerRef.current?.session.setMuted(nextMuted);
    socketRef.current?.send({
      type: "participant.mic_changed",
      muted: nextMuted,
    });
    const participantId = selfParticipantIdRef.current;
    if (participantId) {
      updateParticipants((current) =>
        current.map((participant) =>
          participant.id === participantId
            ? { ...participant, muted: nextMuted }
            : participant,
        ),
      );
    }
  }, [updateParticipants]);

  const leave = useCallback(() => {
    joinGenerationRef.current += 1;
    teardown(true);
    replaceParticipants([]);
    selfParticipantIdRef.current = null;
    setSelfParticipantId(null);
    mutedRef.current = false;
    setMuted(false);
    setError(null);
    setStatus("idle");
  }, [replaceParticipants, teardown]);

  return {
    participants,
    selfParticipantId,
    status,
    error,
    muted,
    remoteAudioRef,
    join,
    toggleMute,
    leave,
  };
}
