/**
 * Shared owner for direct-officer-run-pointer persistence under session/auditor-roles
 * (ADR 0018 / #675). Role modules project business facts; this module owns nest
 * directory derivation, mkdir/writeFile, and file naming.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const DIRECT_OFFICER_RUN_POINTER_KIND = "direct-officer-run-pointer" as const;

export type DirectOfficerRunPointer = {
  readonly version: 1;
  readonly kind: typeof DIRECT_OFFICER_RUN_POINTER_KIND;
  readonly officer: "inspector" | "notary";
  /** Absolute path to the officer session.jsonl 正本. */
  readonly sessionFile: string;
  /** Officer run directory when known. */
  readonly runDirectory?: string;
};

export type BookDirectOfficerRunPointerOptions = {
  readonly parentSessionFile: string;
  readonly officer: "inspector" | "notary";
  readonly sessionFile: string;
  readonly runDirectory?: string;
};

/**
 * Book a typed pointer under parent session/auditor-roles to the independent
 * officer run 正本. Never fabricates user/assistant/toolResult rows.
 */
export async function bookDirectOfficerRunPointer(
  options: BookDirectOfficerRunPointerOptions,
): Promise<DirectOfficerRunPointer> {
  const nest = join(dirname(options.parentSessionFile), "auditor-roles");
  await mkdir(nest, { recursive: true });
  const pointer: DirectOfficerRunPointer = {
    version: 1,
    kind: DIRECT_OFFICER_RUN_POINTER_KIND,
    officer: options.officer,
    sessionFile: options.sessionFile,
    ...(options.runDirectory !== undefined && options.runDirectory.trim() !== ""
      ? { runDirectory: options.runDirectory }
      : {}),
  };
  await writeFile(
    join(nest, `${options.officer}-${Date.now().toString(36)}.pointer.json`),
    `${JSON.stringify(pointer)}\n`,
    "utf8",
  );
  return pointer;
}
