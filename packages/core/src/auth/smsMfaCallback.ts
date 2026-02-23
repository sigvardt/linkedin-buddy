import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_IMSG_PATH = "/opt/homebrew/bin/imsg";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;

/**
 * Known LinkedIn verification code patterns:
 *   "Your LinkedIn verification code is XXXXXX."
 *   "Your LinkedIn verification code is XXXXXX"
 *   "LinkedIn: XXXXXX is your verification code"
 *
 * Fallback: any text mentioning "linkedin" (case-insensitive) plus
 * "verification" or "code" near a standalone 6-digit number.
 */
const LINKEDIN_CODE_PATTERNS: RegExp[] = [
  /\bverification\s+code\s+is\s+(\d{6})\b/i,
  /\b(\d{6})\s+is\s+your\s+verification\s+code\b/i,
];

const FALLBACK_SIX_DIGITS = /\b(\d{6})\b/;

/**
 * Extract a 6-digit LinkedIn verification code from an SMS text body.
 * Returns the code string if found, otherwise `undefined`.
 */
export function extractLinkedInCode(text: string): string | undefined {
  if (!text) {
    return undefined;
  }

  const lower = text.toLowerCase();
  if (!lower.includes("linkedin")) {
    return undefined;
  }

  for (const pattern of LINKEDIN_CODE_PATTERNS) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      return match[1];
    }
  }

  // Fallback: "linkedin" present and "verification" or "code" present with a 6-digit number
  if (lower.includes("verification") || lower.includes("code")) {
    const fallback = FALLBACK_SIX_DIGITS.exec(text);
    if (fallback?.[1]) {
      return fallback[1];
    }
  }

  return undefined;
}

interface ImsgChat {
  id: number;
  identifier: string;
  service: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

interface ImsgMessage {
  text: string;
  created_at: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

function parseNdjson<T>(stdout: string): T[] {
  const results: T[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      results.push(JSON.parse(trimmed) as T);
    } catch {
      // skip malformed lines
    }
  }
  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SmsMfaCallbackOptions {
  /** Maximum time to wait for the SMS (ms). Default: 120 000 */
  timeoutMs?: number;
  /** Interval between polls (ms). Default: 3 000 */
  pollIntervalMs?: number;
  /** Path to the imsg binary. Default: /opt/homebrew/bin/imsg */
  imsgPath?: string;
}

/**
 * Create an MFA callback that auto-retrieves a LinkedIn verification code
 * from macOS Messages via the `imsg` CLI.
 *
 * `startTime` is recorded at factory creation (before the login attempt
 * triggers the SMS) so that only newer messages are considered.
 *
 * The returned callback resolves with the 6-digit code string,
 * or `undefined` if the timeout is exceeded.
 */
export function createSmsMfaCallback(
  options?: SmsMfaCallbackOptions
): () => Promise<string | undefined> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const imsgPath = options?.imsgPath ?? DEFAULT_IMSG_PATH;
  const startTime = Date.now();

  return async (): Promise<string | undefined> => {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const code = await pollForCode(imsgPath, startTime);
        if (code) {
          return code;
        }
      } catch {
        // imsg failure — keep retrying until deadline
      }

      if (Date.now() + pollIntervalMs > deadline) {
        break;
      }
      await sleep(pollIntervalMs);
    }

    return undefined;
  };
}

async function runImsg(imsgPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(imsgPath, args, {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

async function findLinkedInChatId(imsgPath: string): Promise<number | undefined> {
  const stdout = await runImsg(imsgPath, ["chats", "--limit", "20", "--json"]);
  const chats = parseNdjson<ImsgChat>(stdout);

  for (const chat of chats) {
    if (
      typeof chat.identifier === "string" &&
      chat.identifier.toLowerCase().includes("linkedin")
    ) {
      return chat.id;
    }
  }

  return undefined;
}

async function pollForCode(
  imsgPath: string,
  startTime: number
): Promise<string | undefined> {
  const chatId = await findLinkedInChatId(imsgPath);
  if (chatId === undefined) {
    return undefined;
  }

  const stdout = await runImsg(imsgPath, [
    "history",
    "--chat-id",
    String(chatId),
    "--limit",
    "5",
    "--json",
  ]);

  const messages = parseNdjson<ImsgMessage>(stdout);

  for (const msg of messages) {
    if (!msg.text || !msg.created_at) {
      continue;
    }
    const msgTime = new Date(msg.created_at).getTime();
    if (msgTime < startTime) {
      continue;
    }
    const code = extractLinkedInCode(msg.text);
    if (code) {
      return code;
    }
  }

  return undefined;
}
