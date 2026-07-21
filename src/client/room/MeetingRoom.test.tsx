// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { createRef } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Participant } from "../../shared/domain";
import { MeetingRoom } from "./MeetingRoom";

const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const SECRET = "room-capability-secret-123456789";
const SELF_ID = "00000000-0000-4000-8000-000000000001";
const REMOTE_ID = "00000000-0000-4000-8000-000000000002";

const participant = (
  id: string,
  displayName: string,
  overrides: Partial<Participant> = {},
): Participant => ({
  id,
  displayName,
  roleLabel: id === SELF_ID ? "PM" : "Engineer",
  muted: false,
  speaking: false,
  connected: true,
  ...overrides,
});

const baseProps = () => ({
  roomId: ROOM_ID,
  secret: SECRET,
  participants: [participant(SELF_ID, "민지")],
  selfParticipantId: SELF_ID,
  status: "connected" as const,
  muted: false,
  error: null,
  remoteAudioRef: createRef<HTMLAudioElement>(),
  onToggleMute: vi.fn(),
  onLeave: vi.fn(),
});

describe("MeetingRoom", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("renders exactly two human slots plus Recap with a waiting fallback", () => {
    render(<MeetingRoom {...baseProps()} />);
    const list = screen.getByTestId("participant-list");
    const slots = within(list).getAllByTestId("participant-slot");

    expect(slots).toHaveLength(3);
    expect(within(slots[0]).getByText("민지")).toBeInTheDocument();
    expect(within(slots[1]).getByText("참가자 대기 중")).toBeInTheDocument();
    expect(within(slots[2]).getByText("Recap")).toBeInTheDocument();
    expect(
      screen.getByText(/두 번째 참가자를 기다리는 동안에도/),
    ).toBeInTheDocument();
  });

  it("renders connected, speaking, and muted participant states", () => {
    const props = baseProps();
    props.participants = [
      participant(SELF_ID, "민지"),
      participant(REMOTE_ID, "준호", { muted: true, speaking: true }),
    ];
    render(<MeetingRoom {...props} />);

    const remoteSlot = screen.getByTestId(`participant-${REMOTE_ID}`);
    expect(remoteSlot).toHaveTextContent("연결됨");
    expect(remoteSlot).toHaveTextContent("말하는 중");
    expect(remoteSlot).toHaveTextContent("음소거됨");
    expect(
      screen.queryByText(/두 번째 참가자를 기다리는 동안에도/),
    ).not.toBeInTheDocument();
  });

  it("provides invite, mute, leave, and hidden autoplay audio controls", () => {
    const props = baseProps();
    render(<MeetingRoom {...props} />);

    const inviteInput = screen.getByTestId("invite-url");
    expect(inviteInput).toHaveAttribute("readonly");
    expect((inviteInput as HTMLInputElement).value).toContain(`room=${ROOM_ID}`);
    fireEvent.click(screen.getByRole("button", { name: "초대 링크 복사" }));
    const copiedUrl = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
    const parsed = new URL(copiedUrl);
    expect(parsed.origin).toBe(window.location.origin);
    expect(parsed.searchParams.get("room")).toBe(ROOM_ID);
    expect(parsed.searchParams.get("secret")).toBe(SECRET);

    fireEvent.click(screen.getByTestId("mute"));
    fireEvent.click(screen.getByTestId("leave-room"));
    expect(props.onToggleMute).toHaveBeenCalledTimes(1);
    expect(props.onLeave).toHaveBeenCalledTimes(1);

    const audio = screen.getByTestId("remote-audio");
    expect(audio).toHaveAttribute("autoplay");
    expect(audio).toHaveAttribute("hidden");
    expect(document.querySelector("video")).not.toBeInTheDocument();
  });

  it("does not allow mute changes before the room snapshot is connected", () => {
    const props = { ...baseProps(), status: "connecting" as const };
    render(<MeetingRoom {...props} />);

    fireEvent.click(screen.getByTestId("mute"));

    expect(screen.getByTestId("mute")).toBeDisabled();
    expect(props.onToggleMute).not.toHaveBeenCalled();
  });
});
