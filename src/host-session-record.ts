/**
 * Host conversation dossiers are native file copies; sitian append-only (ADR 0086).
 * Replaces live event streaming (ADR 0077) with post-exit CLI original copy.
 * Writes native-session-pointer when session ID is obtained.
 * Writes native-session-copy (or native-session-warning on retry failure) after CLI exit.
 * Log line write failures declare to stderr and never abort the leg.
 */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  type Dirent,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { sitianReport } from "./sitian-facade.ts";
import type { SitianRecordInput } from "./sitian-contracts.ts";

import { errorText, isEnoent } from "./unknown-value.ts";

/** Volume category under `<run>/session/<kind>/records.jsonl`. */
export const HOST_SESSION_RECORD_KIND = "host-session" as const;

function declareHostSessionFailure(error: unknown): void {
  const message = error instanceof Error ? (error.stack || error.message) : String(error);
  process.stderr.write(`[host-session] Dossier record failure: ${message}\n`);
}

/** Declare sitian record failure once to stderr without aborting the leg (ADR 0086). */
export function sitianReportSafe(input: SitianRecordInput): void {
  try {
    sitianReport(input);
  } catch (error) {
    declareHostSessionFailure(error);
  }
}

/** Recursively scan for Codex rollout file matching sessionId under sessionsDir. */
function findCodexRollout(sessionsDir: string, sessionId: string): string | undefined {
  // Direct readdir: only ENOENT is absence. EACCES/EPERM keep their cause (#1161 C3-io).
  const matches: Array<{ path: string; mtime: number }> = [];
  function scan(dir: string, depth = 0): void {
    if (depth > 6) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(sessionId)) {
        try {
          const stat = statSync(fullPath);
          matches.push({ path: fullPath, mtime: stat.mtimeMs });
        } catch {
          // mtime optional for ranking; path itself is still a candidate.
          matches.push({ path: fullPath, mtime: 0 });
        }
      }
    }
  }
  try {
    scan(sessionsDir);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
  if (matches.length === 0 || matches[0] === undefined) return undefined;
  matches.sort((a, b) => b.mtime - a.mtime);
  return matches[0]?.path;
}

/**
 * Sanitize working directory to match Claude Code's project directory name layout.
 * Claude Code replaces all non-alphanumeric characters (slashes, dots, underscores, spaces, etc.) with '-'.
 */
export function sanitizeClaudeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Resolve the CLI native session original path.
 * Codex: single file rollout from ~/.codex/sessions/** /rollout-*-${sessionId}.jsonl
 * Claude: single file transcript from ~/.claude/projects/<sanitized-cwd>/${sessionId}.jsonl
 * Grok: directory ~/.grok/sessions/<encoded-cwd>/${sessionId}
 * Pi / Hermes: undefined (Pi directly lands in session.jsonl; Hermes is state.db excluded from ADR 0086)
 */
export function resolveNativeSessionPath(options: {
  readonly host: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly home?: string | undefined;
}): string | undefined {
  const home = options.home || homedir();
  if (options.host === "claude") {
    const configDir = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
    const sanitizedCwd = sanitizeClaudeCwd(options.cwd);
    return join(configDir, "projects", sanitizedCwd, `${options.sessionId}.jsonl`);
  }
  if (options.host === "codex") {
    return findCodexRollout(codexSessionsDirectory(home), options.sessionId);
  }
  if (options.host === "grok-build") {
    const grokHome = process.env.GROK_HOME || join(home, ".grok");
    return join(grokHome, "sessions", encodeURIComponent(options.cwd), options.sessionId);
  }
  return undefined;
}

function codexSessionsDirectory(home?: string): string {
  return join(process.env.CODEX_HOME || join(home || homedir(), ".codex"), "sessions");
}

/**
 * Host original landing under `<run>/session/`: one file per host, never
 * numbered — every exit overwrites the same name (#1161).
 * codex / claude: `<host>.jsonl`; grok-build: directory `<host>`.
 */
export function resolveHostDossierLandingPath(options: {
  readonly host: string;
  readonly sessionDirectory: string;
}): string {
  return options.host === "grok-build"
    ? join(options.sessionDirectory, options.host)
    : join(options.sessionDirectory, `${options.host}.jsonl`);
}

/** Record native session pointer line to Sitian as soon as session ID is known. */
export function recordNativeSessionPointer(options: {
  readonly host: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly sessionParent: string;
  readonly home?: string | undefined;
}): string | undefined {
  if (options.host === "pi" || options.host === "hermes") {
    return undefined;
  }
  const nativePath = options.host === "codex"
    ? codexSessionsDirectory(options.home)
    : resolveNativeSessionPath(options);
  if (nativePath === undefined) return undefined;

  sitianReportSafe({
    level: "event",
    kind: HOST_SESSION_RECORD_KIND,
    host: options.host,
    cwd: options.cwd,
    sessionParent: options.sessionParent,
    source: `${options.host}-dossier`,
    payload: {
      type: "native-session-pointer",
      nativePath,
      sessionId: options.sessionId,
    },
  });
  return nativePath;
}

/** File clone via APFS `cp -c` with fallback to `copyFileSync`. */
function copyFileCloneOrFallback(src: string, dest: string): void {
  try {
    const res = spawnSync("cp", ["-c", src, dest]);
    if (res.status === 0) return;
  } catch {
    // cp execution failed, fall back
  }
  copyFileSync(src, dest);
}

/**
 * Copy both grok-build originals: chat_history.jsonl and usage.json into destDir.
 * Direct copy — no existsSync/access preflight. Real ENOENT/EACCES surface from
 * the copy itself (Node fs: do not exists/access before open — #1161 C3-io).
 */
function copyGrokDossier(srcDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  copyFileCloneOrFallback(join(srcDir, "chat_history.jsonl"), join(destDir, "chat_history.jsonl"));
  copyFileCloneOrFallback(join(srcDir, "usage.json"), join(destDir, "usage.json"));
}

/**
 * Copy the native host session original over the run's single landing path
 * after the child process exits. Copies beside the landing path and swaps in
 * on success, so a failed copy never destroys the previous good original.
 * Retries once. Success appends a native-session-copy line, repeated failure a
 * native-session-warning line. Does not throw; the turn outcome is never
 * altered by copy success or failure.
 */
export function copyAndRecordHostDossier(options: {
  readonly host: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly sessionDirectory: string;
  readonly sessionParent: string;
  readonly home?: string | undefined;
}): void {
  if (options.host === "hermes") {
    return;
  }
  const report = (payload: Record<string, unknown>): void => sitianReportSafe({
    level: "event",
    kind: HOST_SESSION_RECORD_KIND,
    host: options.host,
    cwd: options.cwd,
    sessionParent: options.sessionParent,
    source: `${options.host}-dossier`,
    payload,
  });
  // Pi already lands at session/session.jsonl; record that landing through the
  // same native-session-copy row current.json projects — no copy, no second
  // original parser.
  if (options.host === "pi") {
    report({
      type: "native-session-copy",
      nativePath: options.sessionParent,
      landingPath: options.sessionParent,
      sessionId: options.sessionId,
    });
    return;
  }
  const nativePath = resolveNativeSessionPath({
    host: options.host,
    sessionId: options.sessionId,
    cwd: options.cwd,
    ...(options.home !== undefined ? { home: options.home } : {}),
  });
  if (nativePath === undefined && options.host !== "codex") return;

  const landingPath = resolveHostDossierLandingPath(options);
  // Per-attempt staging/previous names: concurrent copies of the same landing
  // must not share one `.copying` / `.previous` path (#1161 C2). Node's fs
  // copy is not atomic; unique sibling + rename is the smallest ownership fix.
  // Swap-failure restores that attempt's own `.previous.<token>` inline — no
  // next-call orphan scan (J6: do not invent a second recovery mechanism).

  let lastError: unknown;
  let copySuccess = false;
  let stagingForCleanup: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const attemptToken = randomBytes(6).toString("hex");
    const staging = `${landingPath}.copying.${attemptToken}`;
    stagingForCleanup = staging;
    try {
      if (options.host === "grok-build") {
        copyGrokDossier(nativePath!, staging);
      } else {
        // Undefined path = discovery found nothing (true absence). Present path:
        // copy directly so EACCES/EPERM keep their cause — no existsSync wash.
        if (nativePath === undefined) {
          throw new Error(`Native session file missing for ${options.host} session ${options.sessionId}`);
        }
        mkdirSync(dirname(landingPath), { recursive: true });
        copyFileCloneOrFallback(nativePath, staging);
      }
      if (options.host === "grok-build") {
        // A directory cannot be renamed over: park the previous original aside,
        // move the new one in, and put the old one back only if the landing is
        // still absent. This attempt owns its `.previous.<token>` through
        // success or failure — restore-if-absent, then clear the token when it
        // is no longer the unique original (peer may have published landing).
        // Never delete previous when restore failed and landing is still absent.
        // Cleanup failure must not wash into native-session-copy success
        // (#1161 C2 / 失败诚实). No orphan scan, no cross-call recovery, no queue.
        const previous = `${landingPath}.previous.${attemptToken}`;
        const hadPrevious = existsSync(landingPath);
        let parked = false;
        let keepUniquePrevious = false;
        let cleanupError: unknown;
        let swapFailure: unknown;
        let restoreError: unknown;
        try {
          if (hadPrevious) {
            renameSync(landingPath, previous);
            parked = true;
          }
          try {
            renameSync(staging, landingPath);
          } catch (swapError) {
            if (parked && existsSync(previous) && !existsSync(landingPath)) {
              try {
                renameSync(previous, landingPath);
              } catch (error) {
                restoreError = error;
                // Restore failed; previous may still be the only old original.
                if (existsSync(previous) && !existsSync(landingPath)) {
                  keepUniquePrevious = true;
                }
              }
            }
            swapFailure = swapError;
          }
        } finally {
          if (parked && existsSync(previous) && !keepUniquePrevious) {
            try {
              rmSync(previous, { recursive: true, force: true });
            } catch (error) {
              cleanupError = error;
            }
          }
        }
        if (swapFailure !== undefined) {
          // Keep every residual cause; previous cleanup names its path explicitly
          // (Node errno usually embeds path — still pass residual so AggregateError
          // never silently omits which leftover remains; #1161 C2).
          lastError = combineCopyFailureCauses(
            swapFailure,
            restoreError,
            cleanupError,
            cleanupError === undefined ? undefined : previous,
          );
          // Ordinary swap fail with restore+cleanup success → ADR 0086 retry once.
          // Restore or cleanup incomplete → keep residual paths; do not retry
          // (retry would re-park / wash residual-previous causes).
          if (restoreError !== undefined || cleanupError !== undefined) {
            break;
          }
          try {
            rmSync(staging, { recursive: true, force: true });
            stagingForCleanup = undefined;
          } catch (stagingCleanupError) {
            lastError = combineCopyFailureCauses(
              swapFailure,
              undefined,
              stagingCleanupError,
              staging,
            );
            // Residual already recorded; clear so the final pass does not re-rm / duplicate.
            stagingForCleanup = undefined;
            break;
          }
          continue;
        }
        if (cleanupError !== undefined) {
          // Swap landed but cleanup ownership is incomplete — leave the true
          // cause with residual previous path; do not retry or claim copy.
          lastError = combineCopyFailureCauses(cleanupError, undefined, cleanupError, previous);
          stagingForCleanup = undefined;
          break;
        }
      } else {
        renameSync(staging, landingPath); // atomically replaces the previous file
      }
      copySuccess = true;
      stagingForCleanup = undefined;
      break;
    } catch (error) {
      lastError = error;
      try {
        rmSync(staging, { recursive: true, force: true });
        stagingForCleanup = undefined;
      } catch (cleanupError) {
        lastError = combineCopyFailureCauses(error, undefined, cleanupError, staging);
        // Residual already recorded; clear so the final pass does not re-rm / duplicate.
        stagingForCleanup = undefined;
        break;
      }
    }
  }

  if (copySuccess) {
    report({ type: "native-session-copy", nativePath, landingPath, sessionId: options.sessionId });
  } else {
    // A partial attempt must not masquerade as a complete native original.
    if (stagingForCleanup !== undefined) {
      try {
        rmSync(stagingForCleanup, { recursive: true, force: true });
      } catch (cleanupError) {
        lastError = combineCopyFailureCauses(lastError, undefined, cleanupError, stagingForCleanup);
      }
    }
    report({
      type: "native-session-warning",
      nativePath,
      landingPath,
      sessionId: options.sessionId,
      error: errorText(lastError),
    });
  }
}

/** Fold swap / restore / staging-or-previous cleanup causes without washing any. */
function combineCopyFailureCauses(
  primary: unknown,
  restoreError: unknown,
  cleanupError: unknown,
  residualPath?: string,
): unknown {
  const errors: unknown[] = [primary];
  const parts = [errorText(primary)];
  if (restoreError !== undefined) {
    errors.push(restoreError);
    parts.push(`restore failed: ${errorText(restoreError)}`);
  }
  if (cleanupError !== undefined) {
    if (cleanupError !== primary) errors.push(cleanupError);
    parts.push(
      residualPath === undefined
        ? `cleanup failed: ${errorText(cleanupError)}`
        : `cleanup failed: ${errorText(cleanupError)} (residual: ${residualPath})`,
    );
  }
  if (errors.length === 1 && parts.length === 1) return primary;
  return new AggregateError(errors, parts.join("; "), { cause: primary });
}
