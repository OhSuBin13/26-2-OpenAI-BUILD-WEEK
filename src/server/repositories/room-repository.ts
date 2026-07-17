import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { meetings, rooms } from "../db/schema";

export class RoomRepository {
  constructor(private readonly db: Database) {}

  async create(capabilityHash: string, projectKey: string) {
    return this.db.transaction(async (tx) => {
      const [room] = await tx.insert(rooms).values({ capabilityHash, projectKey }).returning();
      const [meeting] = await tx
        .insert(meetings)
        .values({ roomId: room.id, title: "Build Week Architecture Review" })
        .returning();
      return { ...room, meetingId: meeting.id };
    });
  }

  async verifyCapability(roomId: string, capabilityHash: string) {
    const [room] = await this.db
      .select({ id: rooms.id })
      .from(rooms)
      .where(and(eq(rooms.id, roomId), eq(rooms.capabilityHash, capabilityHash)))
      .limit(1);
    return Boolean(room);
  }

  async get(roomId: string) {
    const [room] = await this.db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
    return room ?? null;
  }

  async getMeetingId(roomId: string) {
    const [meeting] = await this.db
      .select({ id: meetings.id })
      .from(meetings)
      .where(eq(meetings.roomId, roomId))
      .limit(1);
    return meeting?.id ?? null;
  }
}
