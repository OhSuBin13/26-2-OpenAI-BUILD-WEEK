# Recap MVP Product Specification

- Status: Approved
- Date: 2026-07-15
- Event: OpenAI Build Week
- Delivery window: 7 days
- Working name: Recap (리캡)

## 1. Product statement

Recap is an AI meeting participant that stays silent until called, retrieves the reasons behind past decisions from meeting records and a Decision Wiki, answers with evidence during the meeting, and saves new decisions only after explicit human approval.

> 회의가 끝난 뒤 요약하는 AI가 아니라, 회의 중 과거의 조직 기억을 불러오고 오늘의 결정을 미래의 조직 기억으로 저장하는 AI 동료.

## 2. Problem

Important team decisions and their rationale are scattered across transcripts, documents, and individual memory. Teams consequently:

- forget why a decision was made;
- repeat discussions that already happened;
- confuse suggestions with accepted decisions;
- fail to preserve the rationale behind a final decision; and
- make onboarding difficult because historical context is hard to recover.

## 3. Target user

The MVP targets software and product teams of 2–10 people that hold frequent technical decision meetings and already have records but struggle to retrieve the relevant context.

The Build Week demo supports exactly two human participants and one AI participant.

## 4. Primary user journey

1. Two participants open the same public meeting-room URL on a desktop and a laptop.
2. They join with display names and communicate by audio.
3. Each participant's speech appears in the live transcript with their identity.
4. A participant says “리캡아” or presses the **Ask Recap** button.
5. Recap searches previous meetings, project records, and the Decision Wiki.
6. GPT-5.6 Sol compares the retrieved evidence with the current meeting context.
7. Recap gives a short spoken answer and shows source documents and timestamps on screen.
8. A participant states a new decision and asks Recap to record it.
9. Recap reads back the structured decision and asks for confirmation.
10. Only after explicit confirmation does Recap create the Decision Wiki entry.

## 5. MVP capabilities

### Meeting room

- Join a public room URL with a display name.
- Support up to two human participants and one AI participant.
- Show an audio avatar for every participant.
- Mute and unmute the local microphone.
- Send bidirectional human audio using peer-to-peer WebRTC.
- Show connection and speaking states.

### Live transcript

- Stream each participant's microphone to a separate transcription session.
- Display partial and final transcript segments.
- Attach the participant identity and a meeting-relative timestamp to each final segment.
- Synchronize final transcript segments across both browsers.

### AI participant

- Stay silent until called by wake phrase or button.
- Search seeded project records, past transcripts, and Decision Wiki entries.
- Use GPT-5.6 Sol to synthesize and compare evidence.
- Speak a concise answer through a Realtime voice model.
- Show document titles and meeting timestamps alongside the answer.
- Say that the evidence was not found instead of guessing.

### Decision Wiki

- Detect a decision-recording request.
- Extract the decision, rationale, owner, date, duration, alternatives, and sources.
- Ask one short follow-up if required information is missing.
- Read the complete proposed decision before saving.
- Require explicit human approval.
- Persist and synchronize the accepted Decision Wiki entry.

## 6. Explicit non-goals

The Build Week MVP will not include:

- webcam video;
- more than two human participants;
- screen sharing;
- text chat;
- user accounts or social login;
- organizations, teams, or role management;
- mobile optimization;
- Zoom, Google Meet, or Teams integration;
- calendar integration;
- meeting video recording;
- arbitrary user file uploads;
- production-grade access control, scalability, or compliance;
- payments; or
- external web search during a meeting.

The historical meeting and project documents used in the demo are seeded before the presentation.

## 7. Demo operating assumptions

- One presenter operates both devices and performs both human roles.
- The two devices are placed side by side on the same network.
- Only the device currently used for speaking has its microphone enabled.
- AI audio is played from the desktop only during the live presentation to avoid acoustic feedback.
- The application is accessed through a public HTTPS URL.
- A single-device mode remains available as a fallback.

## 8. Success criteria

The MVP is accepted when all of the following are demonstrated:

1. Two browsers join the same room through a public URL.
2. Each participant can send an audio track to the other browser.
3. Speech from both devices is attributed correctly in the live transcript.
4. Either participant can invoke Recap.
5. Recap retrieves the relevant seeded decision and past-meeting source.
6. Every factual answer shows at least one valid document or transcript timestamp.
7. Both clients receive the same AI answer, evidence, and AI state.
8. Recap never saves a decision before explicit confirmation.
9. An approved decision appears on both clients in the Decision Wiki.
10. The core judging flow finishes within four minutes.
11. The complete demo succeeds three consecutive times without a blocking failure.

## 9. Product differentiation

Most meeting tools organize information after a meeting. Recap participates during the meeting: it brings historical organizational memory into the current discussion and sends newly approved decisions back into that memory with traceable evidence.

## 10. Scope-change rule

Any new feature must directly improve one of the four judging moments below. Otherwise it is postponed until after Build Week.

1. Two-browser live meeting
2. Evidence-backed in-meeting answer
3. GPT-5.6 Sol reasoning over past and current context
4. Human-approved Decision Wiki creation
