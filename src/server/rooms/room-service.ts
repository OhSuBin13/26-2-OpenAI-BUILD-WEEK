import { randomUUID } from "node:crypto";
import type { Participant } from "../../shared/domain";

interface RoomLookup {
  verifyCapability(roomId: string, capabilityHash: string): Promise<boolean>;
  getMeetingId(roomId: string): Promise<string | null>;
}

export interface ParticipantStore {
  insert(input: {
    id: string;
    meetingId: string;
    displayName: string;
    roleLabel: string;
  }): Promise<void>;
  markLeft(participantId: string): Promise<void>;
}

interface JoinInput {
  roomId: string;
  secret: string;
  displayName: string;
  roleLabel: string;
}

export class RoomService {
  private readonly presence = new Map<string, Map<string, Participant>>();
  private readonly meetingIds = new Map<string, string>();
  private readonly roomLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly rooms: RoomLookup,
    private readonly participantStore: ParticipantStore,
    private readonly hash: (secret: string) => string,
  ) {}

  async join(input: JoinInput, signal?: AbortSignal): Promise<Participant> {
    return this.withRoomLock(input.roomId, async () => {
      this.ensureAdmissionActive(signal);
      const capabilityValid = await this.rooms.verifyCapability(
        input.roomId,
        this.hash(input.secret),
      );
      this.ensureAdmissionActive(signal);
      if (!capabilityValid) throw new Error("ROOM_UNAVAILABLE");

      const meetingId = await this.rooms.getMeetingId(input.roomId);
      this.ensureAdmissionActive(signal);
      if (!meetingId) throw new Error("ROOM_UNAVAILABLE");

      const members = this.presence.get(input.roomId) ?? new Map<string, Participant>();
      if (members.size >= 2) throw new Error("ROOM_FULL");

      const participant: Participant = {
        id: randomUUID(),
        displayName: input.displayName,
        roleLabel: input.roleLabel,
        muted: false,
        speaking: false,
        connected: true,
      };
      await this.participantStore.insert({
        id: participant.id,
        meetingId,
        displayName: participant.displayName,
        roleLabel: participant.roleLabel,
      });
      if (signal?.aborted) {
        await this.participantStore.markLeft(participant.id);
        throw new Error("ROOM_UNAVAILABLE");
      }
      members.set(participant.id, participant);
      this.presence.set(input.roomId, members);
      this.meetingIds.set(input.roomId, meetingId);
      return participant;
    });
  }

  async leave(roomId: string, participantId: string): Promise<void> {
    await this.withRoomLock(roomId, async () => {
      const participant = this.getParticipant(roomId, participantId);
      if (!participant) return;

      this.presence.get(roomId)?.delete(participantId);
      await this.participantStore.markLeft(participantId);
    });
  }

  snapshot(roomId: string): Participant[] {
    return [...(this.presence.get(roomId)?.values() ?? [])];
  }

  getParticipant(roomId: string, participantId: string): Participant | null {
    return this.presence.get(roomId)?.get(participantId) ?? null;
  }

  getMeetingId(roomId: string): string | null {
    return this.meetingIds.get(roomId) ?? null;
  }

  setMuted(roomId: string, participantId: string, muted: boolean): void {
    const participant = this.getParticipant(roomId, participantId);
    if (participant) participant.muted = muted;
  }

  setSpeaking(roomId: string, participantId: string, speaking: boolean): void {
    const participant = this.getParticipant(roomId, participantId);
    if (participant) participant.speaking = speaking;
  }

  async drain(): Promise<void> {
    while (this.roomLocks.size > 0) {
      await Promise.all([...this.roomLocks.values()]);
    }
  }

  private ensureAdmissionActive(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error("ROOM_UNAVAILABLE");
  }

  private async withRoomLock<T>(roomId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.roomLocks.get(roomId) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.roomLocks.set(roomId, tail);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.roomLocks.get(roomId) === tail) this.roomLocks.delete(roomId);
    }
  }
}
