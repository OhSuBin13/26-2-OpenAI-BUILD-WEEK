import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCapability, hashCapability } from "./capability";
import { RoomService } from "./room-service";

const roomId = randomUUID();
const meetingId = randomUUID();

function createFixture(options: { capabilityValid?: boolean; insertGate?: Promise<void> } = {}) {
  const repository = {
    verifyCapability: vi.fn(async () => options.capabilityValid ?? true),
    getMeetingId: vi.fn<() => Promise<string | null>>(async () => meetingId),
  };
  const participantStore = {
    insert: vi.fn(async () => {
      await options.insertGate;
    }),
    markLeft: vi.fn(async () => undefined),
  };
  const service = new RoomService(repository, participantStore, hashCapability);

  return { participantStore, repository, service };
}

const joinInput = (displayName: string) => ({
  roomId,
  secret: "a-valid-capability-secret",
  displayName,
  roleLabel: "Engineer",
});

describe("capabilities", () => {
  it("creates opaque secrets and hashes them deterministically", () => {
    const secret = createCapability();

    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashCapability(secret)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashCapability(secret)).toBe(hashCapability(secret));
    expect(hashCapability(secret)).not.toContain(secret);
  });
});

describe("RoomService", () => {
  it("admits exactly two participants and rejects a third", async () => {
    const { participantStore, service } = createFixture();

    await service.join(joinInput("민지"));
    await service.join(joinInput("준호"));

    await expect(service.join(joinInput("Third"))).rejects.toThrow("ROOM_FULL");
    expect(service.snapshot(roomId)).toHaveLength(2);
    expect(participantStore.insert).toHaveBeenCalledTimes(2);
  });

  it("keeps the two-person limit when joins race", async () => {
    let releaseInsert: () => void = () => {};
    const insertGate = new Promise<void>((resolve) => {
      releaseInsert = resolve;
    });
    const { participantStore, service } = createFixture({ insertGate });

    const pendingResults = Promise.allSettled([
      service.join(joinInput("민지")),
      service.join(joinInput("준호")),
      service.join(joinInput("Third")),
    ]);
    await vi.waitFor(() => expect(participantStore.insert).toHaveBeenCalled());
    releaseInsert();
    const results = await pendingResults;

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ message: "ROOM_FULL" }) }),
    ]);
    expect(service.snapshot(roomId)).toHaveLength(2);
    expect(participantStore.insert).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid capability without looking up room details", async () => {
    const { participantStore, repository, service } = createFixture({ capabilityValid: false });

    await expect(service.join(joinInput("X"))).rejects.toThrow("ROOM_UNAVAILABLE");
    expect(repository.getMeetingId).not.toHaveBeenCalled();
    expect(participantStore.insert).not.toHaveBeenCalled();
  });

  it("rejects a room without a meeting as unavailable", async () => {
    const { participantStore, repository, service } = createFixture();
    repository.getMeetingId.mockResolvedValueOnce(null);

    await expect(service.join(joinInput("X"))).rejects.toThrow("ROOM_UNAVAILABLE");
    expect(participantStore.insert).not.toHaveBeenCalled();
  });

  it("tracks participant state and releases capacity after leave", async () => {
    const { participantStore, service } = createFixture();
    const participant = await service.join(joinInput("민지"));

    service.setMuted(roomId, participant.id, true);
    service.setSpeaking(roomId, participant.id, true);

    expect(service.getParticipant(roomId, participant.id)).toMatchObject({
      muted: true,
      speaking: true,
    });
    expect(service.getMeetingId(roomId)).toBe(meetingId);

    await service.leave(roomId, participant.id);

    expect(service.getParticipant(roomId, participant.id)).toBeNull();
    expect(participantStore.markLeft).toHaveBeenCalledWith(participant.id);
  });

  it("keeps one meeting timeline across participants and later rejoins", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T09:00:00.000Z"));
    try {
      const { service } = createFixture();
      const first = await service.join(joinInput("민지"));
      expect(service.getMeetingElapsedMs(roomId)).toBe(0);

      vi.advanceTimersByTime(45_000);
      const second = await service.join(joinInput("준호"));
      expect(service.getMeetingElapsedMs(roomId)).toBe(45_000);

      await service.leave(roomId, first.id);
      vi.advanceTimersByTime(15_000);
      await service.join(joinInput("재입장"));
      expect(service.getMeetingElapsedMs(roomId)).toBe(60_000);

      await service.leave(roomId, second.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains pending presence persistence before shutdown", async () => {
    let releaseMarkLeft: () => void = () => {};
    const markLeftGate = new Promise<void>((resolve) => {
      releaseMarkLeft = resolve;
    });
    const repository = {
      verifyCapability: vi.fn(async () => true),
      getMeetingId: vi.fn(async () => meetingId),
    };
    const participantStore = {
      insert: vi.fn(async () => undefined),
      markLeft: vi.fn(async () => markLeftGate),
    };
    const service = new RoomService(repository, participantStore, hashCapability);
    const participant = await service.join(joinInput("민지"));
    const leaving = service.leave(roomId, participant.id);
    await vi.waitFor(() => expect(participantStore.markLeft).toHaveBeenCalled());

    let drainSettled = false;
    const draining = service.drain().then(() => {
      drainSettled = true;
    });
    await Promise.resolve();

    expect(drainSettled).toBe(false);
    releaseMarkLeft();
    await Promise.all([leaving, draining]);
    expect(drainSettled).toBe(true);
  });

  it("drains a join that is still verifying its capability", async () => {
    let releaseVerification: () => void = () => {};
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    const repository = {
      verifyCapability: vi.fn(async () => {
        await verificationGate;
        return true;
      }),
      getMeetingId: vi.fn(async () => meetingId),
    };
    const participantStore = {
      insert: vi.fn(async () => undefined),
      markLeft: vi.fn(async () => undefined),
    };
    const service = new RoomService(repository, participantStore, hashCapability);
    const joining = service.join(joinInput("민지"));
    await vi.waitFor(() => expect(repository.verifyCapability).toHaveBeenCalled());

    let drainSettled = false;
    const draining = service.drain().then(() => {
      drainSettled = true;
    });
    await Promise.resolve();

    expect(drainSettled).toBe(false);
    releaseVerification();
    await Promise.all([joining, draining]);
    expect(drainSettled).toBe(true);
  });
});
