import "dotenv/config";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { createDb } from "./client";
import { decisionSources, knowledgeSources } from "./schema";

const db = createDb(process.env.DATABASE_URL!);
const demoSources = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    projectKey: "atlas-demo",
    type: "decision",
    title: "ADR-007 — PostgreSQL 마이그레이션 검토",
    content:
      "PostgreSQL 전환은 기술 문제가 아니라 담당자 부재, 약 3주의 일정 필요, 결제 기능 출시와의 충돌 때문에 보류했다.",
    meetingTimestampMs: null,
    metadata: { status: "postponed" },
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    projectKey: "atlas-demo",
    type: "transcript",
    title: "6월 29일 아키텍처 회의",
    content:
      "PostgreSQL 마이그레이션을 보류한다. 이번 분기에는 담당자가 없고 결제 기능 출시가 우선이며 전환에는 약 3주가 필요하다.",
    meetingTimestampMs: 1_122_000,
    metadata: { displayTimestamp: "18:42" },
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    projectKey: "atlas-demo",
    type: "document",
    title: "결제 시스템 출시 계획",
    content: "결제 기능 출시 후 데이터베이스 마이그레이션 기간을 별도로 확보할 수 있다.",
    meetingTimestampMs: null,
    metadata: {},
  },
] satisfies Array<typeof knowledgeSources.$inferInsert>;
const demoSourceIds = demoSources.map(({ id }) => id);

try {
  await db.transaction(async (tx) => {
    const staleSources = await tx
      .select({ id: knowledgeSources.id })
      .from(knowledgeSources)
      .where(
        and(
          eq(knowledgeSources.projectKey, "atlas-demo"),
          notInArray(knowledgeSources.id, demoSourceIds),
        ),
    );
    const staleSourceIds = staleSources.map(({ id }) => id);
    if (staleSourceIds.length > 0) {
      const referencedSources = await tx
        .select({ id: decisionSources.knowledgeSourceId })
        .from(decisionSources)
        .where(inArray(decisionSources.knowledgeSourceId, staleSourceIds));
      const referencedSourceIds = new Set(
        referencedSources.flatMap(({ id }) => (id === null ? [] : [id])),
      );
      const archivedSourceIds = staleSourceIds.filter((id) => referencedSourceIds.has(id));
      const unreferencedSourceIds = staleSourceIds.filter((id) => !referencedSourceIds.has(id));

      if (archivedSourceIds.length > 0) {
        await tx
          .update(knowledgeSources)
          .set({ projectKey: "atlas-demo-archive" })
          .where(inArray(knowledgeSources.id, archivedSourceIds));
      }
      if (unreferencedSourceIds.length > 0) {
        await tx
          .delete(knowledgeSources)
          .where(inArray(knowledgeSources.id, unreferencedSourceIds));
      }
    }

    for (const source of demoSources) {
      const { id: _id, ...values } = source;
      await tx
        .insert(knowledgeSources)
        .values(source)
        .onConflictDoUpdate({ target: knowledgeSources.id, set: values });
    }
  });

  console.log("Seeded Recap demo evidence");
} finally {
  await db.$client.end();
}
