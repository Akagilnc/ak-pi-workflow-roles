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

import { errorText } from "./unknown-value.ts";

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
  if (!existsSync(sessionsDir)) return undefined;
  const matches: Array<{ path: string; mtime: number }> = [];
  function scan(dir: string, depth = 0): void {
    if (depth > 6) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
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
          matches.push({ path: fullPath, mtime: 0 });
        }
      }
    }
  }
  scan(sessionsDir);
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

/** Copy both grok-build originals: chat_history.jsonl and usage.json into destDir. */
function copyGrokDossier(srcDir: string, destDir: string): void {
  const chatHistorySrc = join(srcDir, "chat_history.jsonl");
  if (!existsSync(chatHistorySrc)) {
    throw new Error(`Grok native chat_history.jsonl missing at ${chatHistorySrc}`);
  }
  mkdirSync(destDir, { recursive: true });
  const chatHistoryDest = join(destDir, "chat_history.jsonl");
  copyFileCloneOrFallback(chatHistorySrc, chatHistoryDest);

  const usageSrc = join(srcDir, "usage.json");
  if (!existsSync(usageSrc)) {
    throw new Error(`Grok native usage.json missing at ${usageSrc}`);
  }
  copyFileCloneOrFallback(usageSrc, join(destDir, "usage.json"));
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
        if (nativePath === undefined || !existsSync(nativePath)) {
          throw new Error(`Native session file missing for ${options.host} session ${options.sessionId}`);
        }
        mkdirSync(dirname(landingPath), { recursive: true });
        copyFileCloneOrFallback(nativePath, staging);
      }
      if (options.host === "grok-build") {
        // A directory cannot be renamed over: park the previous original aside,
        // move the new one in, and put the old one back only if the landing is
        // still absent. This attempt owns its `.previous.<token>` through
        // success or failure — restore-if-absent, then always clear the token
        // if it remains (a peer may have published the landing meanwhile).
        // No orphan scan, no cross-call recovery, no queue (#1161 C2).
        const previous = `${landingPath}.previous.${attemptToken}`;
        const hadPrevious = existsSync(landingPath);
        let parked = false;
        try {
          if (hadPrevious) {
            renameSync(landingPath, previous);
            parked = true;
          }
          try {
            renameSync(staging, landingPath);
          } catch (swapError) {
            if (parked && existsSync(previous) && !existsSync(landingPath)) {
              renameSync(previous, landingPath);
            }
            throw swapError;
          }
        } finally {
          if (parked && existsSync(previous)) {
            try { rmSync(previous, { recursive: true, force: true }); }
            catch { /* warning below reports the original copy failure */ }
          }
        }
      } else {
        renameSync(staging, landingPath); // atomically replaces the previous file
      }
      copySuccess = true;
      stagingForCleanup = undefined;
      break;
    } catch (error) {
      lastError = error;
      try { rmSync(staging, { recursive: true, force: true }); }
      catch { /* retry or warning below */ }
    }
  }

  if (copySuccess) {
    report({ type: "native-session-copy", nativePath, landingPath, sessionId: options.sessionId });
  } else {
    // A partial attempt must not masquerade as a complete native original.
    if (stagingForCleanup !== undefined) {
      try { rmSync(stagingForCleanup, { recursive: true, force: true }); }
      catch { /* warning below reports the original copy failure */ }
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
