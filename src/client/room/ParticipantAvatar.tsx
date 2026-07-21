export interface ParticipantAvatarProps {
  displayName: string;
  roleLabel: string;
  connected: boolean;
  speaking: boolean;
  muted: boolean;
  testId: string;
  variant?: "human" | "ai" | "waiting";
}

export function ParticipantAvatar({
  displayName,
  roleLabel,
  connected,
  speaking,
  muted,
  testId,
  variant = "human",
}: ParticipantAvatarProps) {
  const initials =
    variant === "waiting"
      ? "?"
      : displayName
          .split(/\s+/)
          .map((part) => part[0])
          .join("")
          .slice(0, 2)
          .toUpperCase();

  return (
    <li className={`participant-slot participant-slot--${variant}`} data-testid="participant-slot">
      <article
        className={`participant-avatar${speaking ? " participant-avatar--speaking" : ""}`}
        data-testid={testId}
      >
        <div className="participant-avatar__portrait" aria-hidden="true">
          {initials}
        </div>
        <div className="participant-avatar__identity">
          <strong>{displayName}</strong>
          <span>{roleLabel}</span>
        </div>
        <div className="participant-avatar__states" aria-label={`${displayName} 상태`}>
          <span>{connected ? "연결됨" : "연결 대기"}</span>
          {speaking ? <span>말하는 중</span> : null}
          {muted ? <span>음소거됨</span> : null}
        </div>
      </article>
    </li>
  );
}
