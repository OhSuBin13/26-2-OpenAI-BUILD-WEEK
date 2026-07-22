import type { Participant, TranscriptSegment } from "../../shared/domain";

export interface TranscriptPartial {
  participantId: string;
  itemId: string;
  text: string;
}

interface TranscriptPanelProps {
  participants: Participant[];
  transcriptFinals: TranscriptSegment[];
  transcriptPartials: TranscriptPartial[];
}

interface ParticipantTranscriptGroup {
  participantId: string;
  displayName: string;
  finals: TranscriptSegment[];
  partials: TranscriptPartial[];
}

const transcriptKey = (participantId: string, itemId: string): string =>
  `${participantId}\u0000${itemId}`;

const formatMeetingTime = (timestampMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(timestampMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

export function TranscriptPanel({
  participants,
  transcriptFinals,
  transcriptPartials,
}: TranscriptPanelProps) {
  const participantNames = new Map(
    participants.map(({ id, displayName }) => [id, displayName]),
  );
  const finalKeys = new Set(
    transcriptFinals.map(({ participantId, itemId }) =>
      transcriptKey(participantId, itemId),
    ),
  );
  const currentPartials = new Map<string, TranscriptPartial>();
  transcriptPartials.forEach((partial) => {
    const key = transcriptKey(partial.participantId, partial.itemId);
    if (!finalKeys.has(key)) currentPartials.set(key, partial);
  });

  const groups = new Map<string, ParticipantTranscriptGroup>();
  transcriptFinals.forEach((segment) => {
    const group = groups.get(segment.participantId) ?? {
      participantId: segment.participantId,
      displayName: segment.displayName,
      finals: [],
      partials: [],
    };
    group.displayName = segment.displayName;
    group.finals.push(segment);
    groups.set(segment.participantId, group);
  });
  currentPartials.forEach((partial) => {
    const group = groups.get(partial.participantId) ?? {
      participantId: partial.participantId,
      displayName:
        participantNames.get(partial.participantId) ?? "알 수 없는 참가자",
      finals: [],
      partials: [],
    };
    group.partials.push(partial);
    groups.set(partial.participantId, group);
  });
  groups.forEach((group) => {
    group.finals.sort(
      (left, right) =>
        left.startMs - right.startMs ||
        left.endMs - right.endMs ||
        left.itemId.localeCompare(right.itemId),
    );
  });

  return (
    <section
      className="transcript-panel"
      data-testid="transcript-panel"
      aria-labelledby="transcript-title"
      aria-live="polite"
      aria-atomic="false"
    >
      <div className="section-heading transcript-panel__heading">
        <div>
          <p className="eyebrow">LIVE TRANSCRIPT</p>
          <h2 id="transcript-title">실시간 회의록</h2>
        </div>
        <span>상대 시간</span>
      </div>

      {groups.size === 0 ? (
        <p className="transcript-panel__empty">
          아직 기록된 대화가 없습니다.
        </p>
      ) : (
        <div className="transcript-groups" role="log" aria-label="회의 발언 기록">
          {[...groups.values()].map((group) => (
            <article
              className="transcript-group"
              key={group.participantId}
              aria-label={`${group.displayName} 발언`}
            >
              <h3>{group.displayName}</h3>
              <div className="transcript-group__items">
                {group.finals.map((segment) => (
                  <p
                    className="transcript-line transcript-line--final"
                    data-testid="transcript-final"
                    key={transcriptKey(segment.participantId, segment.itemId)}
                  >
                    <time>{formatMeetingTime(segment.startMs)}</time>
                    <span>{segment.text}</span>
                  </p>
                ))}
                {group.partials.map((partial) => (
                  <p
                    className="transcript-line transcript-line--partial"
                    data-testid="transcript-partial"
                    key={transcriptKey(partial.participantId, partial.itemId)}
                  >
                    <span className="visually-hidden">실시간 기록: </span>
                    <span>{partial.text}</span>
                  </p>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
