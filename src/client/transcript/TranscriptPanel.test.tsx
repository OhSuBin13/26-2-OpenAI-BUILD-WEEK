// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Participant, TranscriptSegment } from "../../shared/domain";
import { TranscriptPanel, type TranscriptPartial } from "./TranscriptPanel";

const SELF_ID = "00000000-0000-4000-8000-000000000001";
const REMOTE_ID = "00000000-0000-4000-8000-000000000002";

const participants: Participant[] = [
  {
    id: SELF_ID,
    displayName: "민지",
    roleLabel: "PM",
    muted: false,
    speaking: false,
    connected: true,
  },
  {
    id: REMOTE_ID,
    displayName: "준호",
    roleLabel: "Engineer",
    muted: false,
    speaking: false,
    connected: true,
  },
];

const final = (
  overrides: Partial<TranscriptSegment> = {},
): TranscriptSegment => ({
  id: "00000000-0000-4000-8000-000000000010",
  itemId: "self-final",
  participantId: SELF_ID,
  displayName: "민지",
  text: "첫 번째 결정입니다.",
  startMs: 5_000,
  endMs: 6_000,
  ...overrides,
});

describe("TranscriptPanel", () => {
  afterEach(cleanup);

  it("groups finals by participant and renders one current partial per unfinished key", () => {
    const finals = [
      final({
        id: "00000000-0000-4000-8000-000000000011",
        itemId: "self-second",
        text: "두 번째 결정입니다.",
        startMs: 65_000,
        endMs: 66_000,
      }),
      final(),
    ];
    const partials: TranscriptPartial[] = [
      { participantId: REMOTE_ID, itemId: "remote-live", text: "진행" },
      { participantId: REMOTE_ID, itemId: "remote-live", text: "진행 중" },
      {
        participantId: SELF_ID,
        itemId: "self-final",
        text: "완료된 항목의 늦은 부분문",
      },
    ];

    render(
      <TranscriptPanel
        participants={participants}
        transcriptFinals={finals}
        transcriptPartials={partials}
      />,
    );

    const panel = screen.getByTestId("transcript-panel");
    expect(within(panel).getByRole("heading", { name: "민지" })).toBeInTheDocument();
    expect(within(panel).getByRole("heading", { name: "준호" })).toBeInTheDocument();
    const finalLines = screen.getAllByTestId("transcript-final");
    expect(finalLines).toHaveLength(2);
    expect(finalLines[0]).toHaveTextContent("첫 번째 결정입니다.");
    expect(finalLines[1]).toHaveTextContent("두 번째 결정입니다.");
    expect(screen.getAllByTestId("transcript-partial")).toHaveLength(1);
    expect(screen.getByTestId("transcript-partial")).toHaveTextContent("진행 중");
    expect(screen.queryByText("완료된 항목의 늦은 부분문")).not.toBeInTheDocument();
    expect(screen.getByText("00:05")).toBeInTheDocument();
    expect(screen.getByText("01:05")).toBeInTheDocument();
    expect(screen.getByText("상대 시간")).toBeInTheDocument();
  });

  it("announces an accessible empty transcript state", () => {
    render(
      <TranscriptPanel
        participants={participants}
        transcriptFinals={[]}
        transcriptPartials={[]}
      />,
    );

    const panel = screen.getByTestId("transcript-panel");
    expect(panel).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("아직 기록된 대화가 없습니다.")).toBeInTheDocument();
  });
});
