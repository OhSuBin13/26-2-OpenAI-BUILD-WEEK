// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const SECRET = "room-capability-secret-123456789";
const SELF_ID = "00000000-0000-4000-8000-000000000001";

const roomState = vi.hoisted(() => ({
  participants: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      displayName: "민지",
      roleLabel: "PM",
      muted: false,
      speaking: false,
      connected: true,
    },
  ],
  selfParticipantId: "00000000-0000-4000-8000-000000000001",
  status: "connected" as const,
  error: null,
  muted: false,
  transcriptFinals: [
    {
      id: "00000000-0000-4000-8000-000000000020",
      itemId: "wired-final",
      participantId: "00000000-0000-4000-8000-000000000001",
      displayName: "민지",
      text: "앱에서 전달된 회의록",
      startMs: 0,
      endMs: 1_000,
    },
  ],
  transcriptPartials: [],
  remoteAudioRef: { current: null },
  join: vi.fn(async () => undefined),
  toggleMute: vi.fn(),
  leave: vi.fn(async () => undefined),
}));

vi.mock("./room/use-room", () => ({ useRoom: () => roomState }));

describe("App", () => {
  beforeEach(() => {
    roomState.join.mockClear();
    roomState.leave.mockClear();
    window.history.replaceState(
      {},
      "",
      `/?room=${ROOM_ID}&secret=${encodeURIComponent(SECRET)}`,
    );
  });

  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("stays in the lobby until join and returns there after leave", async () => {
    render(<App />);
    expect(screen.getByTestId("join-room")).toBeInTheDocument();
    expect(screen.queryByTestId("participant-list")).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId("display-name"), {
      target: { value: "민지" },
    });
    fireEvent.change(screen.getByTestId("role-label"), {
      target: { value: "PM" },
    });
    fireEvent.click(screen.getByTestId("join-room"));

    await waitFor(() => expect(roomState.join).toHaveBeenCalledTimes(1));
    expect(roomState.join).toHaveBeenCalledWith({
      roomId: ROOM_ID,
      secret: SECRET,
      displayName: "민지",
      roleLabel: "PM",
    });
    expect(screen.getByTestId("participant-list")).toBeInTheDocument();
    expect(screen.getByTestId("transcript-final")).toHaveTextContent(
      "앱에서 전달된 회의록",
    );

    fireEvent.click(screen.getByTestId("leave-room"));
    expect(roomState.leave).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("join-room")).toBeInTheDocument();
    expect(screen.queryByTestId("participant-list")).not.toBeInTheDocument();
    expect(roomState.selfParticipantId).toBe(SELF_ID);
  });
});
