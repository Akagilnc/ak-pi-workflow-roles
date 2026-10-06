/**
 * Package-owned durable record session (ADR 0065 / #1178).
 *
 * Same pi session JSONL v3 shape the rest of the package already writes and
 * reads (role-envelope header + custom entries; ledger-session-read open load).
 * No runtime import of the host coding-agent module — the public CLI and non-pi
 * executors must not depend on the host module tree for side-branch nests.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import type { HostRecordSession, RecordSessionHost } from "./host-contracts.ts";
import {
  loadPiSessionFileForOpen,
  readPiSessionHeaderForDiscovery,
  type LedgerSessionRow,
} from "./ledger-session-read.ts";
import {
  buildPiSessionHeader,
  completePiSessionEntryFields,
  formatPiSessionJsonlLine,
  type PiSessionHeader,
} from "./ledger-session-write.ts";

type SessionEntry = {
  readonly type: string;
  readonly id?: string;
  readonly customType?: string;
  readonly data?: unknown;
  readonly parentId?: string | null;
  readonly timestamp?: string;
};

function sessionFileName(header: PiSessionHeader): string {
  const fileTimestamp = header.timestamp.replace(/[:.]/g, "-");
  return `${fileTimestamp}_${header.id}.jsonl`;
}

function headerForCreate(options: {
  readonly cwd: string;
  readonly parentSession?: string;
}): PiSessionHeader {
  return buildPiSessionHeader({
    id: randomUUID(),
    cwd: resolve(options.cwd),
    ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
  });
}

function headerFromEntries(entries: readonly SessionEntry[]): PiSessionHeader | null {
  // Open load already requires entries[0] to be a session header; mirror that position
  // (SessionManager uses the first entry, not a later type==="session" find).
  const first = entries[0];
  if (first === undefined || first.type !== "session") return null;
  const raw = first as Record<string, unknown>;
  // Match loadEntriesFromFile: id must be a string; empty string is accepted.
  if (typeof raw.id !== "string") return null;
  const cwd = typeof raw.cwd === "string" ? raw.cwd : "";
  return buildPiSessionHeader({
    id: raw.id,
    cwd,
    timestamp: typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
    ...(typeof raw.parentSession === "string" ? { parentSession: raw.parentSession } : {}),
  });
}

function entriesFromRows(rows: readonly LedgerSessionRow[]): SessionEntry[] {
  return rows.map((row) => row as SessionEntry);
}

/**
 * Most recent .jsonl under sessionDir whose header cwd matches (when required).
 * Discovery is best-effort: unreadable or non-session candidates are skipped so
 * one bad peer cannot block a usable continue (SessionManager findMostRecentSession).
 */
function findMostRecentSessionFile(
  sessionDir: string,
  cwd: string | undefined,
): string | undefined {
  let names: string[];
  try {
    names = readdirSync(sessionDir);
  } catch {
    return undefined;
  }
  const absoluteCwd = cwd === undefined ? undefined : resolve(cwd);
  const matched: { path: string; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const filePath = join(sessionDir, name);
    let st;
    try {
      st = statSync(filePath);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const header = readPiSessionHeaderForDiscovery(filePath);
    if (header === null) continue;
    if (absoluteCwd !== undefined) {
      if (typeof header.cwd !== "string" || header.cwd.length === 0) continue;
      if (resolve(header.cwd) !== absoluteCwd) continue;
    }
    matched.push({ path: filePath, mtimeMs: st.mtimeMs });
  }
  if (matched.length === 0) return undefined;
  matched.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matched[0]!.path;
}

function loadOrInitPersistedFile(options: {
  readonly cwd: string;
  readonly sessionFile: string;
  readonly parentSession?: string;
}): { header: PiSessionHeader; entries: SessionEntry[] } {
  if (!existsSync(options.sessionFile)) {
    const header = headerForCreate({
      cwd: options.cwd,
      ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
    });
    return { header, entries: [header] };
  }

  const loaded = loadPiSessionFileForOpen(options.sessionFile);
  if (loaded.length === 0) {
    // Empty file: initialize session header in place (SessionManager open contract).
    const header = headerForCreate({
      cwd: options.cwd,
      ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
    });
    writeFileSync(options.sessionFile, formatPiSessionJsonlLine(header), "utf8");
    return { header, entries: [header] };
  }

  const entries = entriesFromRows(loaded);
  const header = headerFromEntries(entries);
  if (header === null) {
    throw new Error(`Session file is not a valid pi session: ${options.sessionFile}`);
  }
  return { header, entries };
}

function createPackageRecordSession(options: {
  readonly cwd: string;
  readonly sessionDir: string;
  readonly sessionFile?: string;
  readonly parentSession?: string;
  readonly persist: boolean;
}): HostRecordSession {
  const cwd = resolve(options.cwd);
  const sessionDir = options.sessionDir === "" ? "" : resolve(options.sessionDir);
  let header: PiSessionHeader | null;
  let entries: SessionEntry[];
  let sessionFile: string | undefined = options.sessionFile;

  if (options.persist && sessionFile !== undefined) {
    const loaded = loadOrInitPersistedFile({
      cwd,
      sessionFile: resolve(sessionFile),
      ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
    });
    header = loaded.header;
    entries = loaded.entries;
    sessionFile = resolve(sessionFile);
  } else if (options.persist && sessionDir !== "") {
    mkdirSync(sessionDir, { recursive: true });
    header = headerForCreate({
      cwd,
      ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
    });
    entries = [header];
    sessionFile = join(sessionDir, sessionFileName(header));
    // Materialize immediately — package writers do not defer until a conversation turn.
    writeFileSync(sessionFile, formatPiSessionJsonlLine(header), { flag: "wx" });
  } else {
    header = headerForCreate({
      cwd,
      ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
    });
    entries = [header];
  }

  const leafId = (): string | null => {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i]!;
      if (entry.type === "session") continue;
      if (typeof entry.id === "string") return entry.id;
    }
    return null;
  };

  return {
    getSessionFile() {
      return sessionFile;
    },
    getSessionDir() {
      return sessionDir;
    },
    getHeader() {
      return header;
    },
    getEntries() {
      return entries.filter((entry) => entry.type !== "session");
    },
    isPersisted() {
      return options.persist;
    },
    setSessionFile(path: string) {
      const resolved = resolve(path);
      sessionFile = resolved;
      if (existsSync(resolved)) {
        const loaded = loadOrInitPersistedFile({ cwd, sessionFile: resolved });
        header = loaded.header;
        entries = loaded.entries;
        return;
      }
      if (header === null) {
        header = headerForCreate({ cwd });
        entries = [header];
      }
    },
    appendCustomEntry(customType: string, data?: unknown) {
      // Memory keeps the original data reference (no JSON round-trip). id/timestamp
      // fill stays sole-owned by ledger-session-write; disk encoding only when persist.
      const entry = completePiSessionEntryFields({
        type: "custom",
        customType,
        ...(data === undefined ? {} : { data }),
        parentId: leafId(),
      }) as SessionEntry;
      entries.push(entry);
      if (options.persist && sessionFile !== undefined) {
        // Open/create always leave a trailing newline (or repair on load), so append
        // keeps JSONL line boundaries without a deferred full rewrite path.
        appendFileSync(sessionFile, formatPiSessionJsonlLine(entry as Record<string, unknown>), "utf8");
      }
      return entry.id!;
    },
  };
}

/** Default RecordSessionHost for the sole archivist entry — no pi runtime import. */
export const packageRecordSessionHost: RecordSessionHost = {
  openRecordSession({ sessionFile, sessionDir, cwd }) {
    return createPackageRecordSession({
      cwd,
      sessionDir,
      sessionFile: resolve(sessionFile),
      persist: true,
    });
  },
  createRecordSession({ cwd, sessionDir, parentSession }) {
    return createPackageRecordSession({
      cwd,
      sessionDir,
      ...(parentSession === undefined ? {} : { parentSession }),
      persist: true,
    });
  },
  continueRecentRecordSession({ cwd, sessionDir }) {
    const recent = findMostRecentSessionFile(sessionDir, cwd);
    if (recent !== undefined) {
      return {
        session: createPackageRecordSession({
          cwd,
          sessionDir,
          sessionFile: recent,
          persist: true,
        }),
        resumed: true,
      };
    }
    // Miss: do not materialize. Archivist discards this session and mints a fresh
    // parented principal; writing here would leave an unparented orphan header.
    return {
      session: createPackageRecordSession({
        cwd,
        sessionDir: "",
        persist: false,
      }),
      resumed: false,
    };
  },
  inMemoryRecordSession(cwd) {
    return createPackageRecordSession({
      cwd,
      sessionDir: "",
      persist: false,
    });
  },
};
