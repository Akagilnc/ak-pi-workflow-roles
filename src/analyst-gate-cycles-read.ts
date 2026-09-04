/**
 * Sole nested-volume reader for gate-cycle facts under session/auditor-roles/.
 *
 * Consumers: Analyst sole ledger scan (classifyScopedRun) and Terminal gate
 * projection (#478). Metric families must not open a second disk scan — they
 * consume retained facts. Terminal settlement reuses this same pairing seam
 * (no second auditor-roles scanner).
 *
 * Naming: records may carry pre-#440 menxia/jishizhong/fubaolang tool faces or
 * the current gatekeeper/inspector/notary English face. Projection always uses
 * the current English officer identity (inspector | notary).
 *
 * Missing auditor-roles directory (ENOENT only) → empty rounds (lawful zero).
 * Path present but not a directory (ENOTDIR) and discovered nested JSONL that
 * fails canonical read/parse must fail loudly (never silently under-count).
 * An accepted gate terminating receipt (isError:false pair on dispatch/officer
 * tool) whose required typed facts are unusable — status, dispatch officer, or
 * first/last span missing/unknown/unparseable/inverted — also fails loudly via
 * the same throw→ledger `auditor-roles` unreadable seam. Unknown/non-contract
 * dispatch status stays loud (#475 abolished Gatekeeper incomplete special-case).
 * Lawful province non-dispatch release (`pass` on a dispatch tool) opens no
 * round and must not throw (#597 / ADR 0074 gate-non-mandatory).
 * True non-gate volumes (soul-audit noise, etc.) stay omitted from pairing.
 * Historical dispatch↔officer pairing requires a shared typed
 * `ak_auditor_parent_attempt_binding.parent.attemptEntryId` — never seat/time guessing.
 * An orphan accepted dispatch must not consume a later same-seat direct officer.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE,
} from "./compliance-transport.ts";
import {
  extractSessionTimestampSpan,
  readLedgerSessionJsonl,
  type LedgerSessionRow,
} from "./ledger-session-read.ts";

/** One completed gate round: direct officer receipt or historical province/officer pair. */
/** Honest origin discriminant: direct summons vs historical province dispatch. */
export type AnalystGateCycleOrigin =
  | { readonly kind: "direct" }
  | {
      readonly kind: "historical_dispatch";
      /** Seat-reduction reason from the accepted dispatch receipt; never invented. */
      readonly reason?: string;
    };

export type AnalystGateCycleRound = {
  /** 1-based chronological order among paired rounds on this leg. */
  readonly roundIndex: number;
  /** Current English officer face after historical alias fold. */
  readonly officer: "inspector" | "notary";
  /** Typed officer terminal status (pass / bounce / …). */
  readonly status: string;
  /** Officer subsession first→last usable timestamp delta (ms). */
  readonly officerWallMs: number;
  readonly officerStartedAt: string;
  readonly officerEndedAt: string;
  /**
   * Typed string findings retained from the accepted officer receipt (#478 Terminal
   * projection). Analyst metrics still consume findingsCount only — never prose.
   */
  readonly findings: readonly string[];
  /** findings.length — retained so metric families need not re-derive. */
  readonly findingsCount: number;
  /** Direct summons or historical province-paired dispatch. */
  readonly origin: AnalystGateCycleOrigin;
};

const DISPATCH_TOOLS = new Set(["ak_menxia_output", "ak_gatekeeper_output"]);

/** Officer terminating tool → current English officer identity. */
const OFFICER_TOOL_TO_FACE: Readonly<Record<string, "inspector" | "notary">> = {
  ak_jishizhong_output: "inspector",
  ak_inspector_output: "inspector",
  ak_fubaolang_output: "notary",
  ak_notary_output: "notary",
};

/** Dispatch `officer` argument aliases → current English face. */
const OFFICER_ARG_ALIASES: Readonly<Record<string, "inspector" | "notary">> = {
  jishizhong: "inspector",
  inspector: "inspector",
  fubaolang: "notary",
  notary: "notary",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Typed parent-attempt id from ak_auditor_parent_attempt_binding — durable invocation association. */
function extractAttemptEntryId(rows: readonly LedgerSessionRow[]): string | undefined {
  for (const row of rows) {
    if (row.type !== "custom" || row.customType !== AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE) continue;
    if (!isRecord(row.data) || !isRecord(row.data.parent)) continue;
    const id = row.data.parent.attemptEntryId;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return undefined;
}


/** Only true absence (ENOENT). ENOTDIR is damaged topology — must stay loud. */
function isMissingDirectoryError(error: unknown): boolean {
  return (
    error instanceof Error
    && "code" in error
    && error.code === "ENOENT"
  );
}

function normalizeOfficerArg(raw: unknown): "inspector" | "notary" | undefined {
  if (typeof raw !== "string") return undefined;
  return OFFICER_ARG_ALIASES[raw.trim()];
}

/** Typed string findings only — non-strings dropped; missing/non-array → []. */
function asStringFindings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * Optional non-empty dispatch reason. Trim only decides emptiness; a non-empty
 * durable reason is returned as written (gatekeeper keeps reason as-is).
 */
function optionalDispatchReason(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw.trim() === "") return undefined;
  return raw;
}

type GateToolCall = {
  readonly toolName: string;
  readonly args: Record<string, unknown> | undefined;
  readonly accepted: boolean;
};

function isGateTerminatingToolName(toolName: string): boolean {
  return DISPATCH_TOOLS.has(toolName) || OFFICER_TOOL_TO_FACE[toolName] !== undefined;
}

/**
 * toolCallIds whose paired toolResult is an accepted receipt (`isError === false`).
 * Receipt is the sole lawful role product — rejected / missing results never qualify.
 */
function acceptedGateReceiptIds(
  rows: readonly LedgerSessionRow[],
): ReadonlySet<string> {
  const accepted = new Set<string>();
  for (const row of rows) {
    const message = isRecord(row.message) ? row.message : undefined;
    if (message?.role !== "toolResult") continue;
    if (typeof message.toolCallId !== "string" || message.toolCallId.length === 0) continue;
    if (message.isError === false) accepted.add(message.toolCallId);
  }
  return accepted;
}

/**
 * Last accepted gate terminating toolCall on a nested volume (dispatch or officer).
 * Preference: keep the last accepted receipt; fall back to a rejected call only
 * when no accepted receipt exists (so classify can lawfully omit). Identity only
 * — typed args are validated after recognition so unusable facts fail loud
 * instead of being skipped as "not a gate volume". Soul-audit and other non-gate
 * tools never qualify.
 */
function extractLastGateToolCall(
  rows: readonly LedgerSessionRow[],
): GateToolCall | undefined {
  const acceptedIds = acceptedGateReceiptIds(rows);
  let lastAccepted: GateToolCall | undefined;
  let lastRejected: GateToolCall | undefined;
  for (const row of rows) {
    const message = isRecord(row.message) ? row.message : undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== "toolCall") continue;
      if (typeof part.id !== "string" || part.id.length === 0) continue;
      if (typeof part.name !== "string" || part.name.length === 0) continue;
      if (!isGateTerminatingToolName(part.name)) continue;
      const call: GateToolCall = {
        toolName: part.name,
        args: isRecord(part.arguments) ? part.arguments : undefined,
        accepted: acceptedIds.has(part.id),
      };
      if (call.accepted) {
        lastAccepted = call;
      } else if (lastAccepted === undefined) {
        // Only retain rejected while no accepted receipt has appeared yet.
        lastRejected = call;
      }
    }
  }
  return lastAccepted ?? lastRejected;
}

function requireAcceptedGateStatus(
  args: Record<string, unknown> | undefined,
  filePath: string,
): string {
  if (args === undefined || typeof args.status !== "string" || args.status.trim() === "") {
    throw new Error(
      `accepted gate receipt missing usable status in ${filePath}`,
    );
  }
  return args.status.trim();
}

function requireAcceptedGateSpan(
  rows: readonly LedgerSessionRow[],
  filePath: string,
): { readonly startedAt: string; readonly endedAt: string; readonly wallMs: number } {
  const span = extractSessionTimestampSpan(rows);
  if (span.startedAt === undefined || span.endedAt === undefined) {
    throw new Error(
      `accepted gate volume missing session timestamp span in ${filePath}`,
    );
  }
  const startedMs = Date.parse(span.startedAt);
  const endedMs = Date.parse(span.endedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs) || endedMs < startedMs) {
    throw new Error(
      `accepted gate volume has unusable timestamp span in ${filePath}`,
    );
  }
  return {
    startedAt: span.startedAt,
    endedAt: span.endedAt,
    wallMs: endedMs - startedMs,
  };
}

type ClassifiedVolume =
  | {
      readonly kind: "dispatch";
      readonly startedAt: string;
      readonly officer: "inspector" | "notary";
      readonly status: string;
      readonly reason?: string;
      /** Present only when the volume carries ak_auditor_parent_attempt_binding. */
      readonly attemptEntryId?: string;
    }
  | {
      readonly kind: "officer";
      readonly startedAt: string;
      readonly endedAt: string;
      readonly officer: "inspector" | "notary";
      readonly status: string;
      readonly findings: readonly string[];
      readonly findingsCount: number;
      readonly officerWallMs: number;
      readonly attemptEntryId?: string;
    };

async function classifyAuditorVolume(
  filePath: string,
): Promise<ClassifiedVolume | undefined> {
  // Canonical JSONL errors propagate — failure honesty (never wash to fewer rounds).
  const rows = await readLedgerSessionJsonl(filePath);
  // Recognize gate tool first. Non-gate volumes stay omitted; rejected gate
  // receipts omit before accepted-only span/status validation; once an accepted
  // receipt is present, required typed facts must not silently under-count.
  const call = extractLastGateToolCall(rows);
  if (call === undefined) return undefined;

  const attemptEntryId = extractAttemptEntryId(rows);
  if (!call.accepted) {
    // Rejected historical dispatch is not a pairing key — omit it so a later
    // independent direct officer summons remains its own round. Span is not
    // validated here: accepted-only contract must not throw on rejected volumes.
    return undefined;
  }
  const span = requireAcceptedGateSpan(rows, filePath);
  const status = requireAcceptedGateStatus(call.args, filePath);
  const findings = asStringFindings(call.args?.findings);
  const findingsCount = findings.length;

  if (DISPATCH_TOOLS.has(call.toolName)) {
    // Lawful province non-dispatch release — opens no round, never unreadable (#597).
    if (status === "pass") {
      return undefined;
    }
    // Pairing terminal is dispatch; unknown/non-contract status stays loud (#475).
    if (status !== "dispatch") {
      throw new Error(
        `accepted dispatch receipt has non-dispatch status ${JSON.stringify(status)} in ${filePath}`,
      );
    }
    const officer = normalizeOfficerArg(call.args?.officer);
    if (officer === undefined) {
      throw new Error(
        `accepted dispatch receipt missing or unknown officer in ${filePath}`,
      );
    }
    const reason = optionalDispatchReason(call.args?.reason);
    return {
      kind: "dispatch",
      startedAt: span.startedAt,
      officer,
      status,
      ...(reason === undefined ? {} : { reason }),
      ...(attemptEntryId === undefined ? {} : { attemptEntryId }),
    };
  }

  const officer = OFFICER_TOOL_TO_FACE[call.toolName];
  if (officer === undefined) {
    // isGateTerminatingToolName already screened; keep loud if tables drift.
    throw new Error(
      `accepted gate receipt has unknown officer tool ${call.toolName} in ${filePath}`,
    );
  }
  return {
    kind: "officer",
    startedAt: span.startedAt,
    endedAt: span.endedAt,
    officer,
    status,
    findings,
    findingsCount,
    officerWallMs: span.wallMs,
    ...(attemptEntryId === undefined ? {} : { attemptEntryId }),
  };
}

function pairGateRounds(
  volumes: readonly ClassifiedVolume[],
): readonly AnalystGateCycleRound[] {
  const ordered = [...volumes].sort((a, b) => {
    if (a.startedAt !== b.startedAt) return a.startedAt.localeCompare(b.startedAt);
    // Stable tie-break: dispatch before officer at identical start (should not happen).
    if (a.kind !== b.kind) return a.kind === "dispatch" ? -1 : 1;
    return 0;
  });

  const usedOfficerIdx = new Set<number>();
  const rounds: AnalystGateCycleRound[] = [];

  for (let i = 0; i < ordered.length; i += 1) {
    const vol = ordered[i]!;
    if (vol.kind !== "dispatch") continue;
    let match: { index: number; officer: Extract<ClassifiedVolume, { kind: "officer" }> } | undefined;
    for (let j = i + 1; j < ordered.length; j += 1) {
      if (usedOfficerIdx.has(j)) continue;
      const candidate = ordered[j]!;
      if (candidate.kind !== "officer") continue;
      if (candidate.officer !== vol.officer) continue;
      // Durable invocation association — seat/time alone must not pair.
      if (
        vol.attemptEntryId === undefined
        || candidate.attemptEntryId === undefined
        || candidate.attemptEntryId !== vol.attemptEntryId
      ) {
        continue;
      }
      match = { index: j, officer: candidate };
      break;
    }
    if (match === undefined) continue;
    usedOfficerIdx.add(match.index);
    rounds.push({
      roundIndex: rounds.length + 1,
      officer: match.officer.officer,
      status: match.officer.status,
      officerWallMs: match.officer.officerWallMs,
      officerStartedAt: match.officer.startedAt,
      officerEndedAt: match.officer.endedAt,
      findings: match.officer.findings,
      findingsCount: match.officer.findingsCount,
      origin: {
        kind: "historical_dispatch",
        ...(vol.reason === undefined ? {} : { reason: vol.reason }),
      },
    });
  }

  // Current direct-summons volumes have no preceding province dispatch. Every
  // accepted officer receipt not consumed by a historical pair is its own round.
  for (let i = 0; i < ordered.length; i += 1) {
    const vol = ordered[i]!;
    if (vol.kind !== "officer" || usedOfficerIdx.has(i)) continue;
    rounds.push({
      roundIndex: 0,
      officer: vol.officer,
      status: vol.status,
      officerWallMs: vol.officerWallMs,
      officerStartedAt: vol.startedAt,
      officerEndedAt: vol.endedAt,
      findings: vol.findings,
      findingsCount: vol.findingsCount,
      origin: { kind: "direct" },
    });
  }

  return rounds
    .sort((a, b) => a.officerStartedAt.localeCompare(b.officerStartedAt))
    .map((round, index) => ({ ...round, roundIndex: index + 1 }));
}

/**
 * Read and pair gate-cycle rounds from a run's session/auditor-roles directory.
 * ENOENT (directory truly absent) → []. ENOTDIR and other errors propagate
 * (failure honesty — damaged topology must not wash to zero rounds).
 */
export async function readAnalystGateCyclesFromAuditorRoles(
  auditorRolesDirectory: string,
): Promise<readonly AnalystGateCycleRound[]> {
  let names: string[];
  try {
    const entries = await readdir(auditorRolesDirectory, { withFileTypes: true });
    names = entries
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => e.name)
      .sort();
  } catch (error) {
    if (isMissingDirectoryError(error)) return [];
    throw error;
  }

  const volumes: ClassifiedVolume[] = [];
  for (const name of names) {
    const classified = await classifyAuditorVolume(join(auditorRolesDirectory, name));
    if (classified !== undefined) volumes.push(classified);
  }
  return pairGateRounds(volumes);
}
