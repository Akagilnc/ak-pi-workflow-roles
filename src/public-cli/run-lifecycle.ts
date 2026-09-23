import type {
  DurablePrincipal,
  DurablePrincipalAuthority,
} from "../host-contracts.ts";
/**
 * Durable Role run lifecycle for public CLI (ADR 0052 / #11 / #108 / #416).
 * States: admitted → running → resumable | terminal.
 * #416 (owner 2026-08-22): resume no longer gates on terminal/resumable or typed 429 —
 * any existing run with an available Pi session principal may be resumed; caller decides.
 * Prose is never regex-classified as quota evidence.
 */
import { chmod, lstat, open, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";

import {
  activationBookDirectory,
  resolveActivationLedgerHome,
} from "../activation-ledger-topology.ts";
import { listBookRunDirectories } from "../role-run-placement.ts";
import { isSafePositiveTicketNumber } from "../run-ticket-number.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  readLatestTypedProviderHttpObservation,
} from "../typed-provider-http.ts";
export {
  clearTypedProviderHttpObservation,
  recordTypedProviderHttpStatus,
  readLatestTypedProviderHttpObservation,
  type TypedProviderHttpObservation,
} from "../typed-provider-http.ts";
import type { FixerPhase } from "../package-contracts/fixer-output.ts";
import type { FixerPrerequisite } from "../package-contracts/fixer-packet.ts";
import { parseCollectorRepository } from "../collector-config.ts";
import {
  interpretDurableCourtTicketNumbers,
  sameCourtTicketNumbers,
} from "../diarist-contracts.ts";
import type { DoctorCaseIdentity } from "../doctor-contracts.ts";
import type { NotarySourceRunLocator } from "../notary-contracts.ts";
import {
  rewriteAdmittedRoleRunPage,
  rewriteRunDirectoryPathValue,
} from "../role-run-relocation.ts";
import {
  appendEngineSessionMaterial,
  engineSessionMaterialFromOptions,
  pickEngineAxis,
} from "../package-resources/engine-material.ts";
import type { PublicThinkingLevel } from "./registry.ts";
import {
  packagedResumeSourcePath,
  packagedRoleMetadata,
  type PackagedRole,
} from "../packaged-role-registry.ts";
import {
  recordEffectiveInvocationModel,
  requireAuthorityRef,
  isReviewerLens,
  type AdmittedCoderInvocation,
  type AdmittedCountersignInvocation,
  type AdmittedCollectorInvocation,
  type AdmittedDoctorInvocation,
  type AdmittedInspectorInvocation,
  type AdmittedNotaryInvocation,
  type AdmittedFixerInvocation,
  type AdmittedGleanerLeftInvocation,
  type AdmittedMergerInvocation,
  type AdmittedReviewerInvocation,
  type AdmittedRoleInvocation,
  type CoderPhase,
  type DerivedMergerEnvelope,
  type FrozenAttachment,
  type InvocationEffectiveModel,
  type ReviewerLens,
} from "./invocation.ts";

/** Providers eligible for v1 typed-429 resume (Codex / xAI only).
 * @deprecated v1 429-only gate removed by #416 (owner 2026-08-22: "根本不要有限制"). Kept for compatibility; do not use for new branching.
 */
export const V1_RESUMABLE_PROVIDERS = ["openai-codex", "xai"] as const;
export type V1ResumableProvider = (typeof V1_RESUMABLE_PROVIDERS)[number];

export type RoleRunState = "admitted" | "running" | "resumable" | "terminal";

export type TypedHttp429Observation = {
  readonly httpStatus: 429;
  readonly provider: V1ResumableProvider;
};

/** Default for the #422 configurable single-call auto-resume ceiling
 * (public-cli.json top-level `autoResumeLimit`). No longer the runtime truth
 * source: runWithAutoResumeLoop receives the effective value once per call.
 */
export const AUTO_RESUME_LIMIT = 2 as const;

export type RoleRunRecord = {
  readonly runId: string;
  readonly role: PackagedRole;
  readonly state: RoleRunState;
  readonly bookKey: string;
  readonly projectRoot: string;
  readonly sessionDirectory: string;
  /** Exact Pi session file principal reopened on resume (not directory-latest). */
  readonly sessionFile: string;
  readonly runDirectory: string;
  readonly admittedRequestPath: string;
  /** Coder/Fixer — preserved for resume continuation. */
  readonly phase?: CoderPhase | FixerPhase;
  /** Present only while state === "resumable".
   * @deprecated retained only for historical 429 runs; #416 no longer gates resume on this field.
   */
  readonly resumable?: TypedHttp429Observation;
};

/**
 * Package-owned non-empty Chinese neutral resume transport (#959 / ADR 0073).
 * Used by:
 *   - auto-resume (all seats via buildAutoResumeContinuationPrompt) — required so
 *     hosts that reject empty stdin (codex) still receive a prompt.
 * Public manual resume forwards only the caller's bytes (#987).
 */
export const RESUME_TRANSPORT_ENVELOPE = "继续。" as const;

/** Public manual resume request after the unique CLI parser owns runId + optional message. */
export type PublicResumeRequest = {
  readonly runId: string;
  /** Present when the caller supplied the post-runId argv (including empty string). */
  readonly message?: string;
  /**
   * Same-ticket re-summons materials (#637). Present only when a public seat
   * re-enters via the summons face — never from `ak-role resume`.
   * Manual resume forwards only caller-supplied bytes and never re-delivers them.
   */
  readonly summons?: SameTicketSummonsMaterials;
};

/**
 * Open court turn on a retained run (#637).
 * courtAttemptId identifies settlement across later public manual resume calls.
 * Summons materials belong only to the internal re-summons face.
 * Cleared when this courtAttemptId seals.
 */
export type CurrentCourtState = {
  readonly courtAttemptId: string;
  readonly summons?: SameTicketSummonsMaterials;
};

/**
 * Materials delivered on same-ticket re-summons while reusing the same-run resume seam.
 * Instruction seats freeze new attachments into the retained run and ride the transport prompt;
 * notary overrides the source-run activation pointer for this turn only.
 */
export type SameTicketSummonsMaterials = {
  readonly instruction?: string;
  readonly instructionEmpty?: boolean;
  readonly attachmentPaths?: readonly string[];
  /** Notary: this summons' resolved source-run locator (activation pointer). */
  readonly sourceRunPath?: string;
  readonly sourceRun?: NotarySourceRunLocator;
};

/**
 * Auto-resume continuation only (#959 / ADR 0080).
 * Always non-empty: Chinese neutral envelope plus optional engine pointers.
 * Never call this from manual `ak-role resume`.
 */
export function buildAutoResumeContinuationPrompt(options: {
  packageRoot: string;
  engine?: string;
  engineModel?: string;
}): string {
  return appendEngineSessionMaterial(
    [RESUME_TRANSPORT_ENVELOPE],
    engineSessionMaterialFromOptions({
      packageRoot: options.packageRoot,
      ...pickEngineAxis(options),
    }),
  ).join("\n");
}

const RUN_STATE_FILE = "run-state.json";
const WRITER_LOCK_FILE = "writer.lock";

/** @deprecated #416: 429-only classification removed; kept for compatibility. */
export function isV1ResumableProvider(
  provider: string,
): provider is V1ResumableProvider {
  return (V1_RESUMABLE_PROVIDERS as readonly string[]).includes(provider);
}

/** @deprecated #416: 429-only observation no longer gates resume; kept for historical runs. */
export async function readTypedHttp429Observation(
  runDirectory: string,
): Promise<TypedHttp429Observation | undefined> {
  const observation = await readLatestTypedProviderHttpObservation(runDirectory);
  if (observation === undefined) return undefined;
  if (observation.httpStatus !== 429) return undefined;
  if (!isV1ResumableProvider(observation.provider)) return undefined;
  return { httpStatus: 429, provider: observation.provider };
}

/** Complete public resume command. Run ID is revealed only through this command text. */
export function renderResumeCommand(runId: string): string {
  return `ak-role resume ${runId}`;
}

export async function writeRoleRunState(
  runDirectory: string,
  record: Omit<RoleRunRecord, "runDirectory">,
): Promise<void> {
  const payload: RoleRunRecord = { ...record, runDirectory };
  await writeFile(
    join(runDirectory, RUN_STATE_FILE),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Uninterpreted principal wire as stored on run-state.json.
 * Legacy rows may omit sessionFile; only DurablePrincipalAuthority decodes it.
 */
type RoleRunPrincipalWire = {
  readonly sessionDirectory: string;
  readonly sessionFile?: string;
};

/** Envelope I/O only — principal payload is carried uninterpreted. */
type RoleRunStateDisk = {
  readonly runId: string;
  readonly role: RoleRunRecord["role"];
  readonly state: RoleRunState;
  readonly bookKey: string;
  readonly projectRoot: string;
  readonly runDirectory: string;
  readonly admittedRequestPath: string;
  readonly principalWire: RoleRunPrincipalWire;
  readonly phase?: CoderPhase | FixerPhase;
  readonly resumable?: TypedHttp429Observation;
  /** Open court turn (#637); omit when no unsealed current court. */
  readonly currentCourt?: CurrentCourtState;
};

function parseSameTicketSummonsMaterials(
  raw: unknown,
): SameTicketSummonsMaterials | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const instruction =
    typeof record.instruction === "string" ? record.instruction : undefined;
  const instructionEmpty =
    typeof record.instructionEmpty === "boolean" ? record.instructionEmpty : undefined;
  const attachmentPaths = Array.isArray(record.attachmentPaths)
    ? record.attachmentPaths.filter((p): p is string => typeof p === "string" && p.length > 0)
    : undefined;
  const sourceRunPath =
    typeof record.sourceRunPath === "string" && record.sourceRunPath.trim() !== ""
      ? record.sourceRunPath
      : undefined;
  let sourceRun: NotarySourceRunLocator | undefined;
  if (
    record.sourceRun !== null &&
    typeof record.sourceRun === "object" &&
    !Array.isArray(record.sourceRun)
  ) {
    const sr = record.sourceRun as Record<string, unknown>;
    if (
      typeof sr.runId === "string" &&
      sr.runId.trim() !== "" &&
      typeof sr.role === "string" &&
      sr.role.trim() !== "" &&
      typeof sr.runDirectory === "string" &&
      sr.runDirectory.trim() !== ""
    ) {
      sourceRun = {
        runId: sr.runId,
        role: sr.role,
        runDirectory: sr.runDirectory,
      };
    }
  }
  if (
    instruction === undefined &&
    instructionEmpty === undefined &&
    (attachmentPaths === undefined || attachmentPaths.length === 0) &&
    sourceRunPath === undefined &&
    sourceRun === undefined
  ) {
    return undefined;
  }
  return {
    ...(instruction === undefined ? {} : { instruction }),
    ...(instructionEmpty === undefined ? {} : { instructionEmpty }),
    ...(attachmentPaths === undefined || attachmentPaths.length === 0
      ? {}
      : { attachmentPaths }),
    ...(sourceRunPath === undefined ? {} : { sourceRunPath }),
    ...(sourceRun === undefined ? {} : { sourceRun }),
  };
}

function parseCurrentCourtState(raw: unknown): CurrentCourtState | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.courtAttemptId !== "string" || record.courtAttemptId.length === 0) {
    return undefined;
  }
  const summons = parseSameTicketSummonsMaterials(record.summons);
  return {
    courtAttemptId: record.courtAttemptId,
    ...(summons === undefined ? {} : { summons }),
  };
}

async function readRoleRunStateDisk(
  runDirectory: string,
): Promise<RoleRunStateDisk | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(runDirectory, RUN_STATE_FILE), "utf8"));
  } catch (error) {
    // Only true absence (ENOENT) is a lawful "no run state yet". A real read
    // failure (EISDIR, EACCES, ...) or a JSON.parse SyntaxError on a present
    // file is genuine infrastructure/data damage and must keep its own
    // identity — callers route it through the controlled-failure seam
    // (markRunRunning/markRunResumable/markRunTerminal/recordCurrentCourt)
    // instead of it being relabeled "run state missing" (#836).
    if (errorCodeOf(error) === "ENOENT") return undefined;
    throw error;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.runId !== "string" || record.runId.trim() === "") {
    return undefined;
  }
  const role = typeof record.role === "string" ? packagedRoleMetadata(record.role)?.role : undefined;
  if (role === undefined) {
    return undefined;
  }
  if (
    record.state !== "admitted" &&
    record.state !== "running" &&
    record.state !== "resumable" &&
    record.state !== "terminal"
  ) {
    return undefined;
  }
  if (typeof record.bookKey !== "string") return undefined;
  if (typeof record.projectRoot !== "string") return undefined;
  if (typeof record.sessionDirectory !== "string") return undefined;
  if (typeof record.admittedRequestPath !== "string") return undefined;
  const storedRunDirectory =
    typeof record.runDirectory === "string" && record.runDirectory.trim() !== ""
      ? record.runDirectory
      : runDirectory;
  const runDir = runDirectory;
  // Principal wire stays uninterpreted — authority owns legacy sessionFile fallback.
  const principalWire: RoleRunPrincipalWire = {
    sessionDirectory: rewriteRunDirectoryPathValue(
      record.sessionDirectory,
      storedRunDirectory,
      runDirectory,
    ) as string,
    ...(typeof record.sessionFile === "string"
      ? { sessionFile: rewriteRunDirectoryPathValue(record.sessionFile, storedRunDirectory, runDirectory) as string }
      : {}),
  };
  let resumable: TypedHttp429Observation | undefined;
  if (record.resumable !== undefined && record.resumable !== null) {
    if (
      typeof record.resumable === "object" &&
      !Array.isArray(record.resumable)
    ) {
      const r = record.resumable as Record<string, unknown>;
      if (
        r.httpStatus === 429 &&
        typeof r.provider === "string" &&
        isV1ResumableProvider(r.provider)
      ) {
        resumable = { httpStatus: 429, provider: r.provider };
      }
    }
  }
  const phase =
    record.phase === "plan" || record.phase === "apply"
      ? record.phase
      : undefined;
  const currentCourt = parseCurrentCourtState(record.currentCourt);
  return {
    runId: record.runId,
    role,
    state: record.state,
    bookKey: record.bookKey,
    projectRoot: record.projectRoot,
    runDirectory: runDir,
    admittedRequestPath: rewriteRunDirectoryPathValue(
      record.admittedRequestPath,
      storedRunDirectory,
      runDirectory,
    ) as string,
    principalWire,
    ...(phase === undefined ? {} : { phase }),
    ...(resumable === undefined ? {} : { resumable }),
    ...(currentCourt === undefined ? {} : { currentCourt }),
  };
}

async function writeRoleRunStateDisk(
  runDirectory: string,
  disk: RoleRunStateDisk,
): Promise<void> {
  const payload = {
    runId: disk.runId,
    role: disk.role,
    state: disk.state,
    bookKey: disk.bookKey,
    projectRoot: disk.projectRoot,
    runDirectory: disk.runDirectory,
    sessionDirectory: disk.principalWire.sessionDirectory,
    ...(disk.principalWire.sessionFile === undefined
      ? {}
      : { sessionFile: disk.principalWire.sessionFile }),
    admittedRequestPath: disk.admittedRequestPath,
    ...(disk.phase === undefined ? {} : { phase: disk.phase }),
    ...(disk.resumable === undefined ? {} : { resumable: disk.resumable }),
    ...(disk.currentCourt === undefined ? {} : { currentCourt: disk.currentCourt }),
  };
  await writeFile(
    join(runDirectory, RUN_STATE_FILE),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
}

/** One authority.decode of the uninterpreted wire → record + opaque principal (frozen wire itself). */
function materializeRoleRunFromDisk(
  disk: RoleRunStateDisk,
  authority: DurablePrincipalAuthority,
): { readonly run: RoleRunRecord; readonly principal: DurablePrincipal } | undefined {
  try {
    const coordinates = authority.decode(disk.principalWire);
    return {
      principal: disk.principalWire as unknown as DurablePrincipal,
      run: {
        runId: disk.runId,
        role: disk.role,
        state: disk.state,
        bookKey: disk.bookKey,
        projectRoot: disk.projectRoot,
        sessionDirectory: coordinates.sessionDirectory,
        sessionFile: coordinates.sessionFile,
        runDirectory: disk.runDirectory,
        admittedRequestPath: disk.admittedRequestPath,
        ...(disk.phase === undefined ? {} : { phase: disk.phase }),
        ...(disk.resumable === undefined ? {} : { resumable: disk.resumable }),
      },
    };
  } catch {
    return undefined;
  }
}

/**
 * Read durable run-state and materialize principal coordinates through the
 * injected host authority (legacy sessionFile fallback lives only in the codec).
 */
export async function readRoleRunState(
  runDirectory: string,
  authority: DurablePrincipalAuthority,
): Promise<RoleRunRecord | undefined> {
  const disk = await readRoleRunStateDisk(runDirectory);
  if (disk === undefined) return undefined;
  return materializeRoleRunFromDisk(disk, authority)?.run;
}

/**
 * Envelope identity only — no principal payload interpretation.
 * Used by notary locator / role peek that never consume session coordinates.
 */
export async function readRoleRunIdentity(
  runDirectory: string,
): Promise<
  | {
      readonly runId: string;
      readonly role: RoleRunRecord["role"];
      readonly bookKey: string;
      readonly runDirectory: string;
      readonly state: RoleRunState;
    }
  | undefined
> {
  const disk = await readRoleRunStateDisk(runDirectory);
  if (disk === undefined) return undefined;
  return {
    runId: disk.runId,
    role: disk.role,
    bookKey: disk.bookKey,
    runDirectory: disk.runDirectory,
    state: disk.state,
  };
}

export async function markRunAdmitted(
  admitted: AdmittedRoleInvocation,
  authority: DurablePrincipalAuthority,
): Promise<void> {
  const { sessionDirectory, sessionFile } = authority.decode(admitted.principal);
  const record = packagedRoleMetadata(admitted.role);
  const workerPhase = record !== undefined && "worker" in record && record.worker === true && "phase" in admitted
    ? admitted.phase
    : undefined;
  await writeRoleRunState(admitted.runDirectory, {
    runId: admitted.runId,
    role: admitted.role,
    state: "admitted",
    bookKey: admitted.bookKey,
    projectRoot: admitted.projectRoot,
    sessionDirectory,
    sessionFile,
    admittedRequestPath: admitted.admittedRequestPath,
    ...(workerPhase === undefined ? {} : { phase: workerPhase }),
  });
}

/**
 * Shared dispatch execution seam: transition to running, then record the
 * effective launch model (initial or resume override) and the authoritative
 * seat engine/host onto invocation.json.
 * Role runners must not coordinate lifecycle ledger writes themselves.
 * Engine axis is authoritative here (#617): present string is written; omit/undefined
 * clears any prior engine key so unset-engine + resume does not keep a stale value.
 * (Non-authoritative partial updates still use recordEffectiveInvocationModel directly
 * with `engine: undefined` to preserve.)
 * Host-page write is deliberately the last step (#840 r9 判词 class 2): this
 * function is not atomic, and a caller retrying after it throws must not see
 * the new host already committed while the run-state transition itself never
 * completed — the run-state write happens first, so any failure past that
 * point still leaves the prior invocation host in place for the retry.
 */
export async function markRunRunning(
  runDirectory: string,
  effectiveModel?: InvocationEffectiveModel,
  effectiveEngine?: string,
  effectiveHost?: string,
  effectiveEngineModel?: string,
): Promise<void> {
  const current = await readRoleRunStateDisk(runDirectory);
  if (current === undefined) {
    throw new Error("cannot mark running: run state missing");
  }
  // Omit resumable while a writer is active. Principal wire is passed through uninterpreted.
  // Preserve open currentCourt across running transitions (#637).
  await writeRoleRunStateDisk(runDirectory, {
    runId: current.runId,
    role: current.role,
    state: "running",
    bookKey: current.bookKey,
    projectRoot: current.projectRoot,
    runDirectory: current.runDirectory,
    admittedRequestPath: current.admittedRequestPath,
    principalWire: current.principalWire,
    ...(current.phase === undefined ? {} : { phase: current.phase }),
    ...(current.currentCourt === undefined ? {} : { currentCourt: current.currentCourt }),
  });
  await recordEffectiveInvocationModel(
    runDirectory,
    effectiveModel,
    // Authoritative seat projection: absent engine ⇒ null (delete).
    effectiveEngine === undefined ? null : effectiveEngine,
    effectiveHost,
    // Authoritative with engine: absent model ⇒ null (delete) when engine axis is written.
    effectiveEngine === undefined
      ? null
      : effectiveEngineModel === undefined
        ? null
        : effectiveEngineModel,
  );
}

/** @deprecated #416: 429-only resumable marker; kept for historical runs. */
export async function markRunResumable(
  runDirectory: string,
  observation: TypedHttp429Observation,
): Promise<void> {
  const current = await readRoleRunStateDisk(runDirectory);
  if (current === undefined) {
    throw new Error("cannot mark resumable: run state missing");
  }
  await writeRoleRunStateDisk(runDirectory, {
    ...current,
    state: "resumable",
    resumable: observation,
  });
}

export async function markRunTerminal(runDirectory: string): Promise<void> {
  const current = await readRoleRunStateDisk(runDirectory);
  if (current === undefined) {
    throw new Error("cannot mark terminal: run state missing");
  }
  // Preserve the open court's settlement identity after a failed/incomplete turn (#637).
  await writeRoleRunStateDisk(runDirectory, {
    runId: current.runId,
    role: current.role,
    state: "terminal",
    bookKey: current.bookKey,
    projectRoot: current.projectRoot,
    runDirectory: current.runDirectory,
    admittedRequestPath: current.admittedRequestPath,
    principalWire: current.principalWire,
    ...(current.phase === undefined ? {} : { phase: current.phase }),
    ...(current.currentCourt === undefined ? {} : { currentCourt: current.currentCourt }),
  });
}

/** Read the open court turn on a retained run, if any (#637). */
export async function readCurrentCourt(
  runDirectory: string,
): Promise<CurrentCourtState | undefined> {
  const current = await readRoleRunStateDisk(runDirectory);
  return current?.currentCourt;
}

/** Persist the open court turn identity + materials (#637). */
export async function recordCurrentCourt(
  runDirectory: string,
  court: CurrentCourtState,
): Promise<void> {
  const current = await readRoleRunStateDisk(runDirectory);
  if (current === undefined) {
    throw new Error("cannot record current court: run state missing");
  }
  await writeRoleRunStateDisk(runDirectory, {
    ...current,
    currentCourt: court,
  });
}

/**
 * Clear open court after this courtAttemptId seals, or when the open court is
 * already sealed (#637). When expectedCourtAttemptId is set, clear only if it
 * still matches — never drop a different court recorded under the writer lease
 * after our judgment.
 */
export async function clearCurrentCourt(
  runDirectory: string,
  expectedCourtAttemptId?: string,
): Promise<void> {
  const current = await readRoleRunStateDisk(runDirectory);
  if (current === undefined || current.currentCourt === undefined) return;
  if (
    expectedCourtAttemptId !== undefined &&
    current.currentCourt.courtAttemptId !== expectedCourtAttemptId
  ) {
    return;
  }
  await writeRoleRunStateDisk(runDirectory, {
    runId: current.runId,
    role: current.role,
    state: current.state,
    bookKey: current.bookKey,
    projectRoot: current.projectRoot,
    runDirectory: current.runDirectory,
    admittedRequestPath: current.admittedRequestPath,
    principalWire: current.principalWire,
    ...(current.phase === undefined ? {} : { phase: current.phase }),
    ...(current.resumable === undefined ? {} : { resumable: current.resumable }),
  });
}

/**
 * True when the host authority reports the durable principal available.
 * Resume must reopen this exact principal; directory-latest is not identity.
 */
export async function isDurablePrincipalAvailable(
  principal: DurablePrincipal,
  authority: DurablePrincipalAuthority,
): Promise<boolean> {
  return authority.isAvailable(principal);
}

export class RunWriterLeaseHeldError extends Error {
  readonly code = "AK_RUN_WRITER_LEASE_HELD" as const;
  constructor(message = "role run writer lease is already held") {
    super(message);
    this.name = "RunWriterLeaseHeldError";
  }
}

export type RunWriterLease = {
  readonly lockPath: string;
  /** Keep lease cleanup anchored when its run is relocated while held. */
  relocate(runDirectory: string): void;
  release(): Promise<void>;
};

/** Kind of a writer-lease diagnostic sent on the existing sink. */
export type WriterLeaseDiagnosticKind = "stale-reclaimed";


/**
 * True error identity for diagnostics — name/code/message as-is, never a
 * guessed label (failure-honesty constitution).
 */
export function describeErrorIdentity(error: unknown): string {
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  const name =
    typeof candidate?.name === "string" && candidate.name !== ""
      ? candidate.name
      : typeof error;
  const code =
    typeof candidate?.code === "string" || typeof candidate?.code === "number"
      ? ` code=${String(candidate.code)}`
      : "";
  const message =
    typeof candidate?.message === "string" && candidate.message !== ""
      ? `: ${candidate.message}`
      : "";
  return `${name}${code}${message}`;
}

function errorCodeOf(error: unknown): unknown {
  return (error as { code?: unknown }).code;
}

/**
 * Signal-0 liveness probe. Only ESRCH proves absence; any other refusal
 * (e.g. EPERM) means the holder process exists.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCodeOf(error) !== "ESRCH";
  }
}


export type WriterLockAutopsy =
  | { verdict: "absent" }
  | { verdict: "unknown"; reason: "unparseable"; content: string }
  | { verdict: "unknown"; reason: "unreadable"; readFailure: unknown }
  | { verdict: "dead"; pid: number }
  | { verdict: "alive"; pid: number };

/**
 * The writer lease holder is the shared authority for current run activity.
 * Only ENOENT proves no holder; malformed or unreadable locks remain unknown
 * because they can be observed while a live creator is writing its pid.
 */
export async function autopsyWriterLock(lockPath: string): Promise<WriterLockAutopsy> {
  let content: string;
  try {
    content = await readFile(lockPath, "utf8");
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") return { verdict: "absent" };
    return { verdict: "unknown", reason: "unreadable", readFailure: error };
  }
  const normalized = content.trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    return { verdict: "unknown", reason: "unparseable", content };
  }
  const pid = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { verdict: "unknown", reason: "unparseable", content };
  }
  return isProcessAlive(pid) ? { verdict: "alive", pid } : { verdict: "dead", pid };
}

function describeAutopsy(autopsy: WriterLockAutopsy): string {
  switch (autopsy.verdict) {
    case "alive":
      return `live pid ${autopsy.pid}`;
    case "dead":
      return `dead pid ${autopsy.pid}`;
    case "absent":
      return "absent holder";
    case "unknown":
      return autopsy.reason === "unreadable" ? "unreadable lock" : "unparseable holder";
  }
}

/**
 * Remove one lock whose re-read autopsy is still a verified-dead holder, or
 * leave it for the next round otherwise. The pre-unlink re-read guard means a
 * concurrent writer that re-locked between the autopsy and the unlink cannot
 * have its live lock stolen. Residual race: a writer can still re-lock between
 * the re-read and the unlink itself; POSIX offers no compare-and-delete, and
 * this narrows the window to a single syscall pair.
 *
 * An EACCES unlink (non-writable run directory) is recovered by restoring the
 * directory permissions only — never by a blind retrying unlink. After the
 * chmod the caller loop re-runs the create/autopsy cycle, so any unlink still
 * follows a fresh verified-dead verdict on the current pathname content; a
 * contender that installed its live lock inside the recovery window reads as
 * alive and is left alone (#629).
 *
 * Returns whether the lock was actually deleted.
 */
async function reclaimStaleWriterLock(
  lockPath: string,
  runDirectory: string,
): Promise<{ reclaimed: boolean; eaccesFailure?: unknown }> {
  const current = await autopsyWriterLock(lockPath);
  if (current.verdict !== "dead") return { reclaimed: false };
  try {
    await unlink(lockPath);
    return { reclaimed: true };
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") return { reclaimed: false };
    if (errorCodeOf(error) !== "EACCES") throw error;
    // Restore directory permissions and drop the round: re-unlinking here
    // without a fresh autopsy could delete a contender's live lock that was
    // installed while the directory was unwritable (#629 TOCTOU).
    await chmod(runDirectory, 0o755);
    // A chmod-proof EACCES (e.g. a deny-delete ACE the mode change cannot
    // clear) recurs every round; hand the identity to the caller so the final
    // stayed-contested refusal can still name the true cause (#629).
    return { reclaimed: false, eaccesFailure: error };
  }
}

async function createWriterLease(
  lockPath: string,
  runDirectory: string,
  reportCleanupFailure: (error: unknown, lockPath: string) => void,
): Promise<RunWriterLease> {
  const handle = await open(lockPath, "wx");
  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
    throw error;
  }
  let released = false;
  let currentRunDirectory = runDirectory;
  let currentLockPath = lockPath;
  return {
    get lockPath() {
      return currentLockPath;
    },
    relocate(nextRunDirectory: string) {
      currentRunDirectory = nextRunDirectory;
      currentLockPath = join(nextRunDirectory, WRITER_LOCK_FILE);
    },
    async release() {
      if (released) return;
      released = true;
      await handle.close().catch(() => undefined);
      try {
        await unlink(currentLockPath);
      } catch (error) {
        if (errorCodeOf(error) === "EACCES") {
          try {
            await chmod(currentRunDirectory, 0o755);
            await unlink(currentLockPath);
          } catch (retryError) {
            reportCleanupFailure(retryError, currentLockPath);
          }
        } else {
          reportCleanupFailure(error, currentLockPath);
        }
      }
    },
  };
}

const WRITER_LEASE_RECLAIM_ROUNDS = 3;

/**
 * Acquire the one-writer lease for a Role run. Exclusive create — no second
 * writer; a concurrent acquire rejects without dispatch.
 *
 * A contested lock gets a holder autopsy before rejection (#552): only a
 * verified-dead holder pid — parseable pid, signal-0 ESRCH, and still dead on
 * the pre-unlink re-read — authorizes reclaim, because no writer is left to
 * release the lock; acquire then retries the create. An empty, unparseable, or
 * unreadable lock proves no dead holder (a live creator is mid-acquisition
 * between the exclusive create and its pid write), so it rejects as
 * RunWriterLeaseHeldError naming the path and the lock stays on disk — a
 * crash-window empty lock blocking a resume is that refusal's known residue,
 * not safely fixable by unlink here. A live holder rejects the same typed
 * error naming the pid and path. A pid recycled by an unrelated process reads
 * as alive — that degrades to the same typed rejection, never worse than the
 * pre-#552 behavior. Reclaim rounds are bounded by
 * WRITER_LEASE_RECLAIM_ROUNDS; a lock that stays contested (e.g. a reclaim
 * race repeatedly lost) surfaces the same typed error instead of spinning.
 * When every round's unlink fails with a chmod-proof EACCES, the final
 * refusal additionally carries the last reclaim failure's error identity so
 * the true cause stays observable (#629).
 *
 * `onCleanupFailure` receives a non-terminal diagnostic line when release-time
 * lock cleanup fails, a contested lock cannot be read, or a stale lock is
 * reclaimed (the #556 orphan-pi residual declaration). Release stays
 * best-effort, but no diagnostic promises that the next acquire reclaims a
 * residual lock: a release-failed residual carries this process's live pid
 * (the next acquire rejects it as held), and an unreadable contested lock is
 * left in place. The true error identity must still land somewhere observable
 * — silent swallowing is forbidden.
 */
export async function acquireRunWriterLease(
  runDirectory: string,
  onCleanupFailure?: (diagnostic: string, kind?: WriterLeaseDiagnosticKind) => void,
): Promise<RunWriterLease> {
  const reportDiagnostic = (diagnostic: string, kind?: WriterLeaseDiagnosticKind): void => {
    const line = diagnostic.endsWith("\n") ? diagnostic : `${diagnostic}\n`;
    try {
      onCleanupFailure?.(line, kind);
    } catch {
      // diagnostic-sink failure is itself best-effort; never break acquire()/release().
    }
  };
  /**
   * Release-time cleanup failure: the release could not remove the lock, so
   * the residual lock (carrying this process's pid) stays on disk — the next
   * acquire reads it as live and rejects; nothing here may promise that the
   * next acquire reclaims it.
   */
  const reportCleanupFailure = (error: unknown, lockPath: string): void => {
    reportDiagnostic(
      `writer lease lock cleanup failed (release is best-effort; residual lock left in place) at ${lockPath}: ${describeErrorIdentity(error)}`,
    );
  };
  /** Contested-lock read failure: nothing was cleaned up; the lock stays exactly where it is. */
  const reportReadFailure = (error: unknown): void => {
    reportDiagnostic(
      `writer lease lock read failed (holder liveness unverifiable; lock left in place) at ${join(runDirectory, WRITER_LOCK_FILE)}: ${describeErrorIdentity(error)}`,
    );
  };
  const lockPath = join(runDirectory, WRITER_LOCK_FILE);
  let lastAutopsy: WriterLockAutopsy = { verdict: "absent" };
  let lastReclaimFailure: unknown;
  for (let reclaimsLeft = WRITER_LEASE_RECLAIM_ROUNDS; ; reclaimsLeft -= 1) {
    try {
      return await createWriterLease(lockPath, runDirectory, reportCleanupFailure);
    } catch (error) {
      if (errorCodeOf(error) !== "EEXIST") throw error;
    }
    lastAutopsy = await autopsyWriterLock(lockPath);
    if (lastAutopsy.verdict === "unknown" && lastAutopsy.reason === "unreadable") {
      reportReadFailure(lastAutopsy.readFailure);
    }
    if (lastAutopsy.verdict === "alive") {
      throw new RunWriterLeaseHeldError(
        `role run writer lease is already held by live pid ${lastAutopsy.pid} at ${lockPath}`,
      );
    }
    if (lastAutopsy.verdict === "unknown") {
      throw new RunWriterLeaseHeldError(
        lastAutopsy.reason === "unreadable"
          ? `role run writer lease lock is unreadable at ${lockPath}: ${describeErrorIdentity(lastAutopsy.readFailure)}; holder liveness unverifiable, lock left in place`
          : `role run writer lease lock at ${lockPath} has no verifiable holder pid (empty or unparseable); holder liveness unverifiable, lock left in place`,
      );
    }
    if (lastAutopsy.verdict === "absent") {
      throw new RunWriterLeaseHeldError(
        `role run writer lease disappeared before holder autopsy at ${lockPath}`,
      );
    }
    if (reclaimsLeft <= 0) break;
    let reclaimed = false;
    try {
      const outcome = await reclaimStaleWriterLock(lockPath, runDirectory);
      reclaimed = outcome.reclaimed;
      if (!reclaimed && outcome.eaccesFailure !== undefined) {
        lastReclaimFailure = outcome.eaccesFailure;
      }
    } catch (reclaimError) {
      throw new RunWriterLeaseHeldError(
        `stale writer lease reclaim failed at ${lockPath} (autopsy: ${describeAutopsy(lastAutopsy)}): ${describeErrorIdentity(reclaimError)}`,
      );
    }
    if (reclaimed) {
      reportDiagnostic(
        `stale writer lease reclaimed at ${lockPath} (holder pid ${lastAutopsy.pid} verified dead): the killed holder may have left an orphaned pi child still writing this run — check for a surviving pi process on this run before continuing`,
        "stale-reclaimed",
      );
    }
  }
  throw new RunWriterLeaseHeldError(
    lastReclaimFailure !== undefined
      ? `role run writer lease stayed contested at ${lockPath} after ${WRITER_LEASE_RECLAIM_ROUNDS} reclaims (last autopsy: ${describeAutopsy(lastAutopsy)}; last reclaim failure: ${describeErrorIdentity(lastReclaimFailure)})`
      : `role run writer lease stayed contested at ${lockPath} after ${WRITER_LEASE_RECLAIM_ROUNDS} reclaims (last autopsy: ${describeAutopsy(lastAutopsy)})`,
  );
}

/**
 * Locate a Role run directory by run ID under the ledger books home.
 * Returns undefined when the ID is unknown.
 * Walk surface = listBookRunDirectories (flat legacy + subject-tree).
 * Collects every match under the supplied book/role filters: zero → undefined,
 * one → path, many → loud ambiguity (never readdir-first).
 */
export async function findRunDirectoryById(
  home: string | undefined,
  runId: string,
  onlyBookKey?: string,
  onlyRole?: string,
): Promise<string | undefined> {
  if (runId.trim() === "") return undefined;
  const ledgerHome = resolveActivationLedgerHome(home);
  const booksRoot = join(ledgerHome, "books");
  let bookKeys: string[];
  try {
    bookKeys = await readdir(booksRoot);
  } catch (error) {
    // Only a missing books root is "unknown id"; permission/IO damage propagates.
    if (errorCodeOf(error) === "ENOENT") return undefined;
    throw error;
  }
  const matches: string[] = [];
  for (const bookKey of bookKeys) {
    if (onlyBookKey !== undefined && bookKey !== onlyBookKey) continue;
    const bookDir = activationBookDirectory(ledgerHome, bookKey);
    let runDirectories: string[];
    try {
      runDirectories = await listBookRunDirectories(bookDir);
    } catch (error) {
      if (errorCodeOf(error) === "ENOENT") continue;
      throw error;
    }
    for (const runDirectory of runDirectories) {
      const entry = basename(runDirectory);
      if (
        (onlyRole === undefined && (entry === `${runId}@judge` || entry.startsWith(`${runId}@`))) ||
        entry === `${runId}@${onlyRole}`
      ) {
        matches.push(runDirectory);
      }
    }
  }
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];
  throw new Error(
    `ambiguous role run id ${runId}: ${matches.join(", ")}`,
  );
}

/** Code-owned gate inspector summons prefix (public-role-summons / #747). */
export const GATE_DOSSIER_POINTER_PREFIX = "卷宗指针：" as const;

/** Parent path from a code-owned inspector 卷宗指针 instruction; else undefined. */
export function parentRunPathFromGatePointerInstruction(
  instruction: string,
): string | undefined {
  if (!instruction.startsWith(GATE_DOSSIER_POINTER_PREFIX)) return undefined;
  const path = instruction.slice(GATE_DOSSIER_POINTER_PREFIX.length).trim();
  return path === "" ? undefined : path;
}

/**
 * Parent-run binding on a retained officer run (#747).
 * Notary/auditor: typed sourceRunPath. Inspector: exact code-owned 卷宗指针 instruction.
 * Missing page → undefined; damage / non-ENOENT IO propagates.
 */
export async function readRunParentPath(
  runDirectory: string,
): Promise<string | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(
      await readFile(join(runDirectory, "admitted-request.json"), "utf8"),
    );
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") return undefined;
    throw error;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.sourceRunPath === "string" && record.sourceRunPath.trim() !== "") {
    return record.sourceRunPath;
  }
  if (typeof record.instruction === "string") {
    return parentRunPathFromGatePointerInstruction(record.instruction);
  }
  return undefined;
}

/**
 * True when durable run-state names a session principal that has actually formed
 * (session file present as a real file). Provisional runs relocated+terminalized
 * before dispatch never form one — same-ticket lookup must skip them so a newer
 * abandoned mint cannot eclipse an older resumable principal (#859).
 * Not a terminal-state gate: ADR/#416 allows terminal resume when principal exists.
 */
async function runHasFormedSessionPrincipal(runDirectory: string): Promise<boolean> {
  const disk = await readRoleRunStateDisk(runDirectory);
  if (disk === undefined) return false;
  const sessionFile =
    typeof disk.principalWire.sessionFile === "string" &&
    disk.principalWire.sessionFile.trim() !== ""
      ? disk.principalWire.sessionFile
      : join(disk.principalWire.sessionDirectory, "session.jsonl");
  try {
    const stat = await lstat(sessionFile);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    // Absent session file → not formed; permission/IO/damage keeps identity.
    if (errorCodeOf(error) === "ENOENT") return false;
    throw error;
  }
}

/**
 * Locate the latest retained run for one seat under a book (#637 / #747).
 * Same walk surface as findRunDirectoryById (listBookRunDirectories). Match by
 * parent run path (officer / gate seats, #747 / #987). A typed ticket number
 * does not select a run. runId is UUIDv7 — lexicographic max is latest among
 * runs that formed a session principal. No parallel index. Public ticket-number
 * selection of a prior run was deleted (#987 Result 7); callers use explicit
 * `ak-role resume <runId>`.
 * Only a truly missing book directory means no history; damage/permission errors propagate.
 */
export async function findLatestRunIdForSeatTicket(input: {
  readonly home: string;
  readonly bookKey: string;
  readonly role: RoleRunRecord["role"];
  readonly parentRunPath: string;
}): Promise<string | undefined> {
  if (input.parentRunPath.trim() === "") {
    return undefined;
  }
  const ledgerHome = resolveActivationLedgerHome(input.home);
  const bookDir = activationBookDirectory(ledgerHome, input.bookKey);
  let runDirectories: string[];
  try {
    runDirectories = await listBookRunDirectories(bookDir);
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") return undefined;
    throw error;
  }
  const suffix = `@${input.role}`;
  let best: string | undefined;
  for (const runDirectory of runDirectories) {
    const entry = basename(runDirectory);
    if (!entry.endsWith(suffix)) continue;
    const runId = entry.slice(0, entry.length - suffix.length);
    if (runId.length === 0) continue;
    const parentPath = await readRunParentPath(runDirectory);
    if (parentPath !== input.parentRunPath) continue;
    // Durable fact: never resume-select a provisional that never formed principal.
    if (!(await runHasFormedSessionPrincipal(runDirectory))) continue;
    if (best === undefined || runId > best) best = runId;
  }
  return best;
}

type LoadedAdmittedRequestFields = {
  readonly instruction: string;
  readonly instructionEmpty: boolean;
  readonly attachments: FrozenAttachment[];
  readonly phase?: CoderPhase | FixerPhase;
  readonly taskPath?: string;
  readonly packetPath?: string;
  readonly prerequisitesPath?: string;
  readonly prerequisites?: readonly FixerPrerequisite[];
  readonly baseRevision?: string;
  readonly lens?: ReviewerLens;
  readonly authorityRefs?: readonly string[];
  readonly mergerInputPath?: string;
  readonly derived?: DerivedMergerEnvelope;
  readonly correlationId?: string;
  readonly ticketNumber?: number;
  /** #871 typed co-review set restored on countersign resume. */
  readonly courtTicketNumbers?: readonly number[];
  /**
   * #871 durable set present-but-damaged diagnostic. Countersign resume settles
   * controlled failure with this text; not a structural usage rejection.
   */
  readonly courtTicketNumbersDamage?: string;
  /** Collector — admitted repository/PR identity restored on resume (#633). */
  readonly prNumber?: number;
  readonly repository?: string;
  readonly repositoryDisplay?: string;
  readonly requestManifestPath?: string;
  readonly manifestDigest?: string;
  /** Collector wait-window ms restored on resume (#678). */
  readonly waitWindowMs?: number;
  /** Doctor — admitted single-case identity restored on resume (#633). */
  readonly issueNumber?: number;
  readonly caseRunsPath?: string;
  readonly caseIdentity?: DoctorCaseIdentity;
  /** Notary — admitted source-run locator restored on resume (#633). */
  readonly sourceRunPath?: string;
  readonly sourceRun?: NotarySourceRunLocator;
  /** Effective model restored from the invocation identity page on resume. */
  readonly model?: InvocationEffectiveModel;
};

/** Restore optional correlation + typed main-ticket identity from a durable page. */
function parsePersistedTicketIdentity(
  record: Record<string, unknown>,
): {
  correlationId?: string;
  ticketNumber?: number;
} {
  const correlationId =
    typeof record.correlationId === "string" && record.correlationId.trim() !== ""
      ? record.correlationId
      : undefined;
  const ticketNumber = isSafePositiveTicketNumber(record.ticketNumber)
    ? record.ticketNumber
    : undefined;
  return {
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(ticketNumber === undefined ? {} : { ticketNumber }),
  };
}

/**
 * #871 durable set from one run page.
 * Absent → absent. Present damage keeps the original reason (no throw here).
 */
function readDurableCourtTicketNumbersPage(
  record: Record<string, unknown>,
  principalTicket: number | undefined,
  pageLabel: string,
):
  | { readonly kind: "absent" }
  | { readonly kind: "ok"; readonly tickets: readonly number[] }
  | { readonly kind: "damage"; readonly reason: string } {
  const interpreted = interpretDurableCourtTicketNumbers(record, {
    ...(principalTicket === undefined ? {} : { principalTicket }),
  });
  if (interpreted.kind === "damage") {
    return {
      kind: "damage",
      reason: `role run ${pageLabel} courtTicketNumbers is damaged: ${interpreted.reason}`,
    };
  }
  if (interpreted.kind === "ok") {
    return { kind: "ok", tickets: interpreted.tickets };
  }
  return { kind: "absent" };
}

/**
 * Merge admitted + invocation #871 sets.
 * Both present must match; one present wins; both absent stays legacy.
 * Damage / cross-page mismatch return a diagnostic — countersign resume settles
 * controlled failure; load itself does not structural-reject.
 */
function mergeDurableCourtTicketNumbers(input: {
  readonly admittedRecord: Record<string, unknown> | undefined;
  readonly invocationRecord: Record<string, unknown> | undefined;
  readonly principalTicket: number | undefined;
}):
  | { readonly kind: "ok"; readonly tickets?: readonly number[] }
  | { readonly kind: "damage"; readonly reason: string } {
  const fromAdmitted =
    input.admittedRecord === undefined
      ? ({ kind: "absent" } as const)
      : readDurableCourtTicketNumbersPage(
          input.admittedRecord,
          input.principalTicket,
          "admitted-request",
        );
  const fromInvocation =
    input.invocationRecord === undefined
      ? ({ kind: "absent" } as const)
      : readDurableCourtTicketNumbersPage(
          input.invocationRecord,
          input.principalTicket,
          "invocation",
        );
  if (fromAdmitted.kind === "damage") return fromAdmitted;
  if (fromInvocation.kind === "damage") return fromInvocation;
  if (fromAdmitted.kind === "ok" && fromInvocation.kind === "ok") {
    if (!sameCourtTicketNumbers(fromAdmitted.tickets, fromInvocation.tickets)) {
      return {
        kind: "damage",
        reason:
          "role run courtTicketNumbers differs between admitted-request and invocation",
      };
    }
    return { kind: "ok", tickets: fromAdmitted.tickets };
  }
  if (fromAdmitted.kind === "ok") return { kind: "ok", tickets: fromAdmitted.tickets };
  if (fromInvocation.kind === "ok") return { kind: "ok", tickets: fromInvocation.tickets };
  return { kind: "ok" };
}

function restoredTicketFields(fields: LoadedAdmittedRequestFields): {
  correlationId?: string;
  ticketNumber?: number;
  courtTicketNumbers?: readonly number[];
} {
  return {
    ...(fields.correlationId === undefined ? {} : { correlationId: fields.correlationId }),
    ...(fields.ticketNumber === undefined ? {} : { ticketNumber: fields.ticketNumber }),
    ...(fields.courtTicketNumbers === undefined
      ? {}
      : { courtTicketNumbers: fields.courtTicketNumbers }),
  };
}

async function loadResumableRunRecord(
  home: string,
  runId: string,
  authority: DurablePrincipalAuthority,
): Promise<{
  readonly run: RoleRunRecord;
  readonly principal: DurablePrincipal;
  readonly observation?: TypedHttp429Observation;
  readonly admittedFields: LoadedAdmittedRequestFields;
}> {
  const runDirectory = await findRunDirectoryById(home, runId);
  if (runDirectory === undefined) {
    throw new CliUsageError(`unknown role run id: ${runId}`);
  }
  const disk = await readRoleRunStateDisk(runDirectory);
  if (disk === undefined) {
    throw new CliUsageError(`unknown role run id: ${runId}`);
  }
  // #416: removed terminal/resumable gates per owner decision "根本不要有限制" (2026-08-22).
  // Only the exact Pi session principal check remains as honest failure.
  // One authority.decode of the uninterpreted wire yields both principal and record.
  const materialized = materializeRoleRunFromDisk(disk, authority);
  if (materialized === undefined) {
    throw new CliUsageError(`unknown role run id: ${runId}`);
  }
  const { run, principal } = materialized;
  if (!(await isDurablePrincipalAvailable(principal, authority))) {
    throw new CliUsageError(
      `role run Pi session principal is unavailable: ${runId}`,
    );
  }
  // Reconstruct admitted identity from durable run record + admitted-request.json.
  let instruction = "";
  let instructionEmpty = true;
  let attachments: FrozenAttachment[] = [];
  let phase: CoderPhase | FixerPhase | undefined;
  let taskPath: string | undefined;
  let packetPath: string | undefined;
  let prerequisitesPath: string | undefined;
  let prerequisites: readonly FixerPrerequisite[] | undefined;
  let baseRevision: string | undefined;
  let lens: ReviewerLens | undefined;
  let authorityRefs: readonly string[] | undefined;
  let mergerInputPath: string | undefined;
  let derived: DerivedMergerEnvelope | undefined;
  let correlationId: string | undefined;
  let ticketNumber: number | undefined;
  let courtTicketNumbers: readonly number[] | undefined;
  let courtTicketNumbersDamage: string | undefined;
  let admittedIdentityRecord: Record<string, unknown> | undefined;
  let invocationIdentityRecord: Record<string, unknown> | undefined;
  let prNumber: number | undefined;
  let repository: string | undefined;
  let repositoryDisplay: string | undefined;
  let requestManifestPath: string | undefined;
  let manifestDigest: string | undefined;
  let waitWindowMs: number | undefined;
  let issueNumber: number | undefined;
  let caseRunsPath: string | undefined;
  let caseIdentity: DoctorCaseIdentity | undefined;
  let sourceRunPath: string | undefined;
  let sourceRun: NotarySourceRunLocator | undefined;
  try {
    const raw: unknown = JSON.parse(
      await readFile(run.admittedRequestPath, "utf8"),
    );
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      const record = raw as Record<string, unknown>;
      const storedRunDirectory =
        typeof record.runDirectory === "string" && record.runDirectory.trim() !== ""
          ? record.runDirectory
          : run.runDirectory;
      rewriteAdmittedRoleRunPage(record, [{
        oldRunDirectory: storedRunDirectory,
        newRunDirectory: run.runDirectory,
      }]);
      if (typeof record.instruction === "string") {
        instruction = record.instruction;
      }
      if (typeof record.instructionEmpty === "boolean") {
        instructionEmpty = record.instructionEmpty;
      }
      if (Array.isArray(record.attachments)) {
        attachments = record.attachments as FrozenAttachment[];
      }
      if (record.phase === "plan" || record.phase === "apply") {
        phase = record.phase;
      }
      if (typeof record.taskPath === "string" && record.taskPath.trim() !== "") {
        taskPath = record.taskPath;
      }
      if (typeof record.packetPath === "string" && record.packetPath.trim() !== "") {
        packetPath = record.packetPath;
      }
      if (
        typeof record.prerequisitesPath === "string" &&
        record.prerequisitesPath.trim() !== ""
      ) {
        prerequisitesPath = record.prerequisitesPath;
      }
      if (Array.isArray(record.prerequisites)) {
        prerequisites = record.prerequisites as FixerPrerequisite[];
      }
      if (
        typeof record.baseRevision === "string" &&
        record.baseRevision.trim() !== ""
      ) {
        baseRevision = record.baseRevision;
      }
      if (isReviewerLens(record.lens)) {
        lens = record.lens;
      }
      // Collector — admitted repository/PR identity (#633 resume).
      if (typeof record.prNumber === "number" && Number.isSafeInteger(record.prNumber) && record.prNumber >= 1) {
        prNumber = record.prNumber;
      }
      if (typeof record.repository === "string" && record.repository.trim() !== "") {
        repository = record.repository;
      }
      if (typeof record.repositoryDisplay === "string" && record.repositoryDisplay.trim() !== "") {
        repositoryDisplay = record.repositoryDisplay;
      }
      if (typeof record.requestManifestPath === "string" && record.requestManifestPath.trim() !== "") {
        requestManifestPath = record.requestManifestPath;
      }
      if (typeof record.manifestDigest === "string" && record.manifestDigest.trim() !== "") {
        manifestDigest = record.manifestDigest;
      }
      if (typeof record.waitWindowMs === "number" && Number.isSafeInteger(record.waitWindowMs) && record.waitWindowMs >= 1) {
        waitWindowMs = record.waitWindowMs;
      }
      // Doctor — admitted single-case identity (#633 resume).
      if (typeof record.issueNumber === "number" && Number.isSafeInteger(record.issueNumber) && record.issueNumber >= 1) {
        issueNumber = record.issueNumber;
      }
      if (typeof record.caseRunsPath === "string" && record.caseRunsPath.trim() !== "") {
        caseRunsPath = record.caseRunsPath;
      }
      if (
        record.caseIdentity !== null &&
        typeof record.caseIdentity === "object" &&
        !Array.isArray(record.caseIdentity)
      ) {
        const ci = record.caseIdentity as Record<string, unknown>;
        if (
          typeof ci.issueNumber === "number" &&
          Number.isSafeInteger(ci.issueNumber) &&
          ci.issueNumber >= 1 &&
          typeof ci.runsPath === "string" &&
          ci.runsPath.trim() !== ""
        ) {
          caseIdentity = { issueNumber: ci.issueNumber, runsPath: ci.runsPath };
        }
      }
      // Notary — admitted source-run locator identity (#633 resume).
      if (typeof record.sourceRunPath === "string" && record.sourceRunPath.trim() !== "") {
        sourceRunPath = record.sourceRunPath;
      }
      if (
        record.sourceRun !== null &&
        typeof record.sourceRun === "object" &&
        !Array.isArray(record.sourceRun)
      ) {
        const sr = record.sourceRun as Record<string, unknown>;
        if (
          typeof sr.runId === "string" &&
          sr.runId.trim() !== "" &&
          typeof sr.role === "string" &&
          sr.role.trim() !== "" &&
          typeof sr.runDirectory === "string" &&
          sr.runDirectory.trim() !== ""
        ) {
          sourceRun = {
            runId: sr.runId,
            role: sr.role,
            runDirectory: sr.runDirectory,
          };
        }
      }
      if (Array.isArray(record.authorityRefs)) {
        // Reuse unique --authority-ref grammar; blank/inline prose must not resume as authority.
        authorityRefs = Object.freeze(
          record.authorityRefs.map((ref) => {
            if (typeof ref !== "string") {
              throw new CliUsageError(
                "role run admitted authority refs must be durable reference strings",
              );
            }
            return requireAuthorityRef(ref);
          }),
        );
      }
      if (
        typeof record.mergerInputPath === "string" &&
        record.mergerInputPath.trim() !== ""
      ) {
        mergerInputPath = record.mergerInputPath;
      }
      if (
        record.derived !== null &&
        typeof record.derived === "object" &&
        !Array.isArray(record.derived)
      ) {
        const d = record.derived as Record<string, unknown>;
        if (
          typeof d.targetObjectId === "string" &&
          typeof d.sourceObjectId === "string" &&
          Array.isArray(d.expectedConflictPaths) &&
          Array.isArray(d.resolutionScope) &&
          d.expectedConflictPaths.every((p) => typeof p === "string") &&
          d.resolutionScope.every((p) => typeof p === "string")
        ) {
          derived = {
            targetObjectId: d.targetObjectId,
            sourceObjectId: d.sourceObjectId,
            expectedConflictPaths: d.expectedConflictPaths as string[],
            resolutionScope: d.resolutionScope as string[],
          };
        }
      }
      admittedIdentityRecord = record;
      const fromAdmitted = parsePersistedTicketIdentity(record);
      correlationId = fromAdmitted.correlationId;
      ticketNumber = fromAdmitted.ticketNumber;
    }
  } catch (error) {
    // Preserve unique --authority-ref grammar failures; do not collapse to unreadable.
    if (error instanceof CliUsageError) throw error;
    throw new CliUsageError(
      `role run admitted request is unreadable: ${runId}`,
      { cause: error },
    );
  }
  let model: InvocationEffectiveModel | undefined;
  try {
    const invocationRaw: unknown = JSON.parse(
      await readFile(join(run.runDirectory, "invocation.json"), "utf8"),
    );
    if (
      invocationRaw !== null &&
      typeof invocationRaw === "object" &&
      !Array.isArray(invocationRaw)
    ) {
      const rec = invocationRaw as Record<string, unknown>;
      invocationIdentityRecord = rec;
      if (typeof rec.provider === "string" && typeof rec.model === "string") {
        model = {
          provider: rec.provider,
          model: rec.model,
          ...(typeof rec.thinking === "string"
            ? { thinking: rec.thinking as PublicThinkingLevel }
            : {}),
        };
      }
      if (correlationId === undefined || ticketNumber === undefined) {
        const fromInvocation = parsePersistedTicketIdentity(rec);
        if (correlationId === undefined) correlationId = fromInvocation.correlationId;
        if (ticketNumber === undefined) ticketNumber = fromInvocation.ticketNumber;
      }
    }
  } catch (error) {
    if (
      error instanceof CliUsageError
    ) {
      throw error;
    }
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      )
    ) {
      throw new CliUsageError(
        `role run invocation identity is unreadable: ${runId}`,
        { cause: error },
      );
    }
  }
  // #871: resolve set after main ticket so principal membership can be checked.
  // Present-but-damaged / cross-page mismatch keep diagnostic for countersign
  // controlled-failure; both-absent stays legacy; single lawful page restores.
  const mergedSet = mergeDurableCourtTicketNumbers({
    admittedRecord: admittedIdentityRecord,
    invocationRecord: invocationIdentityRecord,
    principalTicket: ticketNumber,
  });
  if (mergedSet.kind === "damage") {
    courtTicketNumbersDamage = mergedSet.reason;
  } else if (mergedSet.tickets !== undefined) {
    courtTicketNumbers = mergedSet.tickets;
  }
  const sourceRunLeaf = basename(sourceRunPath ?? "").split("@");
  const referencedRunId = sourceRun?.runId ?? sourceRunLeaf[0];
  const referencedRole = sourceRun?.role ?? sourceRunLeaf[1];
  if (referencedRunId !== undefined && referencedRunId !== "") {
    const currentSourceRunDirectory = await findRunDirectoryById(
      home,
      referencedRunId,
      run.bookKey,
      referencedRole,
    );
    if (currentSourceRunDirectory !== undefined) {
      sourceRunPath = currentSourceRunDirectory;
      if (sourceRun !== undefined) {
        sourceRun = { ...sourceRun, runDirectory: currentSourceRunDirectory };
      }
    }
  }
  return {
    run,
    principal,
    ...(run.resumable === undefined ? {} : { observation: run.resumable }),
    admittedFields: {
      instruction,
      instructionEmpty,
      attachments,
      ...(phase === undefined ? {} : { phase }),
      ...(taskPath === undefined ? {} : { taskPath }),
      ...(packetPath === undefined ? {} : { packetPath }),
      ...(prerequisitesPath === undefined ? {} : { prerequisitesPath }),
      ...(prerequisites === undefined ? {} : { prerequisites }),
      ...(baseRevision === undefined ? {} : { baseRevision }),
      ...(lens === undefined ? {} : { lens }),
      ...(authorityRefs === undefined ? {} : { authorityRefs }),
      ...(mergerInputPath === undefined ? {} : { mergerInputPath }),
      ...(derived === undefined ? {} : { derived }),
      ...(correlationId === undefined ? {} : { correlationId }),
      ...(ticketNumber === undefined ? {} : { ticketNumber }),
      ...(courtTicketNumbers === undefined ? {} : { courtTicketNumbers }),
      ...(courtTicketNumbersDamage === undefined
        ? {}
        : { courtTicketNumbersDamage }),
      ...(prNumber === undefined ? {} : { prNumber }),
      ...(repository === undefined ? {} : { repository }),
      ...(repositoryDisplay === undefined ? {} : { repositoryDisplay }),
      ...(requestManifestPath === undefined ? {} : { requestManifestPath }),
      ...(manifestDigest === undefined ? {} : { manifestDigest }),
      ...(waitWindowMs === undefined ? {} : { waitWindowMs }),
      ...(issueNumber === undefined ? {} : { issueNumber }),
      ...(caseRunsPath === undefined ? {} : { caseRunsPath }),
      ...(caseIdentity === undefined ? {} : { caseIdentity }),
      ...(sourceRunPath === undefined ? {} : { sourceRunPath }),
      ...(sourceRun === undefined ? {} : { sourceRun }),
      ...(model === undefined ? {} : { model }),
    },
  };
}

/**
 * Base admitted projection: durable identity, instruction, attachments, principal, ticket, and model.
 * Seat restore adds only that seat's fields.
 */
function resumedBaseAdmitted(loaded: {
  readonly run: RoleRunRecord;
  readonly principal: DurablePrincipal;
  readonly admittedFields: LoadedAdmittedRequestFields;
}) {
  return {
    runId: loaded.run.runId,
    bookKey: loaded.run.bookKey,
    projectRoot: loaded.run.projectRoot,
    instruction: loaded.admittedFields.instruction,
    instructionEmpty: loaded.admittedFields.instructionEmpty,
    attachments: loaded.admittedFields.attachments,
    runDirectory: loaded.run.runDirectory,
    principal: loaded.principal,
    admittedRequestPath: loaded.run.admittedRequestPath,
    ...(loaded.admittedFields.model === undefined ? {} : { model: loaded.admittedFields.model }),
    ...restoredTicketFields(loaded.admittedFields),
  };
}

/** Loaded-run envelope. */
function seatLoadedResult<R extends AdmittedRoleInvocation>(
  loaded: {
    readonly run: RoleRunRecord;
    readonly observation?: TypedHttp429Observation;
  },
  admitted: R,
): { admitted: R; run: RoleRunRecord; observation?: TypedHttp429Observation } {
  return {
    admitted,
    run: loaded.run,
    ...(loaded.observation === undefined ? {} : { observation: loaded.observation }),
  };
}


export async function peekRoleRunRole(
  home: string,
  runId: string,
): Promise<
  | "judge"
  | "coder"
  | "fixer"
  | "collector"
  | "doctor"
  | "reviewer"
  | "merger"
  | "notary"
  | "countersign"
  | "gleaner-left"
  | "inspector"
  | "gatekeeper"
  | "navigator"
  | "auditor"
  | "diarist"
  | "secretariat"
  | undefined
> {
  const runDirectory = await findRunDirectoryById(home, runId);
  if (runDirectory === undefined) return undefined;
  const run = await readRoleRunIdentity(runDirectory);
  return run?.role;
}


export type LoadedResumablePublicRole = {
  readonly admitted: AdmittedRoleInvocation;
  readonly run: RoleRunRecord;
  readonly observation?: TypedHttp429Observation;
};

/**
 * One resume load. The caller supplies the package run id; the disk role
 * selects the existing restore checks. The stored native host session id is
 * read on the public explicit resume seam, not from this load.
 */
export async function loadResumablePublicRole(
  home: string,
  runId: string,
  authority: DurablePrincipalAuthority,
): Promise<LoadedResumablePublicRole> {
  const loaded = await loadResumableRunRecord(home, runId, authority);
  return seatLoadedResult(loaded, admitResumedRole(loaded));
}

/**
 * One resume restore. Admission kind comes from the composition-root record;
 * seat-only required fields stay on that kind. Instruction seats share one face.
 */
function admitResumedRole(loaded: {
  readonly run: RoleRunRecord;
  readonly principal: DurablePrincipal;
  readonly observation?: TypedHttp429Observation;
  readonly admittedFields: LoadedAdmittedRequestFields;
}): AdmittedRoleInvocation {
  const role = loaded.run.role;
  const runId = loaded.run.runId;
  const record = packagedRoleMetadata(role);
  if (record === undefined) {
    throw new CliUsageError(`unknown role: ${role}`);
  }
  const fields = loaded.admittedFields;
  const base = resumedBaseAdmitted(loaded);
  switch (record.admission) {
    case "instruction": {
      if (packagedResumeSourcePath(role)) {
        const admitted: AdmittedInspectorInvocation = {
          role: "inspector",
          ...base,
          ...(fields.sourceRunPath === undefined
            ? {}
            : { sourceRunPath: fields.sourceRunPath }),
        };
        return admitted;
      }
      return {
        role,
        ...base,
      } as AdmittedRoleInvocation;
    }
    case "court-materials": {
      const admitted: AdmittedCountersignInvocation = {
        role: "countersign",
        ...base,
        ...(base.courtTicketNumbers === undefined
          ? {}
          : { courtTicketNumbers: base.courtTicketNumbers }),
        ...(fields.courtTicketNumbersDamage === undefined
          ? {}
          : { courtTicketNumbersDamage: fields.courtTicketNumbersDamage }),
      };
      return admitted;
    }
    case "worker-task": {
      const phase = resumedWorkerPhase(fields.phase ?? loaded.run.phase, record.phases, role, runId);
      const taskPath = fields.taskPath;
      if (taskPath === undefined) {
        throw new CliUsageError(
          `role run admitted coder task path is missing: ${runId}`,
        );
      }
      if (fields.instruction.trim() === "") {
        throw new CliUsageError(
          `role run admitted coder task is blank: ${runId}`,
        );
      }
      const admitted: AdmittedCoderInvocation = {
        role: "coder",
        phase,
        ...base,
        instructionEmpty: false,
        taskPath,
      };
      return admitted;
    }
    case "worker-packet": {
      const phase = resumedWorkerPhase(fields.phase ?? loaded.run.phase, record.phases, role, runId);
      const packetPath = fields.packetPath;
      if (packetPath === undefined) {
        throw new CliUsageError(
          `role run admitted fixer packet path is missing: ${runId}`,
        );
      }
      if (fields.instruction.trim() === "") {
        throw new CliUsageError(
          `role run admitted fixer instruction is blank: ${runId}`,
        );
      }
      const prerequisites = fields.prerequisites ?? Object.freeze([]);
      const admitted: AdmittedFixerInvocation = {
        role: "fixer",
        phase,
        ...base,
        instructionEmpty: false,
        packetPath,
        ...(fields.prerequisitesPath === undefined
          ? {}
          : { prerequisitesPath: fields.prerequisitesPath }),
        prerequisites,
      };
      return admitted;
    }
    case "review-basis": {
      const rawBase = fields.baseRevision;
      if (rawBase === undefined || rawBase.trim() === "") {
        throw new CliUsageError(
          `role run admitted reviewer base revision is missing: ${runId}`,
        );
      }
      if (/\s/.test(rawBase) || rawBase.startsWith("-")) {
        throw new CliUsageError(
          `role run admitted reviewer base revision is damaged: ${runId}`,
        );
      }
      const lens = fields.lens;
      if (!isReviewerLens(lens)) {
        throw new CliUsageError(
          `role run admitted reviewer lens is missing: ${runId}`,
        );
      }
      const authorityRefs = Object.freeze([...(fields.authorityRefs ?? [])]);
      if (authorityRefs.length === 0) {
        throw new CliUsageError(
          `role run admitted reviewer authority refs are missing: ${runId}`,
        );
      }
      const admitted: AdmittedReviewerInvocation = {
        role: "reviewer",
        ...base,
        baseRevision: rawBase,
        lens,
        authorityRefs,
      };
      return admitted;
    }
    case "gleaner": {
      const baseRevision = fields.baseRevision;
      if (baseRevision === undefined || baseRevision.trim() === "") {
        throw new CliUsageError(
          `role run admitted gleaner-left base revision is missing: ${runId}`,
        );
      }
      const admitted: AdmittedGleanerLeftInvocation = {
        role: "gleaner-left",
        ...base,
        baseRevision,
      };
      return admitted;
    }
    case "merge-envelope": {
      const mergerInputPath = fields.mergerInputPath;
      if (mergerInputPath === undefined) {
        throw new CliUsageError(
          `role run admitted merger input path is missing: ${runId}`,
        );
      }
      const derived = fields.derived;
      if (derived === undefined) {
        throw new CliUsageError(
          `role run admitted merger envelope is missing: ${runId}`,
        );
      }
      if (fields.instruction.trim() === "") {
        throw new CliUsageError(
          `role run admitted merger task is blank: ${runId}`,
        );
      }
      const admitted: AdmittedMergerInvocation = {
        role: "merger",
        ...base,
        instructionEmpty: false,
        mergerInputPath,
        derived,
      };
      return admitted;
    }
    case "collect-target": {
      const { prNumber, repository, repositoryDisplay, manifestDigest } = fields;
      if (
        repository === undefined ||
        repositoryDisplay === undefined ||
        manifestDigest === undefined
      ) {
        throw new CliUsageError(
          `role run admitted collector repository identity is missing: ${runId}`,
        );
      }
      let parsedRepository;
      try {
        parsedRepository = parseCollectorRepository(repositoryDisplay);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new CliUsageError(detail, { cause: error });
      }
      if (parsedRepository.canonical !== repository) {
        throw new CliUsageError(
          `role run admitted collector repository does not match its canonical form: ${runId}`,
        );
      }
      const admitted: AdmittedCollectorInvocation = {
        role: "collector",
        ...base,
        ...(prNumber === undefined ? {} : { prNumber }),
        repository: parsedRepository,
        ...(fields.requestManifestPath === undefined
          ? {}
          : { requestManifestPath: fields.requestManifestPath }),
        ...(fields.waitWindowMs === undefined ? {} : { waitWindowMs: fields.waitWindowMs }),
        manifestDigest,
      };
      return admitted;
    }
    case "case-identity": {
      const { issueNumber, caseRunsPath, caseIdentity } = fields;
      if (
        issueNumber === undefined ||
        caseRunsPath === undefined ||
        caseIdentity === undefined
      ) {
        throw new CliUsageError(
          `role run admitted doctor case identity is missing: ${runId}`,
        );
      }
      const admitted: AdmittedDoctorInvocation = {
        role: "doctor",
        ...base,
        issueNumber,
        caseRunsPath,
        caseIdentity,
      };
      return admitted;
    }
    case "source-locator": {
      const { sourceRunPath, sourceRun } = fields;
      if (sourceRunPath === undefined || sourceRun === undefined) {
        throw new CliUsageError(
          `role run admitted notary source-run locator is missing: ${runId}`,
        );
      }
      const admitted: AdmittedNotaryInvocation = {
        role: "notary",
        ...base,
        sourceRunPath,
        sourceRun,
      };
      return admitted;
    }
  }
}

/** Worker phase on resume: value must belong to the registry phase set. */
function resumedWorkerPhase(
  phase: string | undefined,
  phases: readonly (string | null)[],
  role: string,
  runId: string,
): "plan" | "apply" {
  if (phase === "plan" || phase === "apply") {
    if (phases.some((item) => item === phase)) {
      return phase;
    }
  }
  throw new CliUsageError(`role run admitted ${role} phase is missing: ${runId}`);
}
