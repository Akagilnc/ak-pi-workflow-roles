/**
 * #1064 — public read-only single-run view: `ak-role run show <run-dir>`.
 *
 * Replaces the repeatedly hand-written ledger heredoc reads with one terminal
 * command printing the five readable fact kinds for one existing run:
 * last verdict payload, seal records, host thread id, compaction count, and
 * token usage. Missing materials print as unavailable — never an index error
 * in place of a result (issue #1064). Zero writes: the command never touches
 * the ledger, never starts or resumes a role, and never creates a run.
 *
 * Carriers (ADR 0049 run volume is the truth; ADR 0077 host-native volumes
 * stay in the operator host home):
 * - verdict payload: `<run>/artifacts/report.json` → `outcome.payloads` last
 * - seal records: `<run>/session/submission-ledger/records.jsonl` `sealed` rows
 * - host thread id: run session binding files (host description table) +
 *   codex `thread.started` host-session rows + pi session volume header
 * - compaction count: codex rollout `compacted` rows (via thread id under the
 *   operator codex sessions root) | claude `compact_boundary` host-session rows
 *   | pi session volume `compaction` rows
 * - token usage: codex rollout last `token_count` info, else last host-session
 *   `turn.completed.usage` | claude host-session last `result` usage | pi
 *   session volume summed assistant usage (`session-assistant-usage`)
 *
 * Missing carriers and damaged JSONL lines print as unavailable — never a
 * known-zero count or a silent partial list (#1064 / failure-honesty).
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { errnoCode, packageMachineHome } from "../activation-ledger-topology.ts";
import {
  HEADLESS_HOST_DESCRIPTIONS,
  HOST_DESCRIPTIONS,
} from "../host-descriptions.ts";
import { readAssistantUsageFromSessionFile } from "../session-assistant-usage.ts";
import { codexSessionsRoot } from "../ticket-provenance.ts";
import { CliUsageError } from "./cli-errors.ts";
import type { CliIo } from "./cli-io.ts";
import { presentStructuralRejection } from "./settlement.ts";

const REPORT_PATH = "artifacts/report.json";
const SUBMISSION_LEDGER_PATH = "session/submission-ledger/records.jsonl";
const HOST_SESSION_RECORDS_PATH = "session/host-session/records.jsonl";
const SESSION_VOLUME_PATH = "session/session.jsonl";

export type RunShowMachineHomeEnv = {
  /** Operator machine home (codex sessions root); defaults to the passwd home. */
  readonly machineHome?: string;
};

export type RunShowUnavailable = { readonly unavailable: string };

export type RunShowFacts = {
  readonly runDirectory: string;
  readonly lastVerdictPayload:
    | { readonly payload: unknown; readonly source: string }
    | RunShowUnavailable;
  readonly sealRecords:
    | {
        readonly records: readonly {
          readonly timestamp?: string;
          readonly payload: unknown;
        }[];
        readonly source: string;
      }
    | RunShowUnavailable;
  readonly hostThreadIds:
    | { readonly ids: readonly { readonly id: string; readonly source: string }[] }
    | RunShowUnavailable;
  readonly compactionCount:
    | { readonly count: number; readonly source: string }
    | RunShowUnavailable;
  readonly tokenUsage:
    | { readonly usage: unknown; readonly source: string }
    | RunShowUnavailable;
};

function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** ENOENT → null (material missing); any other read failure propagates. */
async function readUtf8OrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

/**
 * Parse NDJSON rows. Damaged lines are counted, not silently dropped — a view
 * must not crash, but must also not present a partial parse as complete.
 */
function parseJsonlRows(text: string): {
  readonly rows: readonly unknown[];
  readonly damagedLineCount: number;
} {
  const rows: unknown[] = [];
  let damagedLineCount = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      damagedLineCount += 1;
    }
  }
  return { rows, damagedLineCount };
}

/** Session binding files from the sole host description tables (no parallel list). */
function hostSessionBindingFiles(): readonly { host: string; file: string }[] {
  const out: { host: string; file: string }[] = [];
  for (const [host, description] of Object.entries(HOST_DESCRIPTIONS)) {
    out.push({ host, file: description.sessionBindingFile });
  }
  for (const [host, description] of Object.entries(HEADLESS_HOST_DESCRIPTIONS)) {
    out.push({ host, file: description.sessionBindingFile });
  }
  return out;
}

async function readLastVerdictPayload(
  runDirectory: string,
): Promise<RunShowFacts["lastVerdictPayload"]> {
  const text = await readUtf8OrNull(join(runDirectory, REPORT_PATH));
  if (text === null) return { unavailable: `${REPORT_PATH} is missing` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { unavailable: `${REPORT_PATH} is not valid JSON` };
  }
  const outcome = isPlainObject(parsed) ? parsed.outcome : undefined;
  const payloads = isPlainObject(outcome) ? outcome.payloads : undefined;
  if (!Array.isArray(payloads)) {
    return { unavailable: `${REPORT_PATH} carries no outcome.payloads array` };
  }
  if (payloads.length === 0) {
    return { unavailable: `${REPORT_PATH} outcome.payloads is empty` };
  }
  return { payload: payloads[payloads.length - 1], source: REPORT_PATH };
}

async function readSealRecords(
  runDirectory: string,
): Promise<RunShowFacts["sealRecords"]> {
  const text = await readUtf8OrNull(join(runDirectory, SUBMISSION_LEDGER_PATH));
  if (text === null) {
    return { unavailable: `${SUBMISSION_LEDGER_PATH} is missing` };
  }
  const { rows, damagedLineCount } = parseJsonlRows(text);
  if (damagedLineCount > 0) {
    return {
      unavailable: `${SUBMISSION_LEDGER_PATH} has ${damagedLineCount} damaged JSONL line(s)`,
    };
  }
  const records: {
    readonly timestamp?: string;
    readonly payload: unknown;
  }[] = [];
  for (const row of rows) {
    if (!isPlainObject(row) || row.kind !== "sealed") continue;
    const timestamp = nonEmptyString(row.timestamp);
    records.push({
      ...(timestamp === undefined ? {} : { timestamp }),
      payload: "payload" in row ? row.payload : undefined,
    });
  }
  return { records, source: SUBMISSION_LEDGER_PATH };
}

/**
 * Latest-mtime codex rollout whose filename carries one of the thread ids,
 * under the operator codex sessions root. None found → undefined (missing
 * material, honestly unavailable — not an error).
 */
async function findCodexRollout(
  machineHome: string,
  threadIds: readonly string[],
): Promise<{ path: string; text: string } | undefined> {
  const root = codexSessionsRoot(machineHome);
  let entries;
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw error;
  }
  const candidates: { path: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!threadIds.some((id) => entry.name.includes(id))) continue;
    const path = join(entry.parentPath, entry.name);
    let stats;
    try {
      stats = await stat(path);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") continue;
      throw error;
    }
    candidates.push({ path, mtimeMs: stats.mtimeMs });
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const latest = candidates[0]!;
  return { path: latest.path, text: await readFile(latest.path, "utf8") };
}

/** Read the five fact kinds from one existing run directory. Zero writes. */
export async function projectRunShowFacts(
  runDirectory: string,
  env: RunShowMachineHomeEnv = {},
): Promise<RunShowFacts> {
  const machineHome = env.machineHome ?? packageMachineHome();

  const lastVerdictPayload = await readLastVerdictPayload(runDirectory);
  const sealRecords = await readSealRecords(runDirectory);

  // Host thread ids + host routing pointers, from the run's own materials.
  const ids: { id: string; source: string }[] = [];
  const seenIds = new Set<string>();
  const addThreadId = (id: string, source: string): void => {
    if (seenIds.has(id)) return;
    seenIds.add(id);
    ids.push({ id, source });
  };
  const codexThreadIds = new Set<string>();
  let claudeHostPointer: string | undefined;
  let externalHostPointer: string | undefined;
  for (const binding of hostSessionBindingFiles()) {
    const relative = `session/${binding.file}`;
    const text = await readUtf8OrNull(join(runDirectory, "session", binding.file));
    if (text === null) continue;
    externalHostPointer ??= relative;
    if (binding.host === "claude") claudeHostPointer = relative;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const sessionId = isPlainObject(parsed)
      ? nonEmptyString(parsed.sessionId)
      : undefined;
    if (sessionId === undefined) continue;
    addThreadId(sessionId, relative);
    if (binding.host === "codex") codexThreadIds.add(sessionId);
  }

  const hostSessionText = await readUtf8OrNull(
    join(runDirectory, HOST_SESSION_RECORDS_PATH),
  );
  let hostSessionDamaged = false;
  let claudeCompactBoundaries = 0;
  let claudeResultUsage: unknown;
  let codexTurnCompletedUsage: unknown;
  if (hostSessionText !== null) {
    externalHostPointer ??= HOST_SESSION_RECORDS_PATH;
    const parsed = parseJsonlRows(hostSessionText);
    hostSessionDamaged = parsed.damagedLineCount > 0;
    if (!hostSessionDamaged) {
      for (const row of parsed.rows) {
        if (!isPlainObject(row)) continue;
        const payload = isPlainObject(row.payload) ? row.payload : undefined;
        if (payload === undefined) continue;
        if (payload.type === "thread.started") {
          const threadId = nonEmptyString(payload.thread_id);
          if (threadId !== undefined) {
            addThreadId(threadId, HOST_SESSION_RECORDS_PATH);
            if (row.host === "codex") codexThreadIds.add(threadId);
          }
          continue;
        }
        if (row.host === "codex" && payload.type === "turn.completed" && isPlainObject(payload.usage)) {
          // Cumulative session total on each turn.completed (matches rollout
          // total_token_usage); keep the last readable value.
          codexTurnCompletedUsage = payload.usage;
          continue;
        }
        if (row.host !== "claude") continue;
        if (payload.type === "system" && payload.subtype === "compact_boundary") {
          claudeCompactBoundaries += 1;
        } else if (payload.type === "result" && isPlainObject(payload.usage)) {
          claudeResultUsage = payload.usage;
        }
      }
    }
  }

  const sessionVolumeText = await readUtf8OrNull(
    join(runDirectory, SESSION_VOLUME_PATH),
  );
  const sessionParsed = sessionVolumeText === null
    ? { rows: [] as readonly unknown[], damagedLineCount: 0 }
    : parseJsonlRows(sessionVolumeText);
  const sessionRows = sessionParsed.rows;
  const sessionVolumeDamaged = sessionParsed.damagedLineCount > 0;
  // The pi session header id is a host session id only when no external host
  // pointer exists (external-host runs keep a header-only session volume).
  if (externalHostPointer === undefined && !sessionVolumeDamaged) {
    for (const row of sessionRows) {
      if (!isPlainObject(row) || row.type !== "session") continue;
      const headerId = nonEmptyString(row.id);
      if (headerId !== undefined) addThreadId(headerId, SESSION_VOLUME_PATH);
      break;
    }
  }

  const hostThreadIds: RunShowFacts["hostThreadIds"] = ids.length > 0
    ? { ids }
    : {
        unavailable:
          "no host session id on this run (no session binding file, no thread.started record, no pi session header)",
      };

  // Compaction count + token usage follow the run's host family carriers.
  let compactionCount: RunShowFacts["compactionCount"];
  let tokenUsage: RunShowFacts["tokenUsage"];
  if (codexThreadIds.size > 0) {
    const threadIdList = [...codexThreadIds];
    const rollout = await findCodexRollout(machineHome, threadIdList);
    if (rollout === undefined) {
      const reason =
        `no codex rollout found for thread ${threadIdList.join(", ")} under ${codexSessionsRoot(machineHome)}`;
      compactionCount = { unavailable: reason };
      // Prefer the run's own direct-write turn.completed.usage (ADR 0077) when
      // the native rollout is absent — do not report readable usage as missing.
      if (hostSessionDamaged) {
        tokenUsage = {
          unavailable: `${HOST_SESSION_RECORDS_PATH} has damaged JSONL line(s)`,
        };
      } else if (codexTurnCompletedUsage !== undefined) {
        tokenUsage = {
          usage: codexTurnCompletedUsage,
          source: HOST_SESSION_RECORDS_PATH,
        };
      } else if (hostSessionText === null) {
        tokenUsage = { unavailable: `${HOST_SESSION_RECORDS_PATH} is missing` };
      } else {
        tokenUsage = {
          unavailable: `no turn.completed.usage in ${HOST_SESSION_RECORDS_PATH} and ${reason}`,
        };
      }
    } else {
      const { rows, damagedLineCount } = parseJsonlRows(rollout.text);
      if (damagedLineCount > 0) {
        const reason = `${rollout.path} has ${damagedLineCount} damaged JSONL line(s)`;
        compactionCount = { unavailable: reason };
        tokenUsage = { unavailable: reason };
      } else {
        compactionCount = {
          count: rows.filter((row) => isPlainObject(row) && row.type === "compacted").length,
          source: rollout.path,
        };
        let info: unknown;
        for (const row of rows) {
          if (!isPlainObject(row) || row.type !== "event_msg") continue;
          const payload = isPlainObject(row.payload) ? row.payload : undefined;
          if (payload === undefined || payload.type !== "token_count") continue;
          if (isPlainObject(payload.info)) info = payload.info;
        }
        tokenUsage = info === undefined
          ? { unavailable: `no token_count event in ${rollout.path}` }
          : { usage: info, source: rollout.path };
      }
    }
  } else if (claudeHostPointer !== undefined) {
    if (hostSessionText === null) {
      compactionCount = { unavailable: `${HOST_SESSION_RECORDS_PATH} is missing` };
      tokenUsage = { unavailable: `${HOST_SESSION_RECORDS_PATH} is missing` };
    } else if (hostSessionDamaged) {
      const reason = `${HOST_SESSION_RECORDS_PATH} has damaged JSONL line(s)`;
      compactionCount = { unavailable: reason };
      tokenUsage = { unavailable: reason };
    } else {
      compactionCount = {
        count: claudeCompactBoundaries,
        source: HOST_SESSION_RECORDS_PATH,
      };
      tokenUsage = claudeResultUsage === undefined
        ? { unavailable: `no result usage record in ${HOST_SESSION_RECORDS_PATH}` }
        : { usage: claudeResultUsage, source: HOST_SESSION_RECORDS_PATH };
    }
  } else if (externalHostPointer !== undefined) {
    compactionCount = { unavailable: "no compaction record on this run" };
    tokenUsage = { unavailable: "no token usage record on this run" };
  } else if (sessionVolumeText === null) {
    compactionCount = { unavailable: `${SESSION_VOLUME_PATH} is missing` };
    tokenUsage = { unavailable: `${SESSION_VOLUME_PATH} is missing` };
  } else if (sessionVolumeDamaged) {
    const reason = `${SESSION_VOLUME_PATH} has ${sessionParsed.damagedLineCount} damaged JSONL line(s)`;
    compactionCount = { unavailable: reason };
    tokenUsage = { unavailable: reason };
  } else {
    compactionCount = {
      count: sessionRows.filter(
        (row) => isPlainObject(row) && row.type === "compaction",
      ).length,
      source: SESSION_VOLUME_PATH,
    };
    // Whole-run assistant usage — reuse the shared summer; never invent a
    // parallel last-message projection (#1064).
    const usage = await readAssistantUsageFromSessionFile(
      join(runDirectory, SESSION_VOLUME_PATH),
    );
    tokenUsage = usage === undefined
      ? { unavailable: `no usage record in ${SESSION_VOLUME_PATH}` }
      : { usage, source: SESSION_VOLUME_PATH };
  }

  return {
    runDirectory,
    lastVerdictPayload,
    sealRecords,
    hostThreadIds,
    compactionCount,
    tokenUsage,
  };
}

function jsonLine(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

/**
 * Terminal rendering. One line per fact; embedded JSON facts print as
 * single-line compact JSON so terminal output stays directly comparable
 * with a raw read of the same material. Layout is presentation only.
 */
export function renderRunShowFacts(facts: RunShowFacts): string {
  const lines: string[] = [`run: ${facts.runDirectory}`];

  if ("unavailable" in facts.lastVerdictPayload) {
    lines.push(
      `last verdict payload: unavailable (${facts.lastVerdictPayload.unavailable})`,
    );
  } else {
    lines.push(`last verdict payload: ${jsonLine(facts.lastVerdictPayload.payload)}`);
  }

  if ("unavailable" in facts.sealRecords) {
    lines.push(`seal records: unavailable (${facts.sealRecords.unavailable})`);
  } else {
    lines.push(`seal records: ${facts.sealRecords.records.length} (${facts.sealRecords.source})`);
    for (const record of facts.sealRecords.records) {
      lines.push(`  ${record.timestamp ?? "-"} ${jsonLine(record.payload)}`);
    }
  }

  if ("unavailable" in facts.hostThreadIds) {
    lines.push(`host thread id: unavailable (${facts.hostThreadIds.unavailable})`);
  } else {
    lines.push(
      `host thread id: ${facts.hostThreadIds.ids.map((entry) => `${entry.id} (${entry.source})`).join(", ")}`,
    );
  }

  if ("unavailable" in facts.compactionCount) {
    lines.push(`compaction count: unavailable (${facts.compactionCount.unavailable})`);
  } else {
    lines.push(`compaction count: ${facts.compactionCount.count} (${facts.compactionCount.source})`);
  }

  if ("unavailable" in facts.tokenUsage) {
    lines.push(`token usage: unavailable (${facts.tokenUsage.unavailable})`);
  } else {
    lines.push(`token usage: ${jsonLine(facts.tokenUsage.usage)} (${facts.tokenUsage.source})`);
  }

  return `${lines.join("\n")}\n`;
}

const RUN_SHOW_USAGE = "usage: ak-role run show <run-dir>";

/**
 * Public `ak-role run show <run-dir>` — read-only single-run view (#1064).
 * Usage failures exit 2 through the shared structural rejection presenter;
 * a completed view (even with unavailable facts) exits 0.
 */
export async function runPublicRunShow(
  args: readonly string[],
  env: RunShowMachineHomeEnv,
  io: CliIo,
): Promise<number> {
  try {
    if (args.length !== 2 || args[0] !== "show" || args[1]!.trim() === "") {
      throw new CliUsageError(RUN_SHOW_USAGE);
    }
    const runDirectory = isAbsolute(args[1]!) ? args[1]! : resolve(args[1]!);
    let stats;
    try {
      stats = await stat(runDirectory);
    } catch (error) {
      if (errnoCode(error) === "ENOENT" || errnoCode(error) === "ENOTDIR") {
        throw new CliUsageError(`run directory not found: ${args[1]}`, {
          cause: error,
        });
      }
      throw error;
    }
    if (!stats.isDirectory()) {
      throw new CliUsageError(`run directory is not a directory: ${args[1]}`);
    }
    const facts = await projectRunShowFacts(runDirectory, env);
    io.stdout(renderRunShowFacts(facts));
    return 0;
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return 2;
    }
    throw error;
  }
}
