import { z } from "zod";

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    APP_ORIGIN: z.url(),
    DATABASE_URL: z.url(),
    OPENAI_API_KEY: z.string().default(""),
    OPENAI_TRANSCRIBE_MODEL: z.literal("gpt-realtime-whisper").default("gpt-realtime-whisper"),
    OPENAI_REALTIME_MODEL: z.literal("gpt-realtime-2.1-mini").default("gpt-realtime-2.1-mini"),
    OPENAI_SOL_MODEL: z.literal("gpt-5.6-sol").default("gpt-5.6-sol"),
    DEMO_FAKE_OPENAI: z.enum(["0", "1"]).default("0"),
    ENABLE_TEST_ROUTES: z.enum(["0", "1"]).default("0"),
    MAX_MEETING_MINUTES: z.coerce.number().int().positive().default(20),
    MAX_AI_REQUESTS_PER_ROOM: z.coerce.number().int().positive().default(20),
    SOL_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  })
  .superRefine((env, ctx) => {
    if (env.DEMO_FAKE_OPENAI === "0" && env.OPENAI_API_KEY.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["OPENAI_API_KEY"],
        message: "Required outside fake-AI test mode",
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export const parseEnv = (input: NodeJS.ProcessEnv): Env => EnvSchema.parse(input);
