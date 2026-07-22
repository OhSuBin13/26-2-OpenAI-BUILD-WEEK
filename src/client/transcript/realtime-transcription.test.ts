import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRealtimeTranscription } from "./realtime-transcription";

type RealtimeTranscriptionInput = Parameters<
  typeof createRealtimeTranscription
>[0];

class FakeMediaStreamTrack {
  readonly stop = vi.fn();

  constructor(readonly kind: "audio" | "video") {}
}

class FakeMediaStream {
  constructor(private readonly tracks: FakeMediaStreamTrack[]) {}

  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio");
  }

  getTracks() {
    return this.tracks;
  }
}

class FakeDataChannel {
  readonly label: string;
  readyState: RTCDataChannelState = "connecting";
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly send = vi.fn((_data: string) => {
    if (this.readyState !== "open") {
      throw new Error("RTCDataChannel is not open");
    }
  });
  readonly close = vi.fn(() => {
    this.readyState = "closed";
    this.onclose?.(new Event("close"));
  });

  constructor(label: string) {
    this.label = label;
  }

  receive(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }

  open() {
    this.readyState = "open";
    this.onopen?.(new Event("open"));
  }

  fail() {
    this.onerror?.(new Event("error"));
  }

  remoteClose() {
    this.readyState = "closed";
    this.onclose?.(new Event("close"));
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];

  readonly channel = new FakeDataChannel("oai-events");
  readonly senders: Array<{
    track: FakeMediaStreamTrack;
    replaceTrack: ReturnType<typeof vi.fn>;
  }> = [];
  readonly addTrack = vi.fn((track: FakeMediaStreamTrack) => {
    const sender = {
      track,
      replaceTrack: vi.fn(async () => undefined),
    };
    this.senders.push(sender);
    return sender;
  });
  readonly createDataChannel = vi.fn(() => this.channel);
  readonly createOffer = vi.fn(async () => ({
    type: "offer" as const,
    sdp: "local-offer-sdp",
  }));
  readonly setLocalDescription = vi.fn(async () => undefined);
  readonly setRemoteDescription = vi.fn(async () => undefined);
  readonly close = vi.fn();

  constructor() {
    FakePeerConnection.instances.push(this);
  }
}

describe("createRealtimeTranscription", () => {
  const roomId = "00000000-0000-4000-8000-000000000001";
  const participantId = "00000000-0000-4000-8000-000000000002";
  const secret = "room-secret";
  let audioTrack: FakeMediaStreamTrack;
  let videoTrack: FakeMediaStreamTrack;
  let stream: FakeMediaStream;

  beforeEach(() => {
    FakePeerConnection.instances = [];
    audioTrack = new FakeMediaStreamTrack("audio");
    videoTrack = new FakeMediaStreamTrack("video");
    stream = new FakeMediaStream([audioTrack, videoTrack]);
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("remote-answer-sdp", {
          status: 200,
          headers: { "Content-Type": "application/sdp" },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function createSession(
    callbacks: Partial<
      Pick<RealtimeTranscriptionInput, "onPartial" | "onFinal" | "onError">
    > = {},
    options: { drainTimeoutMs?: number; meetingOffsetMs?: number } = {},
  ) {
    return createRealtimeTranscription({
      stream: stream as unknown as MediaStream,
      roomId,
      participantId,
      secret,
      meetingOffsetMs: options.meetingOffsetMs ?? 0,
      onPartial: callbacks.onPartial ?? vi.fn(),
      onFinal: callbacks.onFinal ?? vi.fn(),
      onError: callbacks.onError,
      drainTimeoutMs: options.drainTimeoutMs,
    });
  }

  async function startAndOpen(session: ReturnType<typeof createSession>) {
    const connection = FakePeerConnection.instances[0];
    const starting = session.start();
    await vi.waitFor(() =>
      expect(connection.setRemoteDescription).toHaveBeenCalledTimes(1),
    );
    connection.channel.open();
    await starting;
    return connection;
  }

  it("posts the local SDP with room credentials and applies the answer once", async () => {
    const session = createSession();
    const connection = FakePeerConnection.instances[0];

    let started = false;
    const starting = Promise.all([session.start(), session.start()]).then(() => {
      started = true;
    });
    await vi.waitFor(() =>
      expect(connection.setRemoteDescription).toHaveBeenCalledTimes(1),
    );
    await Promise.resolve();

    expect(started).toBe(false);

    connection.channel.open();
    await starting;

    expect(connection.createDataChannel).toHaveBeenCalledWith("oai-events");
    expect(connection.addTrack).toHaveBeenCalledTimes(1);
    expect(connection.addTrack).toHaveBeenCalledWith(audioTrack, stream);
    expect(connection.addTrack).not.toHaveBeenCalledWith(videoTrack, stream);
    expect(connection.createOffer).toHaveBeenCalledTimes(1);
    expect(connection.setLocalDescription).toHaveBeenCalledWith({
      type: "offer",
      sdp: "local-offer-sdp",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "/api/openai/transcription-session",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/sdp",
          Authorization: `Bearer ${secret}`,
          "X-Room-Id": roomId,
          "X-Participant-Id": participantId,
        },
        body: "local-offer-sdp",
      }),
    );
    expect(connection.setRemoteDescription).toHaveBeenCalledWith({
      type: "answer",
      sdp: "remote-answer-sdp",
    });
  });

  it("forwards transcription deltas with their item ID", () => {
    const onPartial = vi.fn();
    createSession({ onPartial });
    const channel = FakePeerConnection.instances[0].channel;

    channel.receive(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "item-1",
        delta: "안녕",
      }),
    );

    expect(onPartial).toHaveBeenCalledWith("item-1", "안녕");
  });

  it("rejects and cleans up when the data channel errors before opening", async () => {
    const session = createSession();
    const connection = FakePeerConnection.instances[0];
    const starting = session.start();
    await vi.waitFor(() =>
      expect(connection.setRemoteDescription).toHaveBeenCalledTimes(1),
    );

    connection.channel.fail();

    await expect(starting).rejects.toThrow("TRANSCRIPTION_CHANNEL_FAILED");
    expect(connection.channel.close).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("rejects and cleans up when the data channel closes before opening", async () => {
    const session = createSession();
    const connection = FakePeerConnection.instances[0];
    const starting = session.start();
    await vi.waitFor(() =>
      expect(connection.setRemoteDescription).toHaveBeenCalledTimes(1),
    );

    connection.channel.remoteClose();

    await expect(starting).rejects.toThrow("TRANSCRIPTION_CHANNEL_FAILED");
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it.each(["error", "close"] as const)(
    "reports and cleans up when an open data channel emits %s",
    async (failure) => {
      const onError = vi.fn();
      const session = createSession({ onError });
      const connection = await startAndOpen(session);

      if (failure === "error") connection.channel.fail();
      else connection.channel.remoteClose();

      expect(onError).toHaveBeenCalledTimes(1);
      expect(connection.close).toHaveBeenCalledTimes(1);
      session.commit();
      expect(connection.channel.send).not.toHaveBeenCalled();
    },
  );

  it("monitors later failures when the data channel is already open during negotiation", async () => {
    const onError = vi.fn();
    const session = createSession({ onError });
    const connection = FakePeerConnection.instances[0];
    connection.channel.open();

    await session.start();
    connection.channel.remoteClose();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("cleans up when offer creation fails", async () => {
    const session = createSession();
    const connection = FakePeerConnection.instances[0];
    connection.createOffer.mockRejectedValueOnce(new Error("offer failed"));

    await expect(session.start()).rejects.toThrow("offer failed");

    expect(connection.channel.close).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty answer SDP and cleans up", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("   ", { status: 200 }));
    const session = createSession();
    const connection = FakePeerConnection.instances[0];

    await expect(session.start()).rejects.toThrow(
      "TRANSCRIPTION_ANSWER_FAILED",
    );

    expect(connection.setRemoteDescription).not.toHaveBeenCalled();
    expect(connection.channel.close).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it.each(["createOffer", "setLocalDescription"] as const)(
    "lets start settle safely when close occurs during %s",
    async (phase) => {
      const session = createSession();
      const connection = FakePeerConnection.instances[0];
      let release!: () => void;
      if (phase === "createOffer") {
        connection.createOffer.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              release = () =>
                resolve({ type: "offer" as const, sdp: "late-offer" });
            }),
        );
      } else {
        connection.setLocalDescription.mockImplementationOnce(
          () =>
            new Promise<undefined>((resolve) => {
              release = () => resolve(undefined);
            }),
        );
      }

      const starting = session.start();
      if (phase === "setLocalDescription") {
        await vi.waitFor(() =>
          expect(connection.setLocalDescription).toHaveBeenCalledTimes(1),
        );
      }
      await session.close();
      release();

      await expect(starting).resolves.toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
      expect(connection.channel.close).toHaveBeenCalledTimes(1);
      expect(connection.close).toHaveBeenCalledTimes(1);
    },
  );

  it("emits one final per item with a nonnegative three-second window", () => {
    const now = vi.fn(() => 10_000);
    vi.stubGlobal("performance", { now });
    const onFinal = vi.fn();
    createSession({ onFinal });
    const channel = FakePeerConnection.instances[0].channel;
    now.mockReturnValue(12_500);
    const completed = JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-1",
      transcript: "안녕하세요",
    });

    channel.receive(completed);
    channel.receive(completed);

    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith(
      "item-1",
      "안녕하세요",
      0,
      2_500,
    );
  });

  it("uses a three-second window for finals later in the session", () => {
    const now = vi.fn(() => 10_000);
    vi.stubGlobal("performance", { now });
    const onFinal = vi.fn();
    createSession({ onFinal });
    now.mockReturnValue(14_500);

    FakePeerConnection.instances[0].channel.receive(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "item-later",
        transcript: "계속 이야기합니다",
      }),
    );

    expect(onFinal).toHaveBeenCalledWith(
      "item-later",
      "계속 이야기합니다",
      1_500,
      4_500,
    );
  });

  it("anchors committed audio windows to the shared meeting offset", async () => {
    vi.useFakeTimers();
    const onFinal = vi.fn();
    const session = createSession({ onFinal }, { meetingOffsetMs: 60_000 });
    const channel = FakePeerConnection.instances[0].channel;
    await startAndOpen(session);
    await vi.advanceTimersByTimeAsync(3_000);
    channel.receive(
      JSON.stringify({
        type: "input_audio_buffer.committed",
        item_id: "offset-item",
      }),
    );
    channel.receive(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "offset-item",
        transcript: "늦게 참여한 발화",
      }),
    );

    const [, , startMs, endMs] = onFinal.mock.calls[0];
    expect(startMs).toBeGreaterThanOrEqual(60_000);
    expect(endMs - startMs).toBe(3_000);
  });

  it("commits only after at least 100ms of unmuted audio is buffered", async () => {
    vi.useFakeTimers();
    const session = createSession();
    const channel = FakePeerConnection.instances[0].channel;

    session.commit();
    await startAndOpen(session);
    await vi.advanceTimersByTimeAsync(99);
    session.commit();

    expect(channel.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    session.commit();

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(channel.send.mock.calls[0][0])).toEqual({
      type: "input_audio_buffer.commit",
      event_id: expect.any(String),
    });
  });

  it("continues three-second commits while prior items transcribe asynchronously", async () => {
    vi.useFakeTimers();
    const onFinal = vi.fn();
    const session = createSession({ onFinal });
    const channel = FakePeerConnection.instances[0].channel;

    await startAndOpen(session);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(channel.send).toHaveBeenCalledTimes(1);

    channel.receive(
      JSON.stringify({
        type: "input_audio_buffer.committed",
        item_id: "item-commit-1",
      }),
    );
    await vi.advanceTimersByTimeAsync(3_000);

    expect(channel.send).toHaveBeenCalledTimes(2);

    channel.receive(
      JSON.stringify({
        type: "input_audio_buffer.committed",
        item_id: "item-commit-2",
      }),
    );
    await vi.advanceTimersByTimeAsync(3_000);
    expect(channel.send).toHaveBeenCalledTimes(3);
    channel.receive(
      JSON.stringify({
        type: "input_audio_buffer.committed",
        item_id: "item-commit-3",
      }),
    );
    channel.receive(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "item-commit-2",
        transcript: "두 번째 문장",
      }),
    );
    channel.receive(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "item-commit-3",
        transcript: "세 번째 문장",
      }),
    );
    expect(onFinal).not.toHaveBeenCalled();
    channel.receive(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "item-commit-1",
        transcript: "첫 번째 문장",
      }),
    );

    expect(onFinal).toHaveBeenCalledTimes(3);
    expect(onFinal.mock.calls.map(([itemId, text]) => [itemId, text])).toEqual([
      ["item-commit-1", "첫 번째 문장"],
      ["item-commit-2", "두 번째 문장"],
      ["item-commit-3", "세 번째 문장"],
    ]);
    const [, , firstStartMs, firstEndMs] = onFinal.mock.calls[0];
    const [, , secondStartMs, secondEndMs] = onFinal.mock.calls[1];
    const [, , thirdStartMs, thirdEndMs] = onFinal.mock.calls[2];
    expect(firstEndMs - firstStartMs).toBe(3_000);
    expect(secondEndMs - secondStartMs).toBe(3_000);
    expect(thirdEndMs - thirdStartMs).toBe(3_000);
    expect(firstEndMs).toBe(secondStartMs);
    expect(secondEndMs).toBe(thirdStartMs);
  });

  it("settles an empty completed item without publishing it and ignores later deltas", async () => {
    vi.useFakeTimers();
    const onPartial = vi.fn();
    const onFinal = vi.fn();
    const session = createSession({ onPartial, onFinal });
    const channel = FakePeerConnection.instances[0].channel;
    await startAndOpen(session);
    await vi.advanceTimersByTimeAsync(3_000);

    channel.receive(
      JSON.stringify({
        type: "input_audio_buffer.committed",
        item_id: "item-empty",
      }),
    );
    channel.receive(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "item-empty",
        transcript: "",
      }),
    );
    channel.receive(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "item-empty",
        delta: "late",
      }),
    );
    await vi.advanceTimersByTimeAsync(3_000);

    expect(onFinal).not.toHaveBeenCalled();
    expect(onPartial).toHaveBeenCalledTimes(1);
    expect(onPartial).toHaveBeenCalledWith("item-empty", "");
    expect(channel.send).toHaveBeenCalledTimes(2);
  });

  it("settles a failed transcription item and continues periodic commits", async () => {
    vi.useFakeTimers();
    const onPartial = vi.fn();
    const session = createSession({ onPartial });
    const channel = FakePeerConnection.instances[0].channel;
    await startAndOpen(session);
    await vi.advanceTimersByTimeAsync(3_000);

    channel.receive(
      JSON.stringify({
        type: "input_audio_buffer.committed",
        item_id: "item-failed",
      }),
    );
    channel.receive(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.failed",
        item_id: "item-failed",
        error: { code: "transcription_failed", message: "unable to transcribe" },
      }),
    );
    channel.receive(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "item-failed",
        delta: "late",
      }),
    );
    await vi.advanceTimersByTimeAsync(3_000);

    expect(onPartial).toHaveBeenCalledTimes(1);
    expect(onPartial).toHaveBeenCalledWith("item-failed", "");
    expect(channel.send).toHaveBeenCalledTimes(2);
  });

  it("commits on the transition to muted and pauses timed commits", async () => {
    vi.useFakeTimers();
    const session = createSession();
    const channel = FakePeerConnection.instances[0].channel;
    await startAndOpen(session);
    await vi.advanceTimersByTimeAsync(2_500);

    session.setMuted(true);
    session.setMuted(true);
    await vi.advanceTimersByTimeAsync(6_000);

    expect(channel.send).toHaveBeenCalledTimes(1);

    channel.receive(
      JSON.stringify({
        type: "input_audio_buffer.committed",
        item_id: "muted-item",
      }),
    );
    channel.receive(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "muted-item",
        transcript: "음소거 직전",
      }),
    );

    session.setMuted(false);
    await vi.advanceTimersByTimeAsync(2_999);

    expect(channel.send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);

    expect(channel.send).toHaveBeenCalledTimes(2);
  });

  it("detaches the transcription sender while muted and restores its audio track", async () => {
    const session = createSession();
    const connection = await startAndOpen(session);
    const sender = connection.senders[0];

    session.setMuted(true);

    await vi.waitFor(() => {
      expect(sender.replaceTrack).toHaveBeenCalledOnce();
    });
    expect(sender.replaceTrack).toHaveBeenLastCalledWith(null);

    session.setMuted(false);

    await vi.waitFor(() => {
      expect(sender.replaceTrack).toHaveBeenCalledTimes(2);
    });
    expect(sender.replaceTrack).toHaveBeenLastCalledWith(audioTrack);
  });

  it("drains a final commit before closing owned resources and leaves caller tracks alive", async () => {
    vi.useFakeTimers();
    const onFinal = vi.fn();
    const session = createSession({ onFinal });
    const connection = FakePeerConnection.instances[0];
    const channel = connection.channel;
    await startAndOpen(session);
    await vi.advanceTimersByTimeAsync(150);

    const closing = session.close();

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.close).not.toHaveBeenCalled();
    expect(connection.close).not.toHaveBeenCalled();
    expect(session.close()).toBe(closing);

    channel.receive(
      JSON.stringify({
        type: "input_audio_buffer.committed",
        item_id: "leaving-item",
      }),
    );
    channel.receive(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "leaving-item",
        transcript: "마지막 문장",
      }),
    );
    await closing;

    expect(onFinal).toHaveBeenCalledWith(
      "leaving-item",
      "마지막 문장",
      expect.any(Number),
      expect.any(Number),
    );
    expect(onFinal.mock.invocationCallOrder[0]).toBeLessThan(
      channel.close.mock.invocationCallOrder[0],
    );
    expect(channel.close).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(channel.send.mock.invocationCallOrder[0]).toBeLessThan(
      channel.close.mock.invocationCallOrder[0],
    );
    expect(channel.close.mock.invocationCallOrder[0]).toBeLessThan(
      connection.close.mock.invocationCallOrder[0],
    );
    expect(audioTrack.stop).not.toHaveBeenCalled();
    expect(videoTrack.stop).not.toHaveBeenCalled();
  });

  it("flushes audio accrued behind an existing commit before close completes", async () => {
    vi.useFakeTimers();
    const onFinal = vi.fn();
    const session = createSession({ onFinal });
    const connection = FakePeerConnection.instances[0];
    const channel = connection.channel;
    await startAndOpen(session);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(150);

    const closing = session.close();
    expect(channel.send).toHaveBeenCalledTimes(2);

    channel.receive(
      JSON.stringify({
        type: "input_audio_buffer.committed",
        item_id: "first-drain-item",
      }),
    );
    channel.receive(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "first-drain-item",
        transcript: "",
      }),
    );

    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(channel.close).not.toHaveBeenCalled();

    channel.receive(
      JSON.stringify({
        type: "input_audio_buffer.committed",
        item_id: "second-drain-item",
      }),
    );
    channel.receive(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "second-drain-item",
        transcript: "",
      }),
    );
    await closing;

    expect(onFinal).not.toHaveBeenCalled();
    expect(channel.close).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("flushes audio accrued behind an existing commit when muted", async () => {
    vi.useFakeTimers();
    const session = createSession();
    const channel = FakePeerConnection.instances[0].channel;
    await startAndOpen(session);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(150);

    session.setMuted(true);
    channel.receive(
      JSON.stringify({
        type: "input_audio_buffer.committed",
        item_id: "first-muted-item",
      }),
    );
    channel.receive(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "first-muted-item",
        transcript: "첫 구간",
      }),
    );

    expect(channel.send).toHaveBeenCalledTimes(2);

    channel.receive(
      JSON.stringify({
        type: "input_audio_buffer.committed",
        item_id: "second-muted-item",
      }),
    );
    channel.receive(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "second-muted-item",
        transcript: "두 번째 구간",
      }),
    );
    await vi.advanceTimersByTimeAsync(3_000);

    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(channel.close).not.toHaveBeenCalled();
    await session.close();
  });

  it("closes without an empty commit when less than 100ms is buffered", async () => {
    vi.useFakeTimers();
    const session = createSession();
    const connection = FakePeerConnection.instances[0];
    await startAndOpen(session);
    await vi.advanceTimersByTimeAsync(99);

    await session.close();

    expect(connection.channel.send).not.toHaveBeenCalled();
    expect(connection.channel.close).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("uses one bounded close deadline across an existing commit and its pending flush", async () => {
    vi.useFakeTimers();
    const session = createSession({}, { drainTimeoutMs: 500 });
    const connection = FakePeerConnection.instances[0];
    await startAndOpen(session);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(150);

    const closing = session.close();
    await vi.advanceTimersByTimeAsync(400);

    connection.channel.receive(
      JSON.stringify({
        type: "input_audio_buffer.committed",
        item_id: "timeout-first-item",
      }),
    );
    connection.channel.receive(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "timeout-first-item",
        transcript: "첫 구간",
      }),
    );

    expect(connection.channel.send).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(99);

    expect(connection.channel.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await closing;

    expect(connection.channel.close).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("settles a drain when OpenAI correlates a commit error by event ID", async () => {
    vi.useFakeTimers();
    const session = createSession({}, { drainTimeoutMs: 500 });
    const connection = FakePeerConnection.instances[0];
    await startAndOpen(session);
    await vi.advanceTimersByTimeAsync(150);

    const closing = session.close();
    const commit = JSON.parse(connection.channel.send.mock.calls[0][0]) as {
      event_id: string;
    };
    connection.channel.receive(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "input_audio_buffer_commit_empty",
          message: "buffer was empty",
          event_id: commit.event_id,
        },
      }),
    );
    await closing;

    expect(connection.channel.close).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("ignores malformed events and clears an empty terminal transcription", () => {
    const onPartial = vi.fn();
    const onFinal = vi.fn();
    createSession({ onPartial, onFinal });
    const channel = FakePeerConnection.instances[0].channel;

    expect(() => {
      channel.receive("{not-json");
      channel.receive(JSON.stringify(null));
      channel.receive(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.delta",
          item_id: "item-1",
        }),
      );
      channel.receive(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "",
          transcript: "빈 ID",
        }),
      );
      channel.receive(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "item-empty",
          transcript: "   ",
        }),
      );
    }).not.toThrow();
    expect(onPartial).toHaveBeenCalledOnce();
    expect(onPartial).toHaveBeenCalledWith("item-empty", "");
    expect(onFinal).not.toHaveBeenCalled();
  });

  it("aborts an in-flight exchange and ignores a response that arrives after close", async () => {
    let resolveFetch!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const session = createSession();
    const connection = FakePeerConnection.instances[0];

    const starting = session.start();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const request = vi.mocked(fetch).mock.calls[0][1];
    const signal = request?.signal as AbortSignal;

    const closing = session.close();
    await closing;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(true);

    resolveFetch(new Response("late-answer", { status: 200 }));
    await expect(starting).resolves.toBeUndefined();

    expect(connection.setRemoteDescription).not.toHaveBeenCalled();
  });

  it("rejects a failed SDP exchange without applying an answer", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("unauthorized", { status: 401 }),
    );
    const session = createSession();
    const connection = FakePeerConnection.instances[0];

    await expect(session.start()).rejects.toThrow(
      "TRANSCRIPTION_SESSION_FAILED",
    );
    expect(connection.setRemoteDescription).not.toHaveBeenCalled();
  });
});
