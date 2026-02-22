import { randomBytes } from "node:crypto";

export function createRunId(now: Date = new Date()): string {
  const timestamp = now.toISOString().replace(/[-:.TZ]/g, "");
  const entropy = randomBytes(5).toString("hex");
  return `run_${timestamp}_${entropy}`;
}
