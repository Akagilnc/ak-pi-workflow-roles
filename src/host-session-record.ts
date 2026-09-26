/**
 * Host conversation dossiers are native file copies; sitian append-only (ADR 0086).
 * Replaces live event streaming (ADR 0077) with post-exit CLI original copy.
 * Writes native-session-pointer when session ID is obtained.
 * Writes native-session-copy (or native-session-warning on retry failure) after CLI exit.
 * Log line write failures declare to stderr and never abort the leg.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  closeSync,
  existsSync,
  openSync,
  mkdirSync,
  readdirSync,
  statSync,
  type Dirent,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { RoleTurnContinuation } from "./host-contracts.ts";
import { sitianReport } from "./sitian-facade.ts";
import type { SitianRecordInput } from "./sitian-contracts.ts";

/** Volume category under `<run>/session/<kind>/records.jsonl`. */
export const HOST_SESSION_RECORD_KIND = "host-session" as const;

/** Declare sitian record failure once to stderr without aborting the leg (ADR 0086). */
export function sitianReportSafe(input: SitianRecordInput): void {
  try {
    sitianReport(input);
  } catch (error) {
    const message = error instanceof Error ? (error.stack || error.message) : String(error);
    process.stderr.write(`[host-session] Sitian record write failure: ${message}\n`);
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
    const codexHome = process.env.CODEX_HOME || join(home, ".codex");
    const sessionsDir = join(codexHome, "sessions");
    const existing = findCodexRollout(sessionsDir, options.sessionId);
    return existing ?? join(sessionsDir, `rollout-${options.sessionId}.jsonl`);
  }
  if (options.host === "grok-build") {
    const grokHome = process.env.GROK_HOME || join(home, ".grok");
    return join(grokHome, "sessions", encodeURIComponent(options.cwd), options.sessionId);
  }
  return undefined;
}

/**
 * Resolve the host dossier landing destination under `<run>/session/`.
 * Format: `<run>/session/<host>-<model>-<n>` (single file adds .jsonl; model slashes replaced with -).
 * Ordinal n is the start/resume count in the run (initial 1, each resume +1).
 */
export function resolveHostDossierLandingPath(options: {
  readonly host: string;
  readonly model?: { readonly model?: string; readonly thinking?: string } | undefined;
  readonly sessionDirectory: string;
  readonly continuation: RoleTurnContinuation;
}): { readonly landingPath: string; readonly ordinal: number; readonly sanitizedModel: string } {
  const sanitizedModel = (options.model?.model ?? "default").replace(/[\/\\]+/g, "-");
  let maxOrdinal = 0;

  if (existsSync(options.sessionDirectory)) {
    try {
      const entries = readdirSync(options.sessionDirectory);
      for (const entry of entries) {
        const match = entry.match(/-(\d+)(?:\.jsonl)?$/);
        const first = match?.[1];
        if (first !== undefined) {
          const val = parseInt(first, 10);
          if (!isNaN(val) && val > maxOrdinal) {
            maxOrdinal = val;
          }
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }

  const ordinal = maxOrdinal > 0
    ? maxOrdinal + 1
    : options.continuation.kind === "resume"
      ? 2
      : 1;

  const baseName = `${options.host}-${sanitizedModel}-${ordinal}`;
  const landingPath = options.host === "grok-build"
    ? join(options.sessionDirectory, baseName)
    : join(options.sessionDirectory, `${baseName}.jsonl`);

  return { landingPath, ordinal, sanitizedModel };
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
  const nativePath = resolveNativeSessionPath(options);
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
 * Copy native host session original to run session dossier after child process exits.
 * If copy fails, retries once.
 * On success, appends native-session-copy line to Sitian.
 * On repeated failure, appends native-session-warning line to Sitian.
 * Does not throw; turn outcome is never altered by copy success or failure.
 */
export function copyAndRecordHostDossier(options: {
  readonly host: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly sessionDirectory: string;
  readonly sessionParent: string;
  readonly continuation: RoleTurnContinuation;
  readonly model?: { readonly model?: string; readonly thinking?: string } | undefined;
  readonly home?: string | undefined;
}): void {
  if (options.host === "pi" || options.host === "hermes") {
    return;
  }
  const nativePath = resolveNativeSessionPath({
    host: options.host,
    sessionId: options.sessionId,
    cwd: options.cwd,
    ...(options.home !== undefined ? { home: options.home } : {}),
  });
  if (nativePath === undefined) return;

  const { landingPath, ordinal } = resolveHostDossierLandingPath(options);

  let lastError: unknown;
  let copySuccess = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (options.host === "grok-build") {
        copyGrokDossier(nativePath, landingPath);
      } else {
        if (!existsSync(nativePath)) {
          throw new Error(`Native session file missing at ${nativePath}`);
        }
        mkdirSync(dirname(landingPath), { recursive: true });
        copyFileCloneOrFallback(nativePath, landingPath);
      }
      copySuccess = true;
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (copySuccess) {
    sitianReportSafe({
      level: "event",
      kind: HOST_SESSION_RECORD_KIND,
      host: options.host,
      cwd: options.cwd,
      sessionParent: options.sessionParent,
      source: `${options.host}-dossier`,
      payload: {
        type: "native-session-copy",
        nativePath,
        landingPath,
        ordinal,
        sessionId: options.sessionId,
      },
    });
  } else {
    // Reserve the failed attempt's ordinal for a later resume without reading the log.
    try {
      if (options.host === "grok-build") {
        mkdirSync(landingPath, { recursive: true });
      } else {
        mkdirSync(dirname(landingPath), { recursive: true });
        closeSync(openSync(landingPath, "a"));
      }
    } catch { /* the warning below retains the original copy failure */ }
    sitianReportSafe({
      level: "event",
      kind: HOST_SESSION_RECORD_KIND,
      host: options.host,
      cwd: options.cwd,
      sessionParent: options.sessionParent,
      source: `${options.host}-dossier`,
      payload: {
        type: "native-session-warning",
        nativePath,
        landingPath,
        ordinal,
        sessionId: options.sessionId,
        error: lastError instanceof Error ? lastError.message : String(lastError),
      },
    });
  }
}
