export const ADR_ID = "00000000-0000-4000-8000-000000000001";
export const HISTORY_TRANSCRIPT_ID = "00000000-0000-4000-8000-000000000002";
export const RELEASE_PLAN_ID = "00000000-0000-4000-8000-000000000003";

export const demoSources = [
  {
    id: ADR_ID,
    projectKey: "atlas-demo",
    type: "decision" as const,
    title: "ADR-007 — PostgreSQL 마이그레이션 검토",
    content:
      "PostgreSQL 전환은 기술 문제가 아니라 담당자 부재, 약 3주의 일정 필요, 결제 기능 출시와의 충돌 때문에 보류했다.",
    meetingTimestampMs: null,
    metadata: { status: "postponed" },
  },
  {
    id: HISTORY_TRANSCRIPT_ID,
    projectKey: "atlas-demo",
    type: "transcript" as const,
    title: "6월 29일 아키텍처 회의",
    content:
      "PostgreSQL 마이그레이션을 보류한다. 이번 분기에는 담당자가 없고 결제 기능 출시가 우선이며 전환에는 약 3주가 필요하다.",
    meetingTimestampMs: 1_122_000,
    metadata: { displayTimestamp: "18:42" },
  },
  {
    id: RELEASE_PLAN_ID,
    projectKey: "atlas-demo",
    type: "document" as const,
    title: "결제 시스템 출시 계획",
    content: "결제 기능 출시 후 데이터베이스 마이그레이션 기간을 별도로 확보할 수 있다.",
    meetingTimestampMs: null,
    metadata: {},
  },
];
