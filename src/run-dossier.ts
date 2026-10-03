/**
 * Single authority for the per-leg dossier files (docs/dossier-topology.md, #1161):
 * `current.json` (whole-file rewrite), `history.jsonl` (append-only),
 * `log.jsonl` (sitian stream) and the one host original. Callers name a section
 * of `current.json`; no caller addresses the file path or serializes it itself.
 *
 * Read-modify-write is synchronous: within one process it cannot interleave.
 * Across processes the writers mostly take turns — the parent CLI is parked on the child leg while the child
 * writes (diarist ticket bind), yet manual resume and gate officers can write
 * one run from another process, so every read-modify-write holds a short
 * interprocess lock. Whole-file replacement is atomic for readers.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isMissingPathError, isRecord } from "./unknown-value.ts";

export const RUN_CURRENT_FILE = "current.json" as const;
export const RUN_HISTORY_FILE = "history.jsonl" as const;
export const RUN_LOG_FILE = "log.jsonl" as const;

/** Sections of `current.json`. One name per source page of the old sixteen files. */
export type CurrentSection =
  | "invocation"
  | "admitted"
  | "runState"
  | "host"
  | "delivery"
  | "submission"
  | "terminal"
  | "officers";

export function runCurrentPath(runDirectory: string): string {
  return join(runDirectory, RUN_CURRENT_FILE);
}

/** The whole `current.json`, or undefined when absent (ENOENT only). */
export function readCurrentSync(runDirectory: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(runCurrentPath(runDirectory), "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new TypeError(`${RUN_CURRENT_FILE} is not an object: ${runCurrentPath(runDirectory)}`);
  return parsed;
}

/**
 * Interprocess exclusion for one read-modify-write of current.json. Several
 * processes legitimately write one run (a live leg, a manual resume, a gate
 * officer's pointer booking), each a different section; without this the later
 * whole-file write would drop the earlier one's section. A `mkdir` lock with a
 * pid file: a holder whose pid is dead is stale and is broken. A directory that
 * refuses new entries (settlement after a chmod) skips the lock — the same
 * degradation as the in-place write fallback below.
 */
function withCurrentLock<T>(runDirectory: string, action: () => T): T {
  const lock = join(runDirectory, `.${RUN_CURRENT_FILE}.lock`);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM" || code === "EROFS" || code === "ENOENT") return action();
      if (code !== "EEXIST") throw error;
      let holder: number | undefined;
      try { holder = Number.parseInt(readFileSync(join(lock, "pid"), "utf8"), 10); } catch { /* holder is mid-creation */ }
      if (holder !== undefined && Number.isInteger(holder) && holder > 0) {
        try { process.kill(holder, 0); } catch (killError) {
          if ((killError as NodeJS.ErrnoException).code === "ESRCH") {
            rmSync(lock, { recursive: true, force: true });
            continue;
          }
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`${RUN_CURRENT_FILE} write lock stayed held by pid ${holder ?? "unknown"}: ${lock}`);
      }
      Atomics.wait(pause, 0, 0, 5);
    }
  }
  try {
    writeFileSync(join(lock, "pid"), String(process.pid), "utf8");
    return action();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function writeCurrentSync(runDirectory: string, current: Record<string, unknown>): void {
  const destination = runCurrentPath(runDirectory);
  const body = `${JSON.stringify(current, null, 2)}\n`;
  // Same-directory temp + rename: a concurrent reader (the analyst scans live
  // runs) never sees a torn file. A run directory that cannot take a new entry
  // (settlement after a chmod) still accepts an in-place overwrite of the
  // writable file, so that case degrades instead of failing.
  const temporary = join(runDirectory, `.${RUN_CURRENT_FILE}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, body, "utf8");
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM" && code !== "EROFS") throw error;
    writeFileSync(destination, body, "utf8");
  }
}

/** One section of `current.json`; undefined when the file or the section is absent. */
export function readSectionSync(
  runDirectory: string,
  section: CurrentSection,
): Record<string, unknown> | undefined {
  const value = readCurrentSync(runDirectory)?.[section];
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new TypeError(`${RUN_CURRENT_FILE} ${section} section is not an object: ${runCurrentPath(runDirectory)}`);
  }
  return value;
}

/** Replace one section, creating `current.json` when this is the first write. */
export function writeSectionSync(
  runDirectory: string,
  section: CurrentSection,
  value: Record<string, unknown>,
): void {
  withCurrentLock(runDirectory, () => {
    writeCurrentSync(runDirectory, { ...(readCurrentSync(runDirectory) ?? {}), [section]: value });
  });
}

/**
 * Let the caller keep its field rules for one existing section. `undefined`
 * means no change. A missing section is an error: admission writes it first.
 */
export function updateSectionSync(
  runDirectory: string,
  section: CurrentSection,
  update: (current: Record<string, unknown>) => Record<string, unknown> | undefined,
): void {
  withCurrentLock(runDirectory, () => {
    const whole = readCurrentSync(runDirectory);
    const current = whole?.[section];
    if (whole === undefined || !isRecord(current)) {
      throw new Error(`${RUN_CURRENT_FILE} has no ${section} section: ${runCurrentPath(runDirectory)}`);
    }
    const next = update(current);
    if (next === undefined) return;
    writeCurrentSync(runDirectory, { ...whole, [section]: next });
  });
}

/** Append one line to `history.jsonl`, creating the run directory when absent. */
export function appendHistoryRowSync(runDirectory: string, row: Record<string, unknown>): void {
  mkdirSync(runDirectory, { recursive: true });
  appendFileSync(join(runDirectory, RUN_HISTORY_FILE), `${JSON.stringify(row)}\n`, "utf8");
}

/**
 * Every line of `history.jsonl` in order; absent file → []. A damaged line
 * throws (failure honesty) — it is the only copy of that round.
 */
export function readHistoryRowsSync(runDirectory: string): readonly Record<string, unknown>[] {
  let raw: string;
  try {
    raw = readFileSync(join(runDirectory, RUN_HISTORY_FILE), "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
  const rows: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) throw new TypeError(`${RUN_HISTORY_FILE} line is not an object: ${join(runDirectory, RUN_HISTORY_FILE)}`);
    rows.push(parsed);
  }
  return rows;
}

/**
 * One `resume` line in history.jsonl, written when a resumed turn is about to
 * dispatch. `previous` is what the leg's terminal said before this turn
 * overwrites it (the only place that earlier outcome survives).
 */
export function appendResumeRowSync(runDirectory: string, cause: string | undefined): void {
  const terminal = readSectionSync(runDirectory, "terminal");
  const body = isRecord(terminal?.body) ? terminal.body : undefined;
  const outcome = isRecord(body?.outcome) ? body.outcome : undefined;
  const previous = terminal === undefined ? undefined : {
    face: terminal.face,
    ...(outcome?.kind !== undefined
      ? { kind: outcome.kind }
      : terminal.face === "error" ? { kind: "failure" } : {}),
    ...(outcome?.status === undefined ? {} : { status: outcome.status }),
    ...(body?.cause === undefined ? {} : { cause: body.cause }),
    ...(body?.diagnostic === undefined ? {} : { diagnostic: body.diagnostic }),
  };
  appendHistoryRowSync(runDirectory, {
    type: "resume",
    at: new Date().toISOString(),
    ...(cause === undefined ? {} : { cause }),
    ...(previous === undefined ? {} : { previous }),
  });
}
