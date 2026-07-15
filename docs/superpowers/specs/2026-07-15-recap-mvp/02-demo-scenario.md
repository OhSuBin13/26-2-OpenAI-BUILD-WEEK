# Recap Build Week Demo Scenario

- Status: Approved
- Target duration: 4 minutes
- Presenter count: 1
- Devices: 1 desktop and 1 laptop

## 1. Demo purpose

The demo must prove, in one uninterrupted story, that Recap can:

1. participate in a real two-browser audio room;
2. transcribe both participants;
3. retrieve a past decision with evidence;
4. use GPT-5.6 Sol to compare past conditions with the current meeting;
5. answer through an AI voice; and
6. save a new decision only after human approval.

## 2. Roles and devices

| Device | Participant | Role | Audio policy |
|---|---|---|---|
| Desktop | 민지 | Product Manager | Primary AI audio output |
| Laptop | 준호 | Backend Engineer | Speaker muted during demo |
| Application | 리캡 | AI Participant | Appears on both screens |

The presenter performs both human roles. Before changing roles, the presenter mutes the current microphone and unmutes the other device. Only one microphone is active at a time.

## 3. Seeded evidence

### ADR-007 — PostgreSQL migration review

- Previous decision: postpone the PostgreSQL migration.
- Reason 1: no migration owner was available.
- Reason 2: approximately three weeks were required for migration.
- Reason 3: the work conflicted with the payment-feature launch.
- Source meeting: June 29 architecture meeting at `18:42`.

The application must return these exact source identifiers in the demo. Wording may vary, but the factual claims may not.

## 4. Pre-demo checklist

- [ ] Public HTTPS URL opens on both devices.
- [ ] Both browsers have microphone permission.
- [ ] Desktop is signed in as `민지 — PM`.
- [ ] Laptop is signed in as `준호 — Backend`.
- [ ] Both devices show `리캡 — AI Participant`.
- [ ] Laptop speaker is muted.
- [ ] Only one microphone is enabled.
- [ ] ADR-007 and the June 29 transcript are seeded.
- [ ] Decision Wiki contains no entry from the current rehearsal.
- [ ] Wake phrase and **Ask Recap** button are tested.
- [ ] Single-device fallback and backup recording are ready.

## 5. Four-minute script

### 0:00–0:30 — Establish the product

Create the room on the desktop and join the same URL from the laptop. Show the three participant avatars.

Presenter narration:

> “리캡은 회의가 끝난 뒤 요약만 하는 도구가 아닙니다. 회의 중 과거 결정의 이유를 찾아 답하고 새로운 결정을 다시 조직의 기억으로 저장하는 AI 참석자입니다.”

Expected UI:

```text
● 민지 — PM
● 준호 — Backend
● 리캡 — AI Participant · 대기 중
```

### 0:30–1:00 — Prove live transcription

On the desktop, unmute 민지 and say:

> “오늘은 PostgreSQL 마이그레이션을 다시 진행할 수 있는지 결정하겠습니다.”

Mute the desktop. On the laptop, unmute 준호 and say:

> “지난 회의에서 PostgreSQL 전환을 보류했었잖아요. 정확한 이유가 무엇이었죠?”

Expected synchronized transcript:

```text
[00:12] 민지: 오늘은 PostgreSQL 마이그레이션을 다시 진행할 수 있는지 결정하겠습니다.
[00:31] 준호: 지난 회의에서 PostgreSQL 전환을 보류한 정확한 이유가 무엇이었죠?
```

### 1:00–1:40 — Invoke Recap and retrieve evidence

From the laptop, say:

> “리캡아, 이전 회의에서 PostgreSQL 도입을 보류했던 이유를 찾아줘.”

Expected AI state transition:

```text
듣는 중 → 기록 검색 중 → 분석 중 → 말하는 중
```

Expected spoken answer:

> “PostgreSQL의 기술적인 문제 때문이 아니라 담당 인력과 일정 때문에 보류했습니다. 마이그레이션에 약 3주가 필요했지만 담당자가 없었고, 결제 기능 출시와 일정이 충돌했습니다.”

Expected evidence card on both screens:

```text
근거
• ADR-007 — PostgreSQL 마이그레이션 검토
• 6월 29일 아키텍처 회의 — 18:42 [원문 보기]
```

### 1:40–2:30 — Demonstrate GPT-5.6 Sol reasoning

Mute the laptop and unmute the desktop. As 민지, say:

> “지금은 담당자가 확보됐고 결제 기능 출시 후 3주의 일정도 확보할 수 있어. 그러면 이전 보류 조건이 해소된 것으로 봐도 될까?”

Expected answer:

> “네. 이전 기록의 보류 조건은 담당자 부족, 3주의 일정 부족, 결제 출시와의 충돌이었습니다. 지금 말씀하신 조건대로라면 세 가지가 모두 해소된 것으로 볼 수 있습니다. 다만 이것은 기존 기록과 현재 발언을 비교한 판단이므로 최종 결정은 팀의 확인이 필요합니다.”

This is the primary GPT-5.6 Sol judging moment. The answer must visibly compare past conditions with current statements rather than merely repeat a retrieved paragraph.

### 2:30–3:30 — Confirm and save a decision

As 민지, say:

> “그러면 8월 5일부터 PostgreSQL 마이그레이션을 시작하고, 담당자는 준호로 결정하겠습니다. 리캡아, 기록해 줘.”

Expected AI confirmation:

> “다음 내용으로 기록할까요? 8월 5일부터 PostgreSQL 마이그레이션을 시작하고, 담당자는 준호이며 예상 기간은 3주입니다.”

Approve:

> “네, 그렇게 기록해 줘.”

Expected Decision Wiki entry:

```text
PostgreSQL 마이그레이션 진행

상태: Accepted
시작일: 8월 5일
담당자: 준호
예상 기간: 3주

결정 이유:
• 이전 보류 조건 해소
• 마이그레이션 담당자 확보
• 결제 기능 출시 이후 일정 확보

근거:
• 현재 회의의 최종 결정 발언
• ADR-007
• 6월 29일 회의 18:42
```

The new entry must appear on both screens.

### 3:30–4:00 — Close with the value proposition

> “리캡은 회의를 단순히 기록하는 AI가 아닙니다. 과거 조직의 기억을 현재 회의로 가져오고, 오늘의 결정을 미래의 조직 기억으로 돌려보내는 AI 동료입니다.”

## 6. Failure fallbacks

| Failure | Immediate fallback |
|---|---|
| Wake phrase not detected | Press **Ask Recap** and repeat the same question |
| Laptop audio causes feedback | Keep laptop output muted and use visual speaking indicators |
| P2P connection drops | Press **Reconnect** once; otherwise continue in single-device mode |
| AI voice fails | Keep the streamed text answer and evidence visible |
| GPT-5.6 Sol times out | Show a retry action; do not substitute an unsupported answer |
| Database save fails | Keep the proposed decision visible and show **Save failed** |
| Public deployment is unavailable | Run the pretested local build and use the backup screen recording only as a last resort |

## 7. Rehearsal acceptance

The final demo build is presentation-ready only after the full script succeeds three times in a row on the same network and devices used for judging.
