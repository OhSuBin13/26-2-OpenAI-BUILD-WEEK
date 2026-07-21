import { useState, type SubmitEvent } from "react";
import type { RoomSocketAuth } from "./room-socket";

interface LobbyProps {
  onJoin(input: RoomSocketAuth): Promise<void> | void;
}

interface CreateRoomResponse {
  roomId: string;
  secret: string;
}

const capabilityFromLocation = () => {
  const params = new URLSearchParams(window.location.search);
  return {
    roomId: params.get("room") ?? "",
    secret: params.get("secret") ?? "",
  };
};

const currentOriginInviteUrl = (roomId: string, secret: string): string => {
  const invite = new URL(window.location.href);
  invite.search = new URLSearchParams({ room: roomId, secret }).toString();
  invite.hash = "";
  return invite.toString();
};

export function Lobby({ onJoin }: LobbyProps) {
  const [initialCapability] = useState(capabilityFromLocation);
  const [roomId, setRoomId] = useState(initialCapability.roomId);
  const [secret, setSecret] = useState(initialCapability.secret);
  const [displayName, setDisplayName] = useState("");
  const [roleLabel, setRoleLabel] = useState("");
  const [inviteUrl, setInviteUrl] = useState(() =>
    initialCapability.roomId && initialCapability.secret
      ? currentOriginInviteUrl(
          initialCapability.roomId,
          initialCapability.secret,
        )
      : "",
  );
  const [busy, setBusy] = useState<"create" | "join" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const identityComplete = Boolean(displayName.trim() && roleLabel.trim());
  const capabilityComplete = Boolean(roomId.trim() && secret.trim());

  const joinRoom = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!identityComplete || !capabilityComplete || busy) return;
    setBusy("join");
    setError(null);
    try {
      await onJoin({
        roomId: roomId.trim(),
        secret: secret.trim(),
        displayName: displayName.trim(),
        roleLabel: roleLabel.trim(),
      });
    } catch {
      setError("회의실에 참여하지 못했습니다. 다시 시도해 주세요.");
      setBusy(null);
    }
  };

  const createRoom = async () => {
    if (!identityComplete || busy) return;
    setBusy("create");
    setError(null);
    try {
      const response = await fetch("/api/rooms", { method: "POST" });
      if (!response.ok) throw new Error(`Room creation failed: ${response.status}`);
      const created = (await response.json()) as Partial<CreateRoomResponse>;
      if (!created.roomId || !created.secret) {
        throw new Error("Room creation returned an invalid capability");
      }
      const nextInviteUrl = currentOriginInviteUrl(
        created.roomId,
        created.secret,
      );
      const invite = new URL(nextInviteUrl);
      window.history.replaceState(
        window.history.state,
        "",
        `${invite.pathname}${invite.search}`,
      );
      setRoomId(created.roomId);
      setSecret(created.secret);
      setInviteUrl(nextInviteUrl);
      await onJoin({
        roomId: created.roomId,
        secret: created.secret,
        displayName: displayName.trim(),
        roleLabel: roleLabel.trim(),
      });
    } catch {
      setError("회의실을 만들지 못했습니다. 다시 시도해 주세요.");
      setBusy(null);
    }
  };

  return (
    <main className="lobby-shell">
      <section className="lobby-card" aria-labelledby="lobby-title">
        <div className="brand-mark" aria-hidden="true">R</div>
        <p className="eyebrow">AUDIO MEETING</p>
        <h1 id="lobby-title">Recap 회의실</h1>
        <p className="lobby-card__intro">
          두 사람이 음성으로 대화하고, Recap이 회의의 맥락을 함께 기억합니다.
        </p>

        <form onSubmit={joinRoom} className="lobby-form">
          <label>
            이름
            <input
              data-testid="display-name"
              value={displayName}
              maxLength={40}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="예: 민지"
              autoComplete="name"
            />
          </label>
          <label>
            역할
            <input
              data-testid="role-label"
              value={roleLabel}
              maxLength={40}
              onChange={(event) => setRoleLabel(event.target.value)}
              placeholder="예: PM"
            />
          </label>
          <label>
            회의실 ID
            <input
              value={roomId}
              onChange={(event) => setRoomId(event.target.value)}
              placeholder="초대 링크에서 자동 입력됩니다"
            />
          </label>
          <label>
            회의실 비밀키
            <input
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder="초대 링크에서 자동 입력됩니다"
              type="password"
            />
          </label>
          <label className="visually-hidden" htmlFor="lobby-invite-url">
            초대 URL
          </label>
          <input
            id="lobby-invite-url"
            className="visually-hidden"
            data-testid="invite-url"
            value={inviteUrl}
            readOnly
            tabIndex={-1}
          />

          {error ? <p className="form-error" role="alert">{error}</p> : null}

          <div className="lobby-actions">
            <button
              data-testid="create-room"
              type="button"
              onClick={() => void createRoom()}
              disabled={!identityComplete || busy !== null}
            >
              {busy === "create" ? "만드는 중…" : "새 회의실 만들기"}
            </button>
            <button
              data-testid="join-room"
              type="submit"
              className="button-secondary"
              disabled={!identityComplete || !capabilityComplete || busy !== null}
            >
              {busy === "join" ? "참여하는 중…" : "초대받은 회의실 참여"}
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
