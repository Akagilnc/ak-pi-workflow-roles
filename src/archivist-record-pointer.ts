import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
   * Parent submission round this summons reviewed (#1057).
   * toolCallId + ledger attemptId already identify the round; a later
   * convergence of this officer must not pass a different round.
   */
  readonly toolCallId?: string;
  readonly attemptId?: string;
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
  readonly toolCallId?: string;
  readonly attemptId?: string;
}): DirectOfficerRunPointer {
  const nest = join(dirname(options.parentSessionFile), "auditor-roles");
  mkdirSync(nest, { recursive: true });
  const pointer: DirectOfficerRunPointer = {
    version: 1,
    kind: DIRECT_OFFICER_RUN_POINTER_KIND,
    officer: options.officer,
    sessionFile: options.sessionFile,
    ...(options.runDirectory !== undefined && options.runDirectory.trim() !== ""
      ? { runDirectory: options.runDirectory }
      : {}),
    ...(options.toolCallId !== undefined && options.toolCallId.length > 0
      ? { toolCallId: options.toolCallId }
      : {}),
    ...(options.attemptId !== undefined && options.attemptId.length > 0
      ? { attemptId: options.attemptId }
      : {}),
  };
  writeFileSync(
    join(nest, `${options.officer}.pointer.json`),
    `${JSON.stringify(pointer)}\n`,
    "utf8",
  );
  return pointer;
}

function isPointerRecord(value: unknown): value is DirectOfficerRunPointer {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.kind === DIRECT_OFFICER_RUN_POINTER_KIND && record.version === 1
    && typeof record.sessionFile === "string"
    && (record.officer === "inspector" || record.officer === "notary"
      || record.officer === "auditor" || record.officer === "countersign");
}

/** Read the stable officer pointer. Missing file is absence; damaged JSON propagates. */
export function readDirectOfficerRunPointer(
  parentSessionFile: string,
  officer: DirectOfficerRunPointer["officer"],
): DirectOfficerRunPointer | undefined {
  const path = join(dirname(parentSessionFile), "auditor-roles", `${officer}.pointer.json`);
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isPointerRecord(parsed) || parsed.officer !== officer) return undefined;
    return parsed;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}
