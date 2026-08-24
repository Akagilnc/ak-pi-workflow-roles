/**
 * Sole nested-volume reader for gate-cycle facts under session/auditor-roles/.
 *
 * Called only from the Analyst sole ledger scan (classifyScopedRun). Metric
 * families must not open a second disk scan — they consume retained facts.
 *
 * Naming: records may carry pre-#440 menxia/jishizhong/fubaolang tool faces or
 * the current gatekeeper/inspector/notary English face. Projection always uses
 * the current English officer identity (inspector | notary).
 *
 * Missing auditor-roles directory → empty rounds (lawful zero).
 * Discovered nested JSONL that fails canonical read/parse must fail loudly
 * (never silently under-count). Readable volumes that simply lack a gate
 * terminating tool are omitted from pairing — that is not a read failure.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  extractSessionTimestampSpan,
  readLedgerSessionJsonl,
  type LedgerSessionRow,
} from "./ledger-session-read.ts";

/** One completed gate round: province dispatch paired with its officer volume. */
export type AnalystGateCycleRound = {
  /** 1-based chronological order among paired rounds on this leg. */
  readonly roundIndex: number;
  /** Current English officer face after historical alias fold. */
  readonly officer: "inspector" | "notary";
  /** Typed officer terminal status (pass / bounce / incomplete / …). */
  readonly status: string;
  /** Officer subsession first→last usable timestamp delta (ms). */
  readonly officerWallMs: number;
  readonly officerStartedAt: string;
  readonly officerEndedAt: string;
  /** findings[] length only — prose never retained. */
  readonly findingsCount: number;
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

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error
    && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function normalizeOfficerArg(raw: unknown): "inspector" | "notary" | undefined {
  if (typeof raw !== "string") return undefined;
  return OFFICER_ARG_ALIASES[raw.trim()];
}

type TerminatingCall = {
  readonly toolName: string;
  readonly status: string;
  readonly officerArg?: "inspector" | "notary";
  readonly findingsCount: number;
};

/**
 * Last terminating gate toolCall on a nested volume (dispatch or officer).
 * Soul-audit and other tools are ignored so they never form gate pairs.
 */
function extractLastGateTerminatingCall(
  rows: readonly LedgerSessionRow[],
): TerminatingCall | undefined {
  let last: TerminatingCall | undefined;
  for (const row of rows) {
    const message = isRecord(row.message) ? row.message : undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== "toolCall") continue;
      if (typeof part.name !== "string" || part.name.length === 0) continue;
      const toolName = part.name;
      const isDispatch = DISPATCH_TOOLS.has(toolName);
      const officerFace = OFFICER_TOOL_TO_FACE[toolName];
      if (!isDispatch && officerFace === undefined) continue;
      const args = isRecord(part.arguments) ? part.arguments : undefined;
      const status =
        args !== undefined && typeof args.status === "string" && args.status.trim() !== ""
          ? args.status.trim()
          : undefined;
      if (status === undefined) continue;
      const findings = args?.findings;
      const findingsCount = Array.isArray(findings) ? findings.length : 0;
      if (isDispatch) {
        const officerArg = normalizeOfficerArg(args?.officer);
        last =
          officerArg === undefined
            ? { toolName, status, findingsCount }
            : { toolName, status, officerArg, findingsCount };
      } else if (officerFace !== undefined) {
        last = {
          toolName,
          status,
          officerArg: officerFace,
          findingsCount,
        };
      }
    }
  }
  return last;
}

type ClassifiedVolume =
  | {
      readonly kind: "dispatch";
      readonly startedAt: string;
      readonly officer: "inspector" | "notary";
    }
  | {
      readonly kind: "officer";
      readonly startedAt: string;
      readonly endedAt: string;
      readonly officer: "inspector" | "notary";
      readonly status: string;
      readonly findingsCount: number;
      readonly officerWallMs: number;
    };

async function classifyAuditorVolume(
  filePath: string,
): Promise<ClassifiedVolume | undefined> {
  // Canonical JSONL errors propagate — failure honesty (never wash to fewer rounds).
  const rows = await readLedgerSessionJsonl(filePath);
  const span = extractSessionTimestampSpan(rows);
  if (span.startedAt === undefined || span.endedAt === undefined) return undefined;
  const startedMs = Date.parse(span.startedAt);
  const endedMs = Date.parse(span.endedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs) || endedMs < startedMs) {
    return undefined;
  }
  const call = extractLastGateTerminatingCall(rows);
  if (call === undefined) return undefined;

  if (DISPATCH_TOOLS.has(call.toolName)) {
    if (call.status !== "dispatch" || call.officerArg === undefined) return undefined;
    return {
      kind: "dispatch",
      startedAt: span.startedAt,
      officer: call.officerArg,
    };
  }

  const officer = OFFICER_TOOL_TO_FACE[call.toolName];
  if (officer === undefined) return undefined;
  return {
    kind: "officer",
    startedAt: span.startedAt,
    endedAt: span.endedAt,
    officer,
    status: call.status,
    findingsCount: call.findingsCount,
    officerWallMs: endedMs - startedMs,
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
      // First unused later officer with matching identity.
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
      findingsCount: match.officer.findingsCount,
    });
  }

  return rounds;
}

/**
 * Read and pair gate-cycle rounds from a run's session/auditor-roles directory.
 * ENOENT/ENOTDIR → []. Other directory errors propagate (failure honesty).
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
    if (isMissingPathError(error)) return [];
    throw error;
  }

  const volumes: ClassifiedVolume[] = [];
  for (const name of names) {
    const classified = await classifyAuditorVolume(join(auditorRolesDirectory, name));
    if (classified !== undefined) volumes.push(classified);
  }
  return pairGateRounds(volumes);
}
