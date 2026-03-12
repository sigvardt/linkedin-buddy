import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext } from "playwright-core";
import { LinkedInBuddyError } from "../errors.js";

/** Shape of an exported cookie entry. */
export interface ExportedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

/** Full session state snapshot for import/export. */
export interface ExportedSessionState {
  exportedAt: string;
  profileName: string;
  cookies: ExportedCookie[];
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

/**
 * Exports the current browser context session state (cookies + localStorage)
 * to a JSON file.
 */
export async function exportSessionState(
  context: BrowserContext,
  outputPath: string,
  profileName: string,
): Promise<ExportedSessionState> {
  const storageState = await context.storageState();

  const state: ExportedSessionState = {
    exportedAt: new Date().toISOString(),
    profileName,
    cookies: storageState.cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    })),
    origins: storageState.origins.map((o) => ({
      origin: o.origin,
      localStorage: o.localStorage.map((item) => ({
        name: item.name,
        value: item.value,
      })),
    })),
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(state, null, 2), "utf-8");

  return state;
}

/**
 * Imports session state from a JSON file into the browser context.
 * Adds cookies and injects localStorage for each origin.
 */
export async function importSessionState(
  context: BrowserContext,
  inputPath: string,
): Promise<ExportedSessionState> {
  let raw: string;
  try {
    raw = await readFile(inputPath, "utf-8");
  } catch (error) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `Could not read session state file: ${inputPath}`,
      { path: inputPath },
      { cause: error instanceof Error ? error : new Error(String(error)) },
    );
  }

  let state: ExportedSessionState;
  try {
    state = JSON.parse(raw) as ExportedSessionState;
  } catch (error) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `Invalid JSON in session state file: ${inputPath}`,
      { path: inputPath },
      { cause: error instanceof Error ? error : new Error(String(error)) },
    );
  }

  if (!Array.isArray(state.cookies) || state.cookies.length === 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "Session state file contains no cookies.",
      { path: inputPath },
    );
  }

  await context.addCookies(
    state.cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    })),
  );

  return state;
}

/**
 * Checks whether the exported session state contains a valid LinkedIn
 * `li_at` session token.
 */
export function hasLinkedInSessionToken(state: ExportedSessionState): boolean {
  return state.cookies.some(
    (c) =>
      c.name === "li_at" &&
      c.domain.includes("linkedin.com") &&
      c.value.trim().length > 0,
  );
}
