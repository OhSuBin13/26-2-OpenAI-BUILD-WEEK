import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";

const requiredEnvironment = {
  APP_ORIGIN: "http://localhost:5173",
  DATABASE_URL: "postgres://recap:recap@localhost:5432/recap",
};

describe("parseEnv", () => {
  it("applies the exact Recap defaults in fake-AI mode", () => {
    const env = parseEnv({ ...requiredEnvironment, DEMO_FAKE_OPENAI: "1" });

    expect(env).toMatchObject({
      NODE_ENV: "development",
      PORT: 3000,
      OPENAI_API_KEY: "",
      OPENAI_TRANSCRIBE_MODEL: "gpt-realtime-whisper",
      OPENAI_REALTIME_MODEL: "gpt-realtime-2.1-mini",
      OPENAI_SOL_MODEL: "gpt-5.6-sol",
      DEMO_FAKE_OPENAI: "1",
      ENABLE_TEST_ROUTES: "0",
      MAX_MEETING_MINUTES: 20,
      MAX_AI_REQUESTS_PER_ROOM: 20,
      SOL_TIMEOUT_MS: 15_000,
    });
  });

  it("coerces valid numeric overrides", () => {
    const env = parseEnv({
      ...requiredEnvironment,
      DEMO_FAKE_OPENAI: "1",
      PORT: "4000",
      MAX_MEETING_MINUTES: "30",
      MAX_AI_REQUESTS_PER_ROOM: "12",
      SOL_TIMEOUT_MS: "9000",
    });

    expect(env).toMatchObject({
      PORT: 4000,
      MAX_MEETING_MINUTES: 30,
      MAX_AI_REQUESTS_PER_ROOM: 12,
      SOL_TIMEOUT_MS: 9_000,
    });
  });

  it("requires an OpenAI API key outside fake-AI mode", () => {
    expect(() => parseEnv({ ...requiredEnvironment, DEMO_FAKE_OPENAI: "0" })).toThrow(
      "Required outside fake-AI test mode",
    );
  });

  it("rejects invalid application and database URLs", () => {
    expect(() =>
      parseEnv({ ...requiredEnvironment, APP_ORIGIN: "not-a-url", DEMO_FAKE_OPENAI: "1" }),
    ).toThrow();
    expect(() =>
      parseEnv({ ...requiredEnvironment, DATABASE_URL: "not-a-url", DEMO_FAKE_OPENAI: "1" }),
    ).toThrow();
  });
});
