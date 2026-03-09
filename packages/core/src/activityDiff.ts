import { createHash } from "node:crypto";
import type { ActivityEntityType } from "./activityTypes.js";
import type { ActivityEntityStateRow } from "./db/database.js";

export interface ActivityEntityRecord {
  entityKey: string;
  entityType: ActivityEntityType;
  fingerprint: string;
  snapshot: Record<string, unknown>;
  url?: string;
}

export interface ActivityEntityDiffResult {
  created: ActivityEntityRecord[];
  updated: Array<{
    current: ActivityEntityRecord;
    previous: Record<string, unknown>;
  }>;
  unchanged: ActivityEntityRecord[];
}

function normalizeObjectEntries(
  value: Record<string, unknown>
): Array<[string, unknown]> {
  return Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
}

export function stableStringify(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  if (typeof value === "object") {
    return `{${normalizeObjectEntries(value as Record<string, unknown>)
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${stableStringify(entry)}`
      )
      .join(",")}}`;
  }

  return JSON.stringify(String(value));
}

export function hashStableValue(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

export function parseActivityEntitySnapshot(
  snapshotJson: string
): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(snapshotJson));
  } catch {
    return {};
  }
}

export function diffActivityEntities(
  existingRows: ActivityEntityStateRow[],
  currentEntities: ActivityEntityRecord[]
): ActivityEntityDiffResult {
  const existingByKey = new Map(
    existingRows.map((row) => [row.entity_key, row])
  );
  const created: ActivityEntityRecord[] = [];
  const updated: Array<{
    current: ActivityEntityRecord;
    previous: Record<string, unknown>;
  }> = [];
  const unchanged: ActivityEntityRecord[] = [];

  for (const entity of currentEntities) {
    const previous = existingByKey.get(entity.entityKey);
    if (!previous) {
      created.push(entity);
      continue;
    }

    if (previous.fingerprint !== entity.fingerprint) {
      updated.push({
        current: entity,
        previous: parseActivityEntitySnapshot(previous.snapshot_json)
      });
      continue;
    }

    unchanged.push(entity);
  }

  return {
    created,
    updated,
    unchanged
  };
}
