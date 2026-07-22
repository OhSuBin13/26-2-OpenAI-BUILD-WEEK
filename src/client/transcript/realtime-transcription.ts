const MIN_BUFFERED_AUDIO_MS = 100;
const COMMIT_INTERVAL_MS = 3_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 3_000;

type PendingCommit = {
  eventId: string;
  itemId: string | null;
  startMs: number;
  endMs: number;
  terminal: { transcript: string | null } | null;
  done: Promise<void>;
  resolve(): void;
};

export function createRealtimeTranscription(input: {
  stream: MediaStream;
  roomId: string;
  participantId: string;
  secret: string;
  meetingOffsetMs: number;
  onPartial(itemId: string, text: string): void;
  onFinal(
    itemId: string,
    text: string,
    startMs: number,
    endMs: number,
  ): void;
  onError?(): void;
  drainTimeoutMs?: number;
}) {
  const peerConnection = new RTCPeerConnection();
  const channel = peerConnection.createDataChannel("oai-events");
  const audioTracks = input.stream.getAudioTracks();
  const audioSenders = audioTracks.map((track) =>
    peerConnection.addTrack(track, input.stream),
  );
  const completed = new Set<string>();
  const startedAt = performance.now();
  const meetingOffsetMs = Math.max(0, Math.round(input.meetingOffsetMs));
  const drainTimeoutMs = input.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  let finalized = false;
  let closing = false;
  let ready = false;
  let muted = false;
  let unmutedSince: number | null = null;
  let bufferedUnmutedMs = 0;
  let commitSequence = 0;
  let pendingCommits: PendingCommit[] = [];
  let commitTimer: ReturnType<typeof setTimeout> | null = null;
  let abortController: AbortController | null = null;
  let startPromise: Promise<void> | null = null;
  let closePromise: Promise<void> | null = null;
  let senderUpdatePromise = Promise.resolve();

  function accrueUnmutedAudio(): void {
    if (unmutedSince === null) return;
    const now = performance.now();
    bufferedUnmutedMs += Math.max(0, now - unmutedSince);
    unmutedSince = now;
  }

  function clearCommitTimer(): void {
    if (commitTimer === null) return;
    clearTimeout(commitTimer);
    commitTimer = null;
  }

  function scheduleCommit(): void {
    clearCommitTimer();
    if (finalized || closing || !ready || muted) return;
    commitTimer = setTimeout(() => {
      commitTimer = null;
      const sent = sendCommit();
      if (!sent) scheduleCommit();
    }, COMMIT_INTERVAL_MS);
  }

  function sendCommit(): boolean {
    accrueUnmutedAudio();
    if (
      finalized ||
      !ready ||
      channel.readyState !== "open" ||
      bufferedUnmutedMs < MIN_BUFFERED_AUDIO_MS
    ) {
      return false;
    }

    commitSequence += 1;
    const eventId = `transcription-commit-${commitSequence}`;
    let resolve!: () => void;
    const done = new Promise<void>((settle) => {
      resolve = settle;
    });
    const endMs =
      meetingOffsetMs + Math.max(0, Math.round(performance.now() - startedAt));
    const startMs = Math.max(0, endMs - Math.round(bufferedUnmutedMs));
    channel.send(
      JSON.stringify({ type: "input_audio_buffer.commit", event_id: eventId }),
    );
    pendingCommits.push({
      eventId,
      itemId: null,
      startMs,
      endMs,
      terminal: null,
      done,
      resolve,
    });
    bufferedUnmutedMs = 0;
    unmutedSince = !muted && !closing ? performance.now() : null;
    scheduleCommit();
    return true;
  }

  function releaseTerminalCommits(): void {
    while (pendingCommits[0]?.terminal) {
      const commit = pendingCommits.shift();
      if (!commit) break;
      commit.resolve();
      const transcript = commit.terminal?.transcript;
      if (commit.itemId && transcript?.trim()) {
        input.onFinal(
          commit.itemId,
          transcript,
          commit.startMs,
          commit.endMs,
        );
      }
    }
    if (commitTimer === null) scheduleCommit();
  }

  function markCommitTerminal(
    commit: PendingCommit,
    transcript: string | null,
  ): void {
    if (!pendingCommits.includes(commit) || commit.terminal) return;
    commit.terminal = { transcript };
    releaseTerminalCommits();
  }

  channel.onmessage = (message) => {
    if (finalized || typeof message.data !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.data);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const event = parsed as Record<string, unknown>;

    if (
      event.type === "input_audio_buffer.committed" &&
      typeof event.item_id === "string" &&
      event.item_id.length > 0
    ) {
      const unassigned = pendingCommits.find(
        ({ itemId, terminal }) => itemId === null && terminal === null,
      );
      if (unassigned) unassigned.itemId = event.item_id;
      return;
    }

    if (event.type === "error" && event.error && typeof event.error === "object") {
      const eventId = (event.error as Record<string, unknown>).event_id;
      if (typeof eventId === "string") {
        const failedCommit = pendingCommits.find(
          (commit) => commit.eventId === eventId,
        );
        if (failedCommit) markCommitTerminal(failedCommit, null);
      }
      return;
    }

    if (
      event.type === "conversation.item.input_audio_transcription.failed" &&
      typeof event.item_id === "string" &&
      event.item_id.length > 0
    ) {
      completed.add(event.item_id);
      input.onPartial(event.item_id, "");
      const failedCommit = pendingCommits.find(
        (commit) => commit.itemId === event.item_id,
      );
      if (failedCommit) markCommitTerminal(failedCommit, null);
      return;
    }

    if (
      event.type === "conversation.item.input_audio_transcription.delta" &&
      typeof event.item_id === "string" &&
      event.item_id.length > 0 &&
      typeof event.delta === "string"
    ) {
      if (!completed.has(event.item_id)) {
        input.onPartial(event.item_id, event.delta);
      }
      return;
    }

    if (
      event.type !== "conversation.item.input_audio_transcription.completed" ||
      typeof event.item_id !== "string" ||
      event.item_id.length === 0 ||
      typeof event.transcript !== "string"
    ) {
      return;
    }

    const itemId = event.item_id;
    if (completed.has(itemId)) return;
    completed.add(itemId);
    if (event.transcript.trim().length === 0) {
      input.onPartial(itemId, "");
    }
    const completedCommit = pendingCommits.find(
      (commit) => commit.itemId === itemId,
    );
    if (completedCommit) {
      markCommitTerminal(completedCommit, event.transcript);
      return;
    }
    if (event.transcript.trim().length === 0) return;
    const fallbackEndMs = Math.max(
      meetingOffsetMs,
      meetingOffsetMs + Math.round(performance.now() - startedAt),
    );
    input.onFinal(
      itemId,
      event.transcript,
      Math.max(0, fallbackEndMs - COMMIT_INTERVAL_MS),
      fallbackEndMs,
    );
  };

  function finalizeResources(): void {
    if (finalized) return;
    finalized = true;
    ready = false;
    clearCommitTimer();
    abortController?.abort();
    const pending = pendingCommits;
    pendingCommits = [];
    pending.forEach((commit) => commit.resolve());
    if (channel.readyState !== "closed") channel.close();
    peerConnection.close();
    channel.onmessage = null;
  }

  function reportRuntimeFailure(): void {
    if (closing || finalized) return;
    finalizeResources();
    input.onError?.();
  }

  function updateSenderTracks(nextMuted: boolean): void {
    senderUpdatePromise = senderUpdatePromise
      .then(async () => {
        if (closing || finalized || muted !== nextMuted) return;
        await Promise.all(
          audioSenders.map((sender, index) =>
            sender.replaceTrack(nextMuted ? null : audioTracks[index] ?? null),
          ),
        );
        if (
          closing ||
          finalized ||
          muted !== nextMuted ||
          nextMuted ||
          !ready
        ) {
          return;
        }
        unmutedSince = performance.now();
        scheduleCommit();
      })
      .catch(reportRuntimeFailure);
  }

  function waitForChannelOpen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      channel.onopen = () => resolve();
      const reportOpenedChannelFailure = (): boolean => {
        if (!ready || closing || finalized) return false;
        finalizeResources();
        input.onError?.();
        return true;
      };
      channel.onerror = () => {
        if (!reportOpenedChannelFailure()) {
          reject(new Error("TRANSCRIPTION_CHANNEL_FAILED"));
        }
      };
      channel.onclose = () => {
        if (reportOpenedChannelFailure()) return;
        if (closing || finalized) resolve();
        else reject(new Error("TRANSCRIPTION_CHANNEL_FAILED"));
      };
      if (channel.readyState === "open") resolve();
      else if (channel.readyState !== "connecting") {
        reject(new Error("TRANSCRIPTION_CHANNEL_FAILED"));
      }
    });
  }

  async function negotiate(): Promise<void> {
    try {
      if (closing || finalized) return;
      const offer = await peerConnection.createOffer();
      if (closing || finalized) return;
      if (!offer.sdp) throw new Error("TRANSCRIPTION_OFFER_FAILED");
      await peerConnection.setLocalDescription(offer);
      if (closing || finalized) return;

      const controller = new AbortController();
      abortController = controller;
      const response = await fetch("/api/openai/transcription-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/sdp",
          Authorization: `Bearer ${input.secret}`,
          "X-Room-Id": input.roomId,
          "X-Participant-Id": input.participantId,
        },
        body: offer.sdp,
        signal: controller.signal,
      });
      if (closing || finalized || controller.signal.aborted) return;
      if (!response.ok) throw new Error("TRANSCRIPTION_SESSION_FAILED");
      const answerSdp = await response.text();
      if (closing || finalized || controller.signal.aborted) return;
      if (answerSdp.trim().length === 0) {
        throw new Error("TRANSCRIPTION_ANSWER_FAILED");
      }
      await peerConnection.setRemoteDescription({
        type: "answer",
        sdp: answerSdp,
      });
      if (closing || finalized || controller.signal.aborted) return;
      await waitForChannelOpen();
      if (closing || finalized || controller.signal.aborted) return;
      ready = true;
      unmutedSince = muted ? null : performance.now();
      scheduleCommit();
    } catch (error) {
      if (closing || finalized) return;
      finalizeResources();
      throw error;
    } finally {
      abortController = null;
    }
  }

  async function drainAndFinalize(): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, Math.max(0, drainTimeoutMs));
    });
    const drain = async (): Promise<void> => {
      if (bufferedUnmutedMs >= MIN_BUFFERED_AUDIO_MS) sendCommit();
      await Promise.all(pendingCommits.map((commit) => commit.done));
    };

    try {
      await Promise.race([drain(), timedOut]);
    } finally {
      if (timeout !== null) clearTimeout(timeout);
      finalizeResources();
    }
  }

  return {
    start(): Promise<void> {
      if (!startPromise) startPromise = negotiate();
      return startPromise;
    },
    commit(): void {
      if (!closing) sendCommit();
    },
    setMuted(next: boolean): void {
      if (finalized || closing || next === muted) return;
      if (!muted) accrueUnmutedAudio();
      muted = next;
      if (muted) {
        unmutedSince = null;
        clearCommitTimer();
        sendCommit();
      }
      updateSenderTracks(muted);
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      if (finalized) {
        closePromise = Promise.resolve();
        return closePromise;
      }
      closing = true;
      clearCommitTimer();
      accrueUnmutedAudio();
      unmutedSince = null;
      closePromise = drainAndFinalize().catch(() => {
        finalizeResources();
      });
      return closePromise;
    },
  };
}
