/**
 * Package-owned durable record session (ADR 0065 / #1178).
 *
 * Same pi session JSONL v3 shape the rest of the package already writes and
 * reads (role-envelope header + custom entries; ledger-session-read). No
 * runtime import of the host coding-agent module — the public CLI and non-pi
 * executors must not depend on the host module tree for side-branch nests.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import type { HostRecordSession, RecordSessionHost } from "./host-contracts.ts";

const SESSION_VERSION = 3;

type SessionHeader = {
  readonly type: "session";
  readonly version: number;
  readonly id: string;
  readonly timestamp: string;
  readonly cwd: string;
  readonly parentSession?: string;
};

type SessionEntry = {
  readonly type: string;
  readonly id?: string;
  readonly customType?: string;
  readonly data?: unknown;
  readonly parentId?: string | null;
  readonly timestamp?: string;
};

function newSessionId(): string {
  return randomUUID();
}

function newEntryId(): string {
  return randomUUID();
}

function sessionFileName(header: SessionHeader): string {
  const fileTimestamp = header.timestamp.replace(/[:.]/g, "-");
  return `${fileTimestamp}_${header.id}.jsonl`;
}

function buildHeader(options: {
  readonly cwd: string;
  readonly parentSession?: string;
  readonly id?: string;
  readonly timestamp?: string;
}): SessionHeader {
  const header: SessionHeader = {
    type: "session",
    version: SESSION_VERSION,
    id: options.id ?? newSessionId(),
    timestamp: options.timestamp ?? new Date().toISOString(),
    cwd: resolve(options.cwd),
  };
  return options.parentSession === undefined
    ? header
    : { ...header, parentSession: options.parentSession };
}

function parseJsonl(filePath: string): SessionEntry[] {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, "utf8");
  const out: SessionEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed === "object" && parsed !== null) {
      out.push(parsed as SessionEntry);
    }
  }
  return out;
}

function headerFromEntries(entries: readonly SessionEntry[]): SessionHeader | null {
  const first = entries.find((entry) => entry.type === "session");
  if (first === undefined) return null;
  const raw = first as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  const cwd = raw.cwd;
  const parentSession = raw.parentSession;
  return {
    type: "session",
    version: typeof raw.version === "number" ? raw.version : SESSION_VERSION,
    id: raw.id,
    timestamp: typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
    cwd: typeof cwd === "string" ? cwd : "",
    ...(typeof parentSession === "string" ? { parentSession } : {}),
  };
}

/** Most recent .jsonl under sessionDir whose header cwd matches (when required). */
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
    const header = headerFromEntries(parseJsonl(filePath));
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

function createPackageRecordSession(options: {
  readonly cwd: string;
  readonly sessionDir: string;
  readonly sessionFile?: string;
  readonly parentSession?: string;
  readonly persist: boolean;
  readonly entries?: SessionEntry[];
}): HostRecordSession {
  const cwd = resolve(options.cwd);
  const sessionDir = options.sessionDir === "" ? "" : resolve(options.sessionDir);
  let header: SessionHeader | null;
  let entries: SessionEntry[];
  let sessionFile: string | undefined = options.sessionFile;
  let flushed = false;

  if (options.entries !== undefined && options.entries.length > 0) {
    entries = [...options.entries];
    header = headerFromEntries(entries);
    flushed = sessionFile !== undefined && existsSync(sessionFile);
  } else if (sessionFile !== undefined && existsSync(sessionFile)) {
    entries = parseJsonl(sessionFile);
    header = headerFromEntries(entries);
    flushed = true;
  } else {
    header = buildHeader({
      cwd,
      ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
    });
    entries = [header];
    if (options.persist && sessionDir !== "") {
      mkdirSync(sessionDir, { recursive: true });
      sessionFile = sessionFile ?? join(sessionDir, sessionFileName(header));
      // Materialize immediately — package writers do not defer until a conversation turn.
      if (!existsSync(sessionFile)) {
        writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, { flag: "wx" });
      }
      flushed = true;
    }
  }

  const leafId = (): string | null => {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i]!;
      if (entry.type === "session") continue;
      if (typeof entry.id === "string") return entry.id;
    }
    return null;
  };

  const persistEntry = (entry: SessionEntry): void => {
    if (!options.persist || sessionFile === undefined) return;
    if (!flushed) {
      writeFileSync(
        sessionFile,
        `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`,
        { flag: "wx" },
      );
      flushed = true;
      return;
    }
    appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`, "utf8");
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
        entries = parseJsonl(resolved);
        header = headerFromEntries(entries);
        flushed = true;
        return;
      }
      if (header === null) {
        header = buildHeader({ cwd });
        entries = [header];
      }
      flushed = false;
    },
    appendCustomEntry(customType: string, data?: unknown) {
      const entry: SessionEntry = {
        type: "custom",
        customType,
        ...(data === undefined ? {} : { data }),
        id: newEntryId(),
        parentId: leafId(),
        timestamp: new Date().toISOString(),
      };
      entries.push(entry);
      persistEntry(entry);
      return entry.id;
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
