import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Typed parent-side pointer to an independent officer run 正本 (ADR 0079 / #675). */
export const DIRECT_OFFICER_RUN_POINTER_KIND = "direct-officer-run-pointer" as const;

export type DirectOfficerRunPointer = {
  readonly version: 1;
  readonly kind: typeof DIRECT_OFFICER_RUN_POINTER_KIND;
  readonly officer: "inspector" | "notary" | "auditor" | "countersign";
  /** Absolute path to the officer session.jsonl 正本. */
  readonly sessionFile: string;
  /** Officer run directory when known. */
  readonly runDirectory?: string;
  /**
   * Parent submission tool call this officer run was summoned for.
   * Absent on pointers booked before that binding existed.
   */
  readonly submissionToolCallId?: string;
};

/**
 * Book a typed pointer under parent session/auditor-roles (same nest owner as
 * createRecordSession). Never fabricates user/assistant/toolResult rows (#675).
 * Directory placement stays with the archivist record entry (ADR 0018 / 0065).
 *
 * Stable leaf per officer under one parent (#753 gate-round accounting):
 * same-parent re-summons upsert the same pointer instead of minting N files that
 * each re-scan the full officer session and multiply terminal gate-round counts.
 */
export function bookDirectOfficerRunPointer(options: {
  readonly parentSessionFile: string;
  readonly officer: "inspector" | "notary" | "auditor" | "countersign";
  readonly sessionFile: string;
  readonly runDirectory?: string;
  readonly submissionToolCallId?: string;
}): DirectOfficerRunPointer {
  const nest = join(dirname(options.parentSessionFile), "auditor-roles");
  mkdirSync(nest, { recursive: true });
  const submissionToolCallId = options.submissionToolCallId?.trim() ?? "";
  const pointer: DirectOfficerRunPointer = {
    version: 1,
    kind: DIRECT_OFFICER_RUN_POINTER_KIND,
    officer: options.officer,
    sessionFile: options.sessionFile,
    ...(options.runDirectory !== undefined && options.runDirectory.trim() !== ""
      ? { runDirectory: options.runDirectory }
      : {}),
    ...(submissionToolCallId === "" ? {} : { submissionToolCallId }),
  };
  writeFileSync(
    join(nest, `${options.officer}.pointer.json`),
    `${JSON.stringify(pointer)}\n`,
    "utf8",
  );
  return pointer;
}

function pointerRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Read the one officer pointer. Missing or unreadable is not a pass:
 * the caller re-runs the gate.
 */
export async function readDirectOfficerRunPointer(
  parentSessionFile: string,
  officer: DirectOfficerRunPointer["officer"],
): Promise<DirectOfficerRunPointer | undefined> {
  try {
    const raw = pointerRecord(JSON.parse(await readFile(
      join(dirname(parentSessionFile), "auditor-roles", `${officer}.pointer.json`),
      "utf8",
    )));
    if (raw === undefined || raw.kind !== DIRECT_OFFICER_RUN_POINTER_KIND || raw.version !== 1) {
      return undefined;
    }
    if (raw.officer !== officer) return undefined;
    if (typeof raw.sessionFile !== "string" || raw.sessionFile.trim() === "") return undefined;
    const runDirectory = typeof raw.runDirectory === "string" && raw.runDirectory.trim() !== ""
      ? raw.runDirectory
      : undefined;
    const submissionToolCallId = typeof raw.submissionToolCallId === "string"
      && raw.submissionToolCallId.trim() !== ""
      ? raw.submissionToolCallId
      : undefined;
    return {
      version: 1,
      kind: DIRECT_OFFICER_RUN_POINTER_KIND,
      officer,
      sessionFile: raw.sessionFile,
      ...(runDirectory === undefined ? {} : { runDirectory }),
      ...(submissionToolCallId === undefined ? {} : { submissionToolCallId }),
    };
  } catch {
    return undefined;
  }
}
