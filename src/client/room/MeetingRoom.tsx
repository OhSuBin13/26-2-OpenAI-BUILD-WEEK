import type { RefObject } from "react";
import type { Participant, TranscriptSegment } from "../../shared/domain";
import {
  TranscriptPanel,
  type TranscriptPartial,
} from "../transcript/TranscriptPanel";
import { ParticipantAvatar } from "./ParticipantAvatar";
import type { RoomConnectionStatus } from "./use-room";

interface MeetingRoomProps {
  roomId: string;
  secret: string;
  participants: Participant[];
  selfParticipantId: string | null;
  status: RoomConnectionStatus;
  muted: boolean;
  error: string | null;
  transcriptFinals: TranscriptSegment[];
  transcriptPartials: TranscriptPartial[];
  remoteAudioRef: RefObject<HTMLAudioElement | null>;
  onToggleMute(): void;
  onLeave(): void;
}

const statusLabel: Record<RoomConnectionStatus, string> = {
  idle: "연결 안 됨",
  joining: "마이크 준비 중",
  connecting: "회의실 연결 중",
  connected: "연결됨",
  error: "연결 오류",
};

export function MeetingRoom({
  roomId,
  secret,
  participants,
  selfParticipantId,
  status,
  muted,
  error,
  transcriptFinals,
  transcriptPartials,
  remoteAudioRef,
  onToggleMute,
  onLeave,
}: MeetingRoomProps) {
  const inviteUrl = (() => {
    const invite = new URL(window.location.href);
    invite.search = new URLSearchParams({ room: roomId, secret }).toString();
    invite.hash = "";
    return invite.toString();
  })();
  const humanSlots = participants.slice(0, 2);

  const copyInvite = () => {
    try {
      void navigator.clipboard?.writeText(inviteUrl).catch(() => undefined);
    } catch {
      // Clipboard access may be unavailable outside a secure browser context.
    }
  };

  return (
    <main className="meeting-shell">
      <header className="meeting-header">
        <div>
          <p className="eyebrow">LIVE AUDIO ROOM</p>
          <h1>Recap 회의</h1>
          <p className="connection-state" aria-live="polite">
            <span className={`connection-dot connection-dot--${status}`} />
            {statusLabel[status]}
          </p>
        </div>
        <div className="room-meta">
          <span>Room</span>
          <code>{roomId}</code>
          <label className="visually-hidden" htmlFor="meeting-invite-url">
            초대 URL
          </label>
          <input
            id="meeting-invite-url"
            className="visually-hidden"
            data-testid="invite-url"
            value={inviteUrl}
            readOnly
            tabIndex={-1}
          />
          <button
            type="button"
            className="button-secondary"
            onClick={copyInvite}
          >
            초대 링크 복사
          </button>
        </div>
      </header>

      {error ? <p className="form-error" role="alert">{error}</p> : null}

      <section aria-labelledby="participants-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">PARTICIPANTS</p>
            <h2 id="participants-title">참가자</h2>
          </div>
          <span>사람 2명 · AI 1명</span>
        </div>
        <ul className="participant-list" data-testid="participant-list">
          {[0, 1].map((index) => {
            const human = humanSlots[index];
            if (!human) {
              return (
                <ParticipantAvatar
                  key={`waiting-${index}`}
                  displayName="참가자 대기 중"
                  roleLabel="초대 링크로 참여할 수 있어요"
                  connected={false}
                  speaking={false}
                  muted={false}
                  testId={`participant-waiting-${index}`}
                  variant="waiting"
                />
              );
            }
            return (
              <ParticipantAvatar
                key={human.id}
                displayName={human.displayName}
                roleLabel={`${human.roleLabel}${human.id === selfParticipantId ? " · 나" : ""}`}
                connected={human.connected}
                speaking={human.speaking}
                muted={human.muted}
                testId={`participant-${human.id}`}
              />
            );
          })}
          <ParticipantAvatar
            displayName="Recap"
            roleLabel="AI 회의 참가자"
            connected
            speaking={false}
            muted={false}
            testId="participant-recap"
            variant="ai"
          />
        </ul>
      </section>

      {humanSlots.length < 2 ? (
        <section className="fallback-panel" aria-label="회의 기능 상태">
          <p>
            두 번째 참가자를 기다리는 동안에도 Recap과 회의 기록 기능을 사용할 수
            있습니다.
          </p>
        </section>
      ) : null}

      <TranscriptPanel
        participants={participants}
        transcriptFinals={transcriptFinals}
        transcriptPartials={transcriptPartials}
      />

      <footer className="meeting-controls">
        <button
          type="button"
          data-testid="mute"
          aria-pressed={muted}
          onClick={onToggleMute}
          disabled={status !== "connected"}
        >
          {muted ? "음소거 해제" : "음소거"}
        </button>
        <button
          type="button"
          className="button-danger"
          data-testid="leave-room"
          onClick={onLeave}
        >
          회의 나가기
        </button>
      </footer>

      <audio data-testid="remote-audio" ref={remoteAudioRef} autoPlay hidden />
    </main>
  );
}
