import { createHash, randomBytes } from "node:crypto";

export const createCapability = () => randomBytes(32).toString("base64url");

export const hashCapability = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");
