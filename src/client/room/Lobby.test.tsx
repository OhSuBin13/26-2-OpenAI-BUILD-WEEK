// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Lobby } from "./Lobby";
import lobbySource from "./Lobby.tsx?raw";

const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const SECRET = "room-capability-secret-123456789";

function roomResponse() {
  return {
    ok: true,
    status: 201,
    json: vi.fn(async () => ({
      roomId: ROOM_ID,
      secret: SECRET,
      inviteUrl: `https://configured.example/?room=${ROOM_ID}&secret=${SECRET}`,
    })),
  };
}

describe("Lobby", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", "/");
  });

  it("uses the submit-specific React event type", () => {
    expect(lobbySource).toMatch(/event:\s*SubmitEvent<HTMLFormElement>/);
    expect(lobbySource).not.toMatch(/\bFormEvent\b/);
  });

  it("prefills room capability from the URL and joins with the entered identity", async () => {
    window.history.replaceState(
      {},
      "",
      `/?room=${ROOM_ID}&secret=${encodeURIComponent(SECRET)}`,
    );
    const onJoin = vi.fn(async () => undefined);
    render(<Lobby onJoin={onJoin} />);

    expect(screen.getByLabelText("회의실 ID")).toHaveValue(ROOM_ID);
    expect(screen.getByLabelText("회의실 비밀키")).toHaveValue(SECRET);
    fireEvent.change(screen.getByTestId("display-name"), {
      target: { value: "민지" },
    });
    fireEvent.change(screen.getByTestId("role-label"), {
      target: { value: "PM" },
    });
    fireEvent.click(screen.getByTestId("join-room"));

    await waitFor(() =>
      expect(onJoin).toHaveBeenCalledWith({
        roomId: ROOM_ID,
        secret: SECRET,
        displayName: "민지",
        roleLabel: "PM",
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("creates a room, writes a same-origin invite URL to history, and joins it", async () => {
    vi.mocked(fetch).mockResolvedValue(roomResponse() as never);
    const onJoin = vi.fn(async () => undefined);
    render(<Lobby onJoin={onJoin} />);
    fireEvent.change(screen.getByTestId("display-name"), {
      target: { value: "준호" },
    });
    fireEvent.change(screen.getByTestId("role-label"), {
      target: { value: "Backend" },
    });

    fireEvent.click(screen.getByTestId("create-room"));

    await waitFor(() => expect(onJoin).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith("/api/rooms", { method: "POST" });
    expect(onJoin).toHaveBeenCalledWith({
      roomId: ROOM_ID,
      secret: SECRET,
      displayName: "준호",
      roleLabel: "Backend",
    });
    const currentUrl = new URL(window.location.href);
    expect(currentUrl.origin).toBe(window.location.origin);
    expect(currentUrl.searchParams.get("room")).toBe(ROOM_ID);
    expect(currentUrl.searchParams.get("secret")).toBe(SECRET);
    expect(currentUrl.origin).not.toBe("https://configured.example");
    expect(screen.getByTestId("invite-url")).toHaveValue(window.location.href);
  });

  it("keeps input and allows retry after a recoverable create error", async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(roomResponse() as never);
    const onJoin = vi.fn(async () => undefined);
    render(<Lobby onJoin={onJoin} />);
    fireEvent.change(screen.getByTestId("display-name"), {
      target: { value: "민지" },
    });
    fireEvent.change(screen.getByTestId("role-label"), {
      target: { value: "PM" },
    });

    fireEvent.click(screen.getByTestId("create-room"));
    expect(
      await screen.findByText("회의실을 만들지 못했습니다. 다시 시도해 주세요."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("display-name")).toHaveValue("민지");
    expect(screen.getByTestId("create-room")).toBeEnabled();

    fireEvent.click(screen.getByTestId("create-room"));
    await waitFor(() => expect(onJoin).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByText("회의실을 만들지 못했습니다. 다시 시도해 주세요."),
    ).not.toBeInTheDocument();
  });
});
