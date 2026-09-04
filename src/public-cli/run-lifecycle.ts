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
import { chmod, open, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  activationBookDirectory,
  resolveActivationLedgerHome,
} from "../activation-ledger-topology.ts";
import {
  describeErrorIdentity,
  errorCodeOf,
  isProcessAlive,
} from "../error-identity.ts";
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
/** Re-export shared error identity for public-cli callers (#648). */
export { describeErrorIdentity } from "../error-identity.ts";
import type { FixerPhase } from "../package-contracts/fixer-output.ts";
import type { FixerPrerequisite } from "../package-contracts/fixer-packet.ts";
import {
  appendEngineSessionMaterial,
  engineSessionMaterialFromOptions,
  type EngineSessionMaterial,
} from "../package-resources/engine-material.ts";
import { THINKING_LEVELS } from "./config.ts";
import type { PublicThinkingLevel } from "./registry.ts";
import {
  recordEffectiveInvocationModel,
  requireAuthorityRef,
  type AdmittedCoderInvocation,
  type AdmittedCountersignInvocation,
  type AdmittedFixerInvocation,
  type AdmittedGleanerLeftInvocation,
  type AdmittedJudgeInvocation,
  type AdmittedMergerInvocation,
  type AdmittedReviewerInvocation,
  type AdmittedRoleInvocation,
  type CoderPhase,
  type DerivedMergerEnvelope,
  type FrozenAttachment,
  type InvocationEffectiveModel,
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
  readonly role:
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
    | "inspector";
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

/** Package-owned turn trigger for resume. Not caller instruction and not semantic task content. */
export const RESUME_TRANSPORT_ENVELOPE = "[ak-role:resume-continue]" as const;

/** Public manual resume request after the unique CLI parser owns runId + optional message. */
export type PublicResumeRequest = {
  readonly runId: string;
  /** Present when the caller supplied the post-runId argv (including empty string). */
  readonly message?: string;
};

/**
 * Unique continuation-prompt selector for manual/auto resume (#471 / #600).
 * Message present → base bytes unchanged; absent → package transport envelope.
 * When engine material is present, append structured engine coordinates (same
 * delivery as initial transport prompts). Zero parse, zero classify, zero narrow.
 */
export function selectResumeContinuationPrompt(
  message?: string,
  engineMaterial?: EngineSessionMaterial,
): string {
  const base = message !== undefined ? message : RESUME_TRANSPORT_ENVELOPE;
  return appendEngineSessionMaterial([base], engineMaterial).join("\n");
}

/**
 * Resume continuation with engine material resolved from the seat env (#600).
 * Seat table / invocation engine axis rides the same prompt seam as initial runs.
 */
export function buildResumeContinuationPrompt(options: {
  packageRoot: string;
  engine?: string;
  message?: string;
}): string {
  return selectResumeContinuationPrompt(
    options.message,
    engineSessionMaterialFromOptions({
      ...(options.engine === undefined ? {} : { engine: options.engine }),
      packageRoot: options.packageRoot,
    }),
  );
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

/**
 * @deprecated #416: 429-only resumability predicate removed from gating. Kept for compatibility.
 * True only when a typed HTTP 429 was observed and no lawful terminal exists.
 * Callers must pass the lawful-terminal fact from settlement, not re-infer it.
 */
export function isV1ResumableFailure(input: {
  readonly hasLawfulTerminalResult: boolean;
  readonly typedHttp429?: TypedHttp429Observation;
}): boolean {
  if (input.hasLawfulTerminalResult) return false;
  return input.typedHttp429 !== undefined;
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
};

async function readRoleRunStateDisk(
  runDirectory: string,
): Promise<RoleRunStateDisk | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(runDirectory, RUN_STATE_FILE), "utf8"));
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.runId !== "string" || record.runId.trim() === "") {
    return undefined;
  }
  if (
    record.role !== "judge" &&
    record.role !== "coder" &&
    record.role !== "fixer" &&
    record.role !== "collector" &&
    record.role !== "doctor" &&
    record.role !== "reviewer" &&
    record.role !== "merger" &&
    record.role !== "notary" &&
    record.role !== "countersign" &&
    record.role !== "gleaner-left" &&
    record.role !== "inspector"
  ) {
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
  const runDir =
    typeof record.runDirectory === "string" && record.runDirectory.trim() !== ""
      ? record.runDirectory
      : runDirectory;
  // Principal wire stays uninterpreted — authority owns legacy sessionFile fallback.
  const principalWire: RoleRunPrincipalWire = {
    sessionDirectory: record.sessionDirectory,
    ...(typeof record.sessionFile === "string"
      ? { sessionFile: record.sessionFile }
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
  return {
    runId: record.runId,
    role: record.role,
    state: record.state,
    bookKey: record.bookKey,
    projectRoot: record.projectRoot,
    runDirectory: runDir,
    admittedRequestPath: record.admittedRequestPath,
    principalWire,
    ...(phase === undefined ? {} : { phase }),
    ...(resumable === undefined ? {} : { resumable }),
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
  await writeRoleRunState(admitted.runDirectory, {
    runId: admitted.runId,
    role: admitted.role,
    state: "admitted",
    bookKey: admitted.bookKey,
    projectRoot: admitted.projectRoot,
    sessionDirectory,
    sessionFile,
    admittedRequestPath: admitted.admittedRequestPath,
    ...(
      admitted.role === "coder" || admitted.role === "fixer"
        ? { phase: admitted.phase }
        : {}
    ),
  });
}

/**
 * Shared dispatch execution seam: record the effective launch model (initial or
 * resume override) and the authoritative seat engine/host onto invocation.json,
 * then transition to running.
 * Role runners must not coordinate lifecycle ledger writes themselves.
 * Engine axis is authoritative here (#617): present string is written; omit/undefined
 * clears any prior engine key so unset-engine + resume does not keep a stale value.
 * (Non-authoritative partial updates still use recordEffectiveInvocationModel directly
 * with `engine: undefined` to preserve.)
 */
export async function markRunRunning(
  runDirectory: string,
  effectiveModel?: InvocationEffectiveModel,
  effectiveEngine?: string,
  effectiveHost?: string,
): Promise<void> {
  await recordEffectiveInvocationModel(
    runDirectory,
    effectiveModel,
    // Authoritative seat projection: absent engine ⇒ null (delete).
    effectiveEngine === undefined ? null : effectiveEngine,
    effectiveHost,
  );
  const current = await readRoleRunStateDisk(runDirectory);
  if (current === undefined) {
    throw new Error("cannot mark running: run state missing");
  }
  // Omit resumable while a writer is active. Principal wire is passed through uninterpreted.
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
  });
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
  release(): Promise<void>;
};

/** Kind of a writer-lease diagnostic sent on the existing sink. */
export type WriterLeaseDiagnosticKind = "stale-reclaimed";

type WriterLockAutopsy =
  | { verdict: "absent"; readFailure?: unknown }
  | { verdict: "dead"; pid: number }
  | { verdict: "alive"; pid: number };

/**
 * Holder autopsy for an existing writer.lock (#552). "absent" covers no file,
 * no parseable pid (a live creator mid-acquisition reads as empty, and so does
 * the crash-window leftover), and unreadable files — absent alone never
 * authorizes reclaim; only a "dead" verdict does. A non-ENOENT read failure
 * still decides "absent" but rides along as readFailure so the true cause can
 * land in the cleanup sink instead of being laundered away.
 */
async function autopsyWriterLock(lockPath: string): Promise<WriterLockAutopsy> {
  let content: string;
  try {
    content = await readFile(lockPath, "utf8");
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") return { verdict: "absent" };
    return { verdict: "absent", readFailure: error };
  }
  const normalized = content.trim();
  if (!/^[1-9]\d*$/.test(normalized)) return { verdict: "absent" };
  const pid = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) return { verdict: "absent" };
  return isProcessAlive(pid) ? { verdict: "alive", pid } : { verdict: "dead", pid };
}

function describeAutopsy(autopsy: WriterLockAutopsy): string {
  switch (autopsy.verdict) {
    case "alive":
      return `live pid ${autopsy.pid}`;
    case "dead":
      return `dead pid ${autopsy.pid}`;
    case "absent":
      return autopsy.readFailure !== undefined
        ? "unreadable lock"
        : "absent or unparseable holder";
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
  reportCleanupFailure: (error: unknown) => void,
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
  return {
    lockPath,
    async release() {
      if (released) return;
      released = true;
      await handle.close().catch(() => undefined);
      try {
        await unlink(lockPath);
      } catch (error) {
        if (errorCodeOf(error) === "EACCES") {
          try {
            await chmod(runDirectory, 0o755);
            await unlink(lockPath);
          } catch (retryError) {
            reportCleanupFailure(retryError);
          }
        } else {
          reportCleanupFailure(error);
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
  const reportCleanupFailure = (error: unknown): void => {
    reportDiagnostic(
      `writer lease lock cleanup failed (release is best-effort; residual lock left in place) at ${join(runDirectory, WRITER_LOCK_FILE)}: ${describeErrorIdentity(error)}`,
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
    if (lastAutopsy.verdict === "absent" && lastAutopsy.readFailure !== undefined) {
      reportReadFailure(lastAutopsy.readFailure);
    }
    if (lastAutopsy.verdict === "alive") {
      throw new RunWriterLeaseHeldError(
        `role run writer lease is already held by live pid ${lastAutopsy.pid} at ${lockPath}`,
      );
    }
    if (lastAutopsy.verdict === "absent") {
      throw new RunWriterLeaseHeldError(
        lastAutopsy.readFailure !== undefined
          ? `role run writer lease lock is unreadable at ${lockPath}: ${describeErrorIdentity(lastAutopsy.readFailure)}; holder liveness unverifiable, lock left in place`
          : `role run writer lease lock at ${lockPath} has no verifiable holder pid (empty or unparseable); holder liveness unverifiable, lock left in place`,
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
 */
export async function findRunDirectoryById(
  home: string,
  runId: string,
): Promise<string | undefined> {
  if (runId.trim() === "") return undefined;
  const ledgerHome = resolveActivationLedgerHome(home);
  const booksRoot = join(ledgerHome, "books");
  let bookKeys: string[];
  try {
    bookKeys = await readdir(booksRoot);
  } catch {
    return undefined;
  }
  for (const bookKey of bookKeys) {
    const runsDir = join(activationBookDirectory(ledgerHome, bookKey), "runs");
    let entries: string[];
    try {
      entries = await readdir(runsDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === `${runId}@judge` || entry.startsWith(`${runId}@`)) {
        return join(runsDir, entry);
      }
    }
  }
  return undefined;
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
  readonly authorityRefs?: readonly string[];
  readonly mergerInputPath?: string;
  readonly derived?: DerivedMergerEnvelope;
  readonly correlationId?: string;
  readonly ticketNumber?: number;
  /** Effective model restored from the invocation identity page on resume. */
  readonly model?: InvocationEffectiveModel;
};

/** Restore optional correlation + typed ticketNumber from a durable admitted page. */
function parsePersistedTicketIdentity(
  record: Record<string, unknown>,
): { correlationId?: string; ticketNumber?: number } {
  const correlationId =
    typeof record.correlationId === "string" && record.correlationId.trim() !== ""
      ? record.correlationId
      : undefined;
  const ticketNumber =
    typeof record.ticketNumber === "number" &&
    Number.isInteger(record.ticketNumber) &&
    record.ticketNumber >= 1
      ? record.ticketNumber
      : undefined;
  return {
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(ticketNumber === undefined ? {} : { ticketNumber }),
  };
}

function restoredTicketFields(fields: LoadedAdmittedRequestFields): {
  correlationId?: string;
  ticketNumber?: number;
} {
  return {
    ...(fields.correlationId === undefined ? {} : { correlationId: fields.correlationId }),
    ...(fields.ticketNumber === undefined ? {} : { ticketNumber: fields.ticketNumber }),
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
  let authorityRefs: readonly string[] | undefined;
  let mergerInputPath: string | undefined;
  let derived: DerivedMergerEnvelope | undefined;
  let correlationId: string | undefined;
  let ticketNumber: number | undefined;
  try {
    const raw: unknown = JSON.parse(
      await readFile(run.admittedRequestPath, "utf8"),
    );
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      const record = raw as Record<string, unknown>;
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
          typeof d.automaticMergeTreeId === "string" &&
          Array.isArray(d.expectedConflictPaths) &&
          Array.isArray(d.resolutionScope) &&
          d.expectedConflictPaths.every((p) => typeof p === "string") &&
          d.resolutionScope.every((p) => typeof p === "string")
        ) {
          derived = {
            targetObjectId: d.targetObjectId,
            sourceObjectId: d.sourceObjectId,
            automaticMergeTreeId: d.automaticMergeTreeId,
            expectedConflictPaths: d.expectedConflictPaths as string[],
            resolutionScope: d.resolutionScope as string[],
          };
        }
      }
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
      if (typeof rec.provider === "string" && typeof rec.model === "string") {
        model = {
          provider: rec.provider,
          model: rec.model,
          ...(typeof rec.thinking === "string" &&
          THINKING_LEVELS.has(rec.thinking as PublicThinkingLevel)
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
      ...(authorityRefs === undefined ? {} : { authorityRefs }),
      ...(mergerInputPath === undefined ? {} : { mergerInputPath }),
      ...(derived === undefined ? {} : { derived }),
      ...(correlationId === undefined ? {} : { correlationId }),
      ...(ticketNumber === undefined ? {} : { ticketNumber }),
      ...(model === undefined ? {} : { model }),
    },
  };
}

export type LoadedResumableJudgeRun = {
  readonly admitted: AdmittedJudgeInvocation;
  readonly run: RoleRunRecord;
  /** @deprecated #416: resumable observation no longer gates resume; may be undefined. */
  readonly observation?: TypedHttp429Observation;
};

export type LoadedResumableCoderRun = {
  readonly admitted: AdmittedCoderInvocation;
  readonly run: RoleRunRecord;
  readonly observation?: TypedHttp429Observation;
};

export type LoadedResumableFixerRun = {
  readonly admitted: AdmittedFixerInvocation;
  readonly run: RoleRunRecord;
  readonly observation?: TypedHttp429Observation;
};

export type LoadedResumableReviewerRun = {
  readonly admitted: AdmittedReviewerInvocation;
  readonly run: RoleRunRecord;
  readonly observation?: TypedHttp429Observation;
};

export type LoadedResumableCountersignRun = {
  readonly admitted: AdmittedCountersignInvocation;
  readonly run: RoleRunRecord;
  readonly observation?: TypedHttp429Observation;
};

export type LoadedResumableGleanerLeftRun = {
  readonly admitted: AdmittedGleanerLeftInvocation;
  readonly run: RoleRunRecord;
  readonly observation?: TypedHttp429Observation;
};

/**
 * Load a resumable Judge run for resume. Rejects unknown, terminal,
 * non-resumable, and non-Judge IDs without replaying dispatch.
 */
export async function loadResumableJudgeRun(
  home: string,
  runId: string,
  authority: DurablePrincipalAuthority,
): Promise<LoadedResumableJudgeRun> {
  const loaded = await loadResumableRunRecord(home, runId, authority);
  if (loaded.run.role !== "judge") {
    throw new CliUsageError(
      `role run ${runId} belongs to ${loaded.run.role}, not judge`,
    );
  }
  const admitted: AdmittedJudgeInvocation = {
    role: "judge",
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
  return {
    admitted,
    run: loaded.run,
    ...(loaded.observation === undefined ? {} : { observation: loaded.observation }),
  };
}

/**
 * Load a resumable Coder run for resume. Phase and task path are restored from
 * the admitted request so continuation stays role-correct (#109).
 */
export async function loadResumableCoderRun(
  home: string,
  runId: string,
  authority: DurablePrincipalAuthority,
): Promise<LoadedResumableCoderRun> {
  const loaded = await loadResumableRunRecord(home, runId, authority);
  if (loaded.run.role !== "coder") {
    throw new CliUsageError(
      `role run ${runId} belongs to ${loaded.run.role}, not coder`,
    );
  }
  const phase = loaded.admittedFields.phase ?? loaded.run.phase;
  if (phase !== "plan" && phase !== "apply") {
    throw new CliUsageError(
      `role run admitted coder phase is missing: ${runId}`,
    );
  }
  const taskPath = loaded.admittedFields.taskPath;
  if (taskPath === undefined) {
    throw new CliUsageError(
      `role run admitted coder task path is missing: ${runId}`,
    );
  }
  if (loaded.admittedFields.instruction.trim() === "") {
    throw new CliUsageError(
      `role run admitted coder task is blank: ${runId}`,
    );
  }
  const admitted: AdmittedCoderInvocation = {
    role: "coder",
    phase,
    runId: loaded.run.runId,
    bookKey: loaded.run.bookKey,
    projectRoot: loaded.run.projectRoot,
    instruction: loaded.admittedFields.instruction,
    instructionEmpty: false,
    attachments: loaded.admittedFields.attachments,
    runDirectory: loaded.run.runDirectory,
    principal: loaded.principal,
    admittedRequestPath: loaded.run.admittedRequestPath,
    taskPath,
    ...(loaded.admittedFields.model === undefined ? {} : { model: loaded.admittedFields.model }),
    ...restoredTicketFields(loaded.admittedFields),
  };
  return {
    admitted,
    run: loaded.run,
    ...(loaded.observation === undefined ? {} : { observation: loaded.observation }),
  };
}

/**
 * Load a resumable Fixer run for resume. Phase, packet, and prerequisites are
 * restored from the admitted request so continuation stays role-correct (#110).
 */
export async function loadResumableFixerRun(
  home: string,
  runId: string,
  authority: DurablePrincipalAuthority,
): Promise<LoadedResumableFixerRun> {
  const loaded = await loadResumableRunRecord(home, runId, authority);
  if (loaded.run.role !== "fixer") {
    throw new CliUsageError(
      `role run ${runId} belongs to ${loaded.run.role}, not fixer`,
    );
  }
  const phase = loaded.admittedFields.phase ?? loaded.run.phase;
  if (phase !== "plan" && phase !== "apply") {
    throw new CliUsageError(
      `role run admitted fixer phase is missing: ${runId}`,
    );
  }
  const packetPath = loaded.admittedFields.packetPath;
  if (packetPath === undefined) {
    throw new CliUsageError(
      `role run admitted fixer packet path is missing: ${runId}`,
    );
  }
  if (loaded.admittedFields.instruction.trim() === "") {
    throw new CliUsageError(
      `role run admitted fixer instruction is blank: ${runId}`,
    );
  }
  const prerequisites = loaded.admittedFields.prerequisites ?? Object.freeze([]);
  const admitted: AdmittedFixerInvocation = {
    role: "fixer",
    phase,
    runId: loaded.run.runId,
    bookKey: loaded.run.bookKey,
    projectRoot: loaded.run.projectRoot,
    instruction: loaded.admittedFields.instruction,
    instructionEmpty: false,
    attachments: loaded.admittedFields.attachments,
    runDirectory: loaded.run.runDirectory,
    principal: loaded.principal,
    admittedRequestPath: loaded.run.admittedRequestPath,
    packetPath,
    ...(loaded.admittedFields.prerequisitesPath === undefined
      ? {}
      : { prerequisitesPath: loaded.admittedFields.prerequisitesPath }),
    prerequisites,
    ...(loaded.admittedFields.model === undefined ? {} : { model: loaded.admittedFields.model }),
    ...restoredTicketFields(loaded.admittedFields),
  };
  return {
    admitted,
    run: loaded.run,
    ...(loaded.observation === undefined ? {} : { observation: loaded.observation }),
  };
}

/**
 * Peek the durable role of a run id without enforcing resumable state.
 * Used by public resume dispatch to pick the role-correct seat and path.
 */
/**
 * Load a resumable Reviewer run for resume. Fixed base is restored from the
 * admitted request; caller instruction remains optional provenance only.
 */
export async function loadResumableReviewerRun(
  home: string,
  runId: string,
  authority: DurablePrincipalAuthority,
): Promise<LoadedResumableReviewerRun> {
  const loaded = await loadResumableRunRecord(home, runId, authority);
  if (loaded.run.role !== "reviewer") {
    throw new CliUsageError(
      `role run ${runId} belongs to ${loaded.run.role}, not reviewer`,
    );
  }
  const baseRevision = loaded.admittedFields.baseRevision;
  if (baseRevision === undefined || baseRevision.trim() === "") {
    throw new CliUsageError(
      `role run admitted reviewer base revision is missing: ${runId}`,
    );
  }
  const admitted: AdmittedReviewerInvocation = {
    role: "reviewer",
    runId: loaded.run.runId,
    bookKey: loaded.run.bookKey,
    projectRoot: loaded.run.projectRoot,
    instruction: loaded.admittedFields.instruction,
    instructionEmpty: loaded.admittedFields.instructionEmpty,
    attachments: loaded.admittedFields.attachments,
    runDirectory: loaded.run.runDirectory,
    principal: loaded.principal,
    admittedRequestPath: loaded.run.admittedRequestPath,
    baseRevision,
    authorityRefs: Object.freeze([...(loaded.admittedFields.authorityRefs ?? [])]),
    ...(loaded.admittedFields.model === undefined ? {} : { model: loaded.admittedFields.model }),
    ...restoredTicketFields(loaded.admittedFields),
  };
  return {
    admitted,
    run: loaded.run,
    ...(loaded.observation === undefined ? {} : { observation: loaded.observation }),
  };
}

/**
 * Load a resumable Countersign run for resume (#599). Ticket binding and
 * attachments restore from the admitted request; diarist does not re-run.
 */
export async function loadResumableCountersignRun(
  home: string,
  runId: string,
  authority: DurablePrincipalAuthority,
): Promise<LoadedResumableCountersignRun> {
  const loaded = await loadResumableRunRecord(home, runId, authority);
  if (loaded.run.role !== "countersign") {
    throw new CliUsageError(
      `role run ${runId} belongs to ${loaded.run.role}, not countersign`,
    );
  }
  const admitted: AdmittedCountersignInvocation = {
    role: "countersign",
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
  return {
    admitted,
    run: loaded.run,
    ...(loaded.observation === undefined ? {} : { observation: loaded.observation }),
  };
}

/**
 * Load a resumable Gleaner-Left run for resume (#599). Fixed base restores from
 * the admitted request so continuation stays comparison-correct.
 */
export async function loadResumableGleanerLeftRun(
  home: string,
  runId: string,
  authority: DurablePrincipalAuthority,
): Promise<LoadedResumableGleanerLeftRun> {
  const loaded = await loadResumableRunRecord(home, runId, authority);
  if (loaded.run.role !== "gleaner-left") {
    throw new CliUsageError(
      `role run ${runId} belongs to ${loaded.run.role}, not gleaner-left`,
    );
  }
  const baseRevision = loaded.admittedFields.baseRevision;
  if (baseRevision === undefined || baseRevision.trim() === "") {
    throw new CliUsageError(
      `role run admitted gleaner-left base revision is missing: ${runId}`,
    );
  }
  const admitted: AdmittedGleanerLeftInvocation = {
    role: "gleaner-left",
    runId: loaded.run.runId,
    bookKey: loaded.run.bookKey,
    projectRoot: loaded.run.projectRoot,
    instruction: loaded.admittedFields.instruction,
    instructionEmpty: loaded.admittedFields.instructionEmpty,
    attachments: loaded.admittedFields.attachments,
    runDirectory: loaded.run.runDirectory,
    principal: loaded.principal,
    admittedRequestPath: loaded.run.admittedRequestPath,
    baseRevision,
    ...(loaded.admittedFields.model === undefined ? {} : { model: loaded.admittedFields.model }),
    ...restoredTicketFields(loaded.admittedFields),
  };
  return {
    admitted,
    run: loaded.run,
    ...(loaded.observation === undefined ? {} : { observation: loaded.observation }),
  };
}

export type LoadedResumableMergerRun = {
  readonly admitted: AdmittedMergerInvocation;
  readonly run: RoleRunRecord;
  readonly observation?: TypedHttp429Observation;
};

/**
 * Load a resumable Merger run for resume. Derived envelope + internal input path
 * are restored from the admitted request (#114).
 */
export async function loadResumableMergerRun(
  home: string,
  runId: string,
  authority: DurablePrincipalAuthority,
): Promise<LoadedResumableMergerRun> {
  const loaded = await loadResumableRunRecord(home, runId, authority);
  if (loaded.run.role !== "merger") {
    throw new CliUsageError(
      `role run ${runId} belongs to ${loaded.run.role}, not merger`,
    );
  }
  const mergerInputPath = loaded.admittedFields.mergerInputPath;
  if (mergerInputPath === undefined) {
    throw new CliUsageError(
      `role run admitted merger input path is missing: ${runId}`,
    );
  }
  const derived = loaded.admittedFields.derived;
  if (derived === undefined) {
    throw new CliUsageError(
      `role run admitted merger envelope is missing: ${runId}`,
    );
  }
  if (loaded.admittedFields.instruction.trim() === "") {
    throw new CliUsageError(
      `role run admitted merger task is blank: ${runId}`,
    );
  }
  const admitted: AdmittedMergerInvocation = {
    role: "merger",
    runId: loaded.run.runId,
    bookKey: loaded.run.bookKey,
    projectRoot: loaded.run.projectRoot,
    instruction: loaded.admittedFields.instruction,
    instructionEmpty: false,
    attachments: loaded.admittedFields.attachments,
    runDirectory: loaded.run.runDirectory,
    principal: loaded.principal,
    admittedRequestPath: loaded.run.admittedRequestPath,
    mergerInputPath,
    derived,
    ...(loaded.admittedFields.model === undefined ? {} : { model: loaded.admittedFields.model }),
    ...restoredTicketFields(loaded.admittedFields),
  };
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
  | undefined
> {
  const runDirectory = await findRunDirectoryById(home, runId);
  if (runDirectory === undefined) return undefined;
  const run = await readRoleRunIdentity(runDirectory);
  return run?.role;
}
