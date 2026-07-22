import { useCallback, useEffect, useRef, useState } from "react";
import type { Participant, TranscriptSegment } from "../../shared/domain";
import type { ServerRoomEvent } from "../../shared/events";
import {
  createPeerAudioSession,
  type InboundRtcSignal,
  type PeerAudioSession,
} from "../audio/peer-audio";
import { createRealtimeTranscription } from "../transcript/realtime-transcription";
import type { TranscriptPartial } from "../transcript/TranscriptPanel";
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

interface ActiveTranscription {
  generation: number;
  participantId: string;
  session: ReturnType<typeof createRealtimeTranscription>;
}

const RECAP_INVOCATION = /(?:^|\s)(?:리캡아|recap)[,\s]+(.+)/i;
const TRANSCRIPTION_START_ERROR = "실시간 회의록을 시작하지 못했습니다.";

const transcriptKey = (participantId: string, itemId: string): string =>
  `${participantId}\u0000${itemId}`;

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
  const [transcriptFinals, setTranscriptFinals] = useState<
    TranscriptSegment[]
  >([]);
  const [transcriptPartials, setTranscriptPartials] = useState<
    TranscriptPartial[]
  >([]);
  const mountedRef = useRef(true);
  const participantsRef = useRef<Participant[]>([]);
  const selfParticipantIdRef = useRef<string | null>(null);
  const mutedRef = useRef(false);
  const socketRef = useRef<RoomSocket | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<ActivePeer | null>(null);
  const transcriptionRef = useRef<ActiveTranscription | null>(null);
  const pendingSignalsRef = useRef(new Map<string, InboundRtcSignal[]>());
  const transcriptPartialsRef = useRef(new Map<string, TranscriptPartial>());
  const transcriptFinalKeysRef = useRef(new Set<string>());
  const localCompletedItemsRef = useRef(new Set<string>());
  const recapInvokedItemsRef = useRef(new Set<string>());
  const localFinalBufferRef = useRef<
    Array<{
      itemId: string;
      text: string;
      startMs: number;
      endMs: number;
    }>
  >([]);
  const joinGenerationRef = useRef(0);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  const replaceParticipants = useCallback((next: Participant[]) => {
    participantsRef.current = next;
    if (mountedRef.current) setParticipants(next);
  }, []);

  const updateParticipants = useCallback(
    (update: (current: Participant[]) => Participant[]) => {
      replaceParticipants(update(participantsRef.current));
    },
    [replaceParticipants],
  );

  const resetTranscriptState = useCallback(() => {
    transcriptPartialsRef.current.clear();
    transcriptFinalKeysRef.current.clear();
    localCompletedItemsRef.current.clear();
    recapInvokedItemsRef.current.clear();
    localFinalBufferRef.current = [];
    if (mountedRef.current) {
      setTranscriptFinals([]);
      setTranscriptPartials([]);
    }
  }, []);

  const receiveTranscriptPartial = useCallback(
    (participantId: string, itemId: string, delta: string) => {
      if (!mountedRef.current) return;
      const key = transcriptKey(participantId, itemId);
      if (transcriptFinalKeysRef.current.has(key)) return;
      if (delta.length === 0) {
        transcriptPartialsRef.current.delete(key);
        setTranscriptPartials([...transcriptPartialsRef.current.values()]);
        return;
      }
      const current = transcriptPartialsRef.current.get(key);
      transcriptPartialsRef.current.set(key, {
        participantId,
        itemId,
        text: `${current?.text ?? ""}${delta}`,
      });
      setTranscriptPartials([...transcriptPartialsRef.current.values()]);
    },
    [],
  );

  const receiveTranscriptFinal = useCallback((segment: TranscriptSegment) => {
    if (!mountedRef.current) return;
    const key = transcriptKey(segment.participantId, segment.itemId);
    if (transcriptFinalKeysRef.current.has(key)) return;
    transcriptFinalKeysRef.current.add(key);
    transcriptPartialsRef.current.delete(key);
    setTranscriptPartials([...transcriptPartialsRef.current.values()]);
    setTranscriptFinals((current) => [...current, segment]);
  }, []);

  const detachRemoteAudio = useCallback(() => {
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
  }, []);

  const closePeer = useCallback(() => {
    peerRef.current?.session.close();
    peerRef.current = null;
    detachRemoteAudio();
  }, [detachRemoteAudio]);

  const retireTranscription = useCallback(() => {
    const active = transcriptionRef.current;
    transcriptionRef.current = null;
    if (active) void active.session.close();
  }, []);

  const teardown = useCallback(
    async (stopLocalStream: boolean): Promise<void> => {
      const activeTranscription = transcriptionRef.current;
      if (activeTranscription) {
        try {
          const closing = activeTranscription.session.close();
          localStreamRef.current?.getAudioTracks().forEach((track) => {
            track.enabled = false;
          });
          closePeer();
          pendingSignalsRef.current.clear();
          await closing;
        } catch {
          localStreamRef.current?.getAudioTracks().forEach((track) => {
            track.enabled = false;
          });
          // Resource cleanup below must still run if an adapter implementation rejects.
        }
        if (transcriptionRef.current === activeTranscription) {
          transcriptionRef.current = null;
        }
      }
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

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      joinGenerationRef.current += 1;
      void teardown(true);
    };
  }, [teardown]);

  const join = useCallback(
    async (input: RoomSocketAuth): Promise<void> => {
      const generation = joinGenerationRef.current + 1;
      joinGenerationRef.current = generation;
      if (mountedRef.current) {
        setError(null);
        setStatus("joining");
      }
      const audioAtJoin = remoteAudioRef.current;
      playBestEffort(audioAtJoin);
      await teardown(true);
      if (
        !mountedRef.current ||
        joinGenerationRef.current !== generation
      ) {
        return;
      }
      replaceParticipants([]);
      resetTranscriptState();
      selfParticipantIdRef.current = null;
      setSelfParticipantId(null);
      mutedRef.current = false;
      setMuted(false);

      try {
        const localStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
          video: false,
        });
        if (
          !mountedRef.current ||
          joinGenerationRef.current !== generation
        ) {
          localStream.getTracks().forEach((track) => track.stop());
          return;
        }
        localStreamRef.current = localStream;
        if (!audioAtJoin) playBestEffort(remoteAudioRef.current);

        const socket = createRoomSocket(input);
        socketRef.current = socket;

        const ensureTranscription = (
          participantId: string,
          meetingOffsetMs: number,
        ): ReturnType<typeof createRealtimeTranscription> | null => {
          const current = transcriptionRef.current;
          if (
            current?.generation === generation &&
            current.participantId === participantId
          ) {
            return current.session;
          }

          retireTranscription();
          localCompletedItemsRef.current.clear();
          recapInvokedItemsRef.current.clear();
          localFinalBufferRef.current = [];
          let active: ActiveTranscription | null = null;
          const isCurrent = () =>
            active !== null &&
            transcriptionRef.current === active;
          let session: ReturnType<typeof createRealtimeTranscription>;
          let reportSessionFailure = (): void => {};
          try {
            session = createRealtimeTranscription({
              stream: localStream,
              roomId: input.roomId,
              participantId,
              secret: input.secret,
              meetingOffsetMs,
              onPartial(itemId, text) {
                if (!isCurrent()) return;
                socket.send({ type: "transcript.partial", itemId, text });
              },
              onFinal(itemId, text, startMs, endMs) {
                if (!isCurrent() || localCompletedItemsRef.current.has(itemId)) {
                  return;
                }
                localCompletedItemsRef.current.add(itemId);
                socket.send({
                  type: "transcript.final",
                  itemId,
                  text,
                  startMs,
                  endMs,
                });

                localFinalBufferRef.current = [
                  ...localFinalBufferRef.current,
                  { itemId, text, startMs, endMs },
                ]
                  .sort(
                    (left, right) =>
                      left.startMs - right.startMs ||
                      left.endMs - right.endMs ||
                      left.itemId.localeCompare(right.itemId),
                  )
                  .slice(-2);
                const combinedText = localFinalBufferRef.current
                  .map((segment) => segment.text)
                  .join(" ");
                const question = combinedText.match(RECAP_INVOCATION)?.[1]?.trim();
                const triggeringItemId = localFinalBufferRef.current.at(-1)?.itemId;
                if (
                  question &&
                  triggeringItemId &&
                  !recapInvokedItemsRef.current.has(triggeringItemId)
                ) {
                  recapInvokedItemsRef.current.add(triggeringItemId);
                  socket.send({ type: "ai.ask", question });
                  localFinalBufferRef.current = [];
                }
              },
              onError() {
                reportSessionFailure();
              },
            });
          } catch {
            if (
              mountedRef.current &&
              joinGenerationRef.current === generation
            ) {
              setError(TRANSCRIPTION_START_ERROR);
            }
            return null;
          }
          active = { generation, participantId, session };
          transcriptionRef.current = active;
          reportSessionFailure = () => {
            if (!isCurrent()) return;
            transcriptionRef.current = null;
            try {
              void session.close();
            } catch {
              // The room remains usable even if failed-session cleanup also fails.
            }
            if (
              mountedRef.current &&
              joinGenerationRef.current === generation
            ) {
              setError(TRANSCRIPTION_START_ERROR);
            }
          };
          try {
            void session.start().then(() => {
              if (
                isCurrent() &&
                mountedRef.current &&
                joinGenerationRef.current === generation
              ) {
                setError((current) =>
                  current === TRANSCRIPTION_START_ERROR ? null : current,
                );
              }
            }, reportSessionFailure);
          } catch {
            reportSessionFailure();
            return null;
          }
          return session;
        };

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
            !mountedRef.current ||
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
          if (
            !mountedRef.current ||
            joinGenerationRef.current !== generation
          ) {
            return;
          }
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
            const transcription = ensureTranscription(
              event.selfParticipantId,
              event.meetingElapsedMs ?? 0,
            );
            transcription?.setMuted(snapshotMuted);
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

          if (event.type === "transcript.partial") {
            receiveTranscriptPartial(
              event.participantId,
              event.itemId,
              event.text,
            );
            return;
          }

          if (event.type === "transcript.final") {
            receiveTranscriptFinal(event.segment);
            return;
          }

          if (event.type === "room.error") {
            setError(event.message);
            if (!selfParticipantIdRef.current) setStatus("error");
          }
        };

        unsubscribeRef.current = socket.subscribe(handleRoomEvent);
        if (mountedRef.current) setStatus("connecting");
        await socket.connect();
      } catch (joinError) {
        if (
          !mountedRef.current ||
          joinGenerationRef.current !== generation
        ) {
          return;
        }
        await teardown(true);
        if (
          !mountedRef.current ||
          joinGenerationRef.current !== generation
        ) {
          return;
        }
        replaceParticipants([]);
        resetTranscriptState();
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
    [
      closePeer,
      receiveTranscriptFinal,
      receiveTranscriptPartial,
      replaceParticipants,
      resetTranscriptState,
      retireTranscription,
      teardown,
      updateParticipants,
    ],
  );

  const toggleMute = useCallback(() => {
    const nextMuted = !mutedRef.current;
    transcriptionRef.current?.session.setMuted(nextMuted);
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

  const leave = useCallback(async (): Promise<void> => {
    const generation = joinGenerationRef.current + 1;
    joinGenerationRef.current = generation;
    if (mountedRef.current) {
      setError(null);
      setStatus("idle");
    }
    await teardown(true);
    if (
      !mountedRef.current ||
      joinGenerationRef.current !== generation
    ) {
      return;
    }
    replaceParticipants([]);
    resetTranscriptState();
    selfParticipantIdRef.current = null;
    setSelfParticipantId(null);
    mutedRef.current = false;
    setMuted(false);
  }, [replaceParticipants, resetTranscriptState, teardown]);

  return {
    participants,
    selfParticipantId,
    status,
    error,
    muted,
    transcriptFinals,
    transcriptPartials,
    remoteAudioRef,
    join,
    toggleMute,
    leave,
  };
}
