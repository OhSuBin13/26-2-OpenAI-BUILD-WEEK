import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

let child: ChildProcessWithoutNullStreams | null = null;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child?.once("exit", () => resolve()));
  }
  child = null;
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function waitForHealth(
  url: string,
  output: () => string,
  exited: () => boolean,
): Promise<Response> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (exited()) throw new Error(`Server exited before health check:\n${output()}`);
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return response;
    } catch {
      // The child has not started listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for health check:\n${output()}`);
}

describe("server composition", () => {
  it(
    "uses parsed env, configures Socket.IO CORS, and shuts down on SIGTERM",
    async () => {
      const port = await availablePort();
      const origin = "http://localhost:5173";
      let stdout = "";
      let stderr = "";
      let exitResult: { code: number | null; signal: NodeJS.Signals | null } | null = null;

      child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: "test",
          PORT: String(port),
          APP_ORIGIN: origin,
          DATABASE_URL: "postgres://recap:recap@localhost:5432/recap",
          DEMO_FAKE_OPENAI: "1",
          OPENAI_API_KEY: "",
        },
      });
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          child?.once("exit", (code, signal) => {
            exitResult = { code, signal };
            resolve({ code, signal });
          });
        },
      );
      const output = () => `${stdout}\n${stderr}`;
      const baseUrl = `http://127.0.0.1:${port}`;

      const health = await waitForHealth(baseUrl, output, () => exitResult !== null);
      await expect(health.json()).resolves.toEqual({ ok: true });
      expect(stdout).toContain(`0.0.0.0:${port}`);

      const preflight = await fetch(`${baseUrl}/socket.io/`, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "GET",
        },
      });
      expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);

      child.kill("SIGTERM");
      await expect(exited).resolves.toEqual({ code: 0, signal: null });
      child = null;
      expect(stderr).toBe("");
    },
    10_000,
  );
});
