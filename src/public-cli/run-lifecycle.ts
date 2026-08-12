/**
 * Durable Role run lifecycle for public CLI (ADR 0052 / #11 / #108).
 * States: admitted → running → resumable | terminal.
 * v1 resume is limited to an observed typed HTTP 429 on Codex/xAI with no
 * lawful role terminal result. Prose is never regex-classified as quota evidence.
 */
import { lstat, open, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  activationBookDirectory,
  resolveActivationLedgerHome,
} from "../activation-ledger-topology.ts";
import { CliUsageError } from "./cli-errors.ts";
import type { FixerPhase } from "../package-contracts/fixer-output.ts";
import type { FixerPrerequisite } from "../package-contracts/fixer-packet.ts";
import {
  type AdmittedCoderInvocation,
  type AdmittedFixerInvocation,
  type AdmittedJudgeInvocation,
  type AdmittedMergerInvocation,
  type AdmittedReviewerInvocation,
  type AdmittedRoleInvocation,
  type CoderPhase,
  type DerivedMergerEnvelope,
  type FrozenAttachment,
} from "./invocation.ts";

/** Providers eligible for v1 typed-429 resume (Codex / xAI only). */
export const V1_RESUMABLE_PROVIDERS = ["openai-codex", "xai"] as const;
export type V1ResumableProvider = (typeof V1_RESUMABLE_PROVIDERS)[number];

export type RoleRunState = "admitted" | "running" | "resumable" | "terminal";

export type TypedHttp429Observation = {
  readonly httpStatus: 429;
  readonly provider: V1ResumableProvider;
};

export type RoleRunRecord = {
  readonly runId: string;
  readonly role:
    | "judge"
    | "coder"
    | "fixer"
    | "collector"
    | "doctor"
    | "reviewer"
    | "merger";
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
  /** Present only while state === "resumable". */
  readonly resumable?: TypedHttp429Observation;
};

/** Package-owned turn trigger for resume. Not caller instruction and not semantic task content. */
export const RESUME_TRANSPORT_ENVELOPE = "[ak-role:resume-continue]" as const;

const RUN_STATE_FILE = "run-state.json";
const TYPED_HTTP_FILE = "typed-provider-http.json";
const WRITER_LOCK_FILE = "writer.lock";

export function isV1ResumableProvider(
  provider: string,
): provider is V1ResumableProvider {
  return (V1_RESUMABLE_PROVIDERS as readonly string[]).includes(provider);
}

function typedProviderHttpPath(runDirectory: string): string {
  return join(runDirectory, TYPED_HTTP_FILE);
}

/**
 * Clear any prior attempt's typed provider HTTP observation.
 * Each initial/resume dispatch must start without inherited 429 evidence so
 * only the current attempt can qualify v1 resume.
 */
export async function clearTypedProviderHttpObservation(
  runDirectory: string,
): Promise<void> {
  try {
    await unlink(typedProviderHttpPath(runDirectory));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

/**
 * Record a typed provider HTTP status observation for the admitted run.
 * The latest observation is authoritative: only a current HTTP 429 from
 * Codex/xAI is retained for v1 resume; any other status or provider clears
 * prior within-attempt 429 evidence. Never inspects diagnostic prose.
 */
export async function recordTypedProviderHttpStatus(
  runDirectory: string,
  observation: { readonly httpStatus: number; readonly provider: string },
): Promise<void> {
  if (
    observation.httpStatus === 429 &&
    isV1ResumableProvider(observation.provider)
  ) {
    const body: TypedHttp429Observation = {
      httpStatus: 429,
      provider: observation.provider,
    };
    await writeFile(
      typedProviderHttpPath(runDirectory),
      `${JSON.stringify(body)}\n`,
      "utf8",
    );
    return;
  }
  // Non-qualifying latest response supersedes any earlier 429 in this attempt.
  await clearTypedProviderHttpObservation(runDirectory);
}

/**
 * Read a durable typed HTTP 429 observation. Returns undefined unless both
 * httpStatus === 429 and provider is a v1-resumable provider are present as
 * typed fields (never inferred from prose).
 */
export async function readTypedHttp429Observation(
  runDirectory: string,
): Promise<TypedHttp429Observation | undefined> {
  try {
    const raw: unknown = JSON.parse(
      await readFile(typedProviderHttpPath(runDirectory), "utf8"),
    );
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return undefined;
    }
    const record = raw as Record<string, unknown>;
    if (record.httpStatus !== 429) return undefined;
    if (typeof record.provider !== "string") return undefined;
    if (!isV1ResumableProvider(record.provider)) return undefined;
    return { httpStatus: 429, provider: record.provider };
  } catch {
    return undefined;
  }
}

/**
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

export async function readRoleRunState(
  runDirectory: string,
): Promise<RoleRunRecord | undefined> {
  try {
    const raw: unknown = JSON.parse(
      await readFile(join(runDirectory, RUN_STATE_FILE), "utf8"),
    );
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
      record.role !== "merger"
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
    // Resume only the principal bound by admission; never derive a second one.
    if (typeof record.sessionFile !== "string" || record.sessionFile.trim() === "") {
      return undefined;
    }
    const sessionFile = record.sessionFile;
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
      sessionDirectory: record.sessionDirectory,
      sessionFile,
      runDirectory: runDir,
      admittedRequestPath: record.admittedRequestPath,
      ...(phase === undefined ? {} : { phase }),
      ...(resumable === undefined ? {} : { resumable }),
    };
  } catch {
    return undefined;
  }
}

export async function markRunAdmitted(
  admitted: AdmittedRoleInvocation,
): Promise<void> {
  await writeRoleRunState(admitted.runDirectory, {
    runId: admitted.runId,
    role: admitted.role,
    state: "admitted",
    bookKey: admitted.bookKey,
    projectRoot: admitted.projectRoot,
    sessionDirectory: admitted.sessionDirectory,
    sessionFile: admitted.sessionFile,
    admittedRequestPath: admitted.admittedRequestPath,
    ...(
      admitted.role === "coder" || admitted.role === "fixer"
        ? { phase: admitted.phase }
        : {}
    ),
  });
}

export async function markRunRunning(runDirectory: string): Promise<void> {
  const current = await readRoleRunState(runDirectory);
  if (current === undefined) {
    throw new Error("cannot mark running: run state missing");
  }
  // Omit resumable while a writer is active.
  await writeRoleRunState(runDirectory, {
    runId: current.runId,
    role: current.role,
    state: "running",
    bookKey: current.bookKey,
    projectRoot: current.projectRoot,
    sessionDirectory: current.sessionDirectory,
    sessionFile: current.sessionFile,
    admittedRequestPath: current.admittedRequestPath,
    ...(current.phase === undefined ? {} : { phase: current.phase }),
  });
}

export async function markRunResumable(
  runDirectory: string,
  observation: TypedHttp429Observation,
): Promise<void> {
  const current = await readRoleRunState(runDirectory);
  if (current === undefined) {
    throw new Error("cannot mark resumable: run state missing");
  }
  await writeRoleRunState(runDirectory, {
    ...current,
    state: "resumable",
    resumable: observation,
  });
}

export async function markRunTerminal(runDirectory: string): Promise<void> {
  const current = await readRoleRunState(runDirectory);
  if (current === undefined) {
    throw new Error("cannot mark terminal: run state missing");
  }
  await writeRoleRunState(runDirectory, {
    runId: current.runId,
    role: current.role,
    state: "terminal",
    bookKey: current.bookKey,
    projectRoot: current.projectRoot,
    sessionDirectory: current.sessionDirectory,
    sessionFile: current.sessionFile,
    admittedRequestPath: current.admittedRequestPath,
    ...(current.phase === undefined ? {} : { phase: current.phase }),
  });
}

/**
 * True when the durable Pi session file principal exists as a regular file.
 * Resume must reopen this exact principal; directory-latest is not identity.
 */
export async function isSessionPrincipalAvailable(
  sessionFile: string,
): Promise<boolean> {
  if (sessionFile.trim() === "") return false;
  try {
    const st = await lstat(sessionFile);
    return st.isFile() && !st.isSymbolicLink();
  } catch {
    return false;
  }
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

/**
 * Acquire the one-writer lease for a Role run. Concurrent acquire rejects
 * without dispatch. Exclusive create — no second writer.
 */
export async function acquireRunWriterLease(
  runDirectory: string,
): Promise<RunWriterLease> {
  const lockPath = join(runDirectory, WRITER_LOCK_FILE);
  try {
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
        await unlink(lockPath).catch(() => undefined);
      },
    };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code?: unknown }).code === "EEXIST"
    ) {
      throw new RunWriterLeaseHeldError();
    }
    throw error;
  }
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
  const ledgerHome = resolveActivationLedgerHome(() => home);
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
  readonly mergerInputPath?: string;
  readonly derived?: DerivedMergerEnvelope;
};

async function loadResumableRunRecord(
  home: string,
  runId: string,
): Promise<{
  readonly run: RoleRunRecord;
  readonly observation: TypedHttp429Observation;
  readonly admittedFields: LoadedAdmittedRequestFields;
}> {
  const runDirectory = await findRunDirectoryById(home, runId);
  if (runDirectory === undefined) {
    throw new CliUsageError(`unknown role run id: ${runId}`);
  }
  const run = await readRoleRunState(runDirectory);
  if (run === undefined) {
    throw new CliUsageError(`unknown role run id: ${runId}`);
  }
  if (run.state === "terminal") {
    throw new CliUsageError(`role run is already terminal: ${runId}`);
  }
  if (run.state !== "resumable" || run.resumable === undefined) {
    throw new CliUsageError(`role run is not resumable: ${runId}`);
  }
  // Exact Pi session principal must be present before resume dispatches.
  if (!(await isSessionPrincipalAvailable(run.sessionFile))) {
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
  let mergerInputPath: string | undefined;
  let derived: DerivedMergerEnvelope | undefined;
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
    }
  } catch {
    throw new CliUsageError(
      `role run admitted request is unreadable: ${runId}`,
    );
  }
  return {
    run,
    observation: run.resumable,
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
      ...(mergerInputPath === undefined ? {} : { mergerInputPath }),
      ...(derived === undefined ? {} : { derived }),
    },
  };
}

export type LoadedResumableJudgeRun = {
  readonly admitted: AdmittedJudgeInvocation;
  readonly run: RoleRunRecord;
  readonly observation: TypedHttp429Observation;
};

export type LoadedResumableCoderRun = {
  readonly admitted: AdmittedCoderInvocation;
  readonly run: RoleRunRecord;
  readonly observation: TypedHttp429Observation;
};

export type LoadedResumableFixerRun = {
  readonly admitted: AdmittedFixerInvocation;
  readonly run: RoleRunRecord;
  readonly observation: TypedHttp429Observation;
};

export type LoadedResumableReviewerRun = {
  readonly admitted: AdmittedReviewerInvocation;
  readonly run: RoleRunRecord;
  readonly observation: TypedHttp429Observation;
};

/**
 * Load a resumable Judge run for resume. Rejects unknown, terminal,
 * non-resumable, and non-Judge IDs without replaying dispatch.
 */
export async function loadResumableJudgeRun(
  home: string,
  runId: string,
): Promise<LoadedResumableJudgeRun> {
  const loaded = await loadResumableRunRecord(home, runId);
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
    sessionDirectory: loaded.run.sessionDirectory,
    sessionFile: loaded.run.sessionFile,
    admittedRequestPath: loaded.run.admittedRequestPath,
  };
  return {
    admitted,
    run: loaded.run,
    observation: loaded.observation,
  };
}

/**
 * Load a resumable Coder run for resume. Phase and task path are restored from
 * the admitted request so continuation stays role-correct (#109).
 */
export async function loadResumableCoderRun(
  home: string,
  runId: string,
): Promise<LoadedResumableCoderRun> {
  const loaded = await loadResumableRunRecord(home, runId);
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
    sessionDirectory: loaded.run.sessionDirectory,
    sessionFile: loaded.run.sessionFile,
    admittedRequestPath: loaded.run.admittedRequestPath,
    taskPath,
  };
  return {
    admitted,
    run: loaded.run,
    observation: loaded.observation,
  };
}

/**
 * Load a resumable Fixer run for resume. Phase, packet, and prerequisites are
 * restored from the admitted request so continuation stays role-correct (#110).
 */
export async function loadResumableFixerRun(
  home: string,
  runId: string,
): Promise<LoadedResumableFixerRun> {
  const loaded = await loadResumableRunRecord(home, runId);
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
    sessionDirectory: loaded.run.sessionDirectory,
    sessionFile: loaded.run.sessionFile,
    admittedRequestPath: loaded.run.admittedRequestPath,
    packetPath,
    ...(loaded.admittedFields.prerequisitesPath === undefined
      ? {}
      : { prerequisitesPath: loaded.admittedFields.prerequisitesPath }),
    prerequisites,
  };
  return {
    admitted,
    run: loaded.run,
    observation: loaded.observation,
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
): Promise<LoadedResumableReviewerRun> {
  const loaded = await loadResumableRunRecord(home, runId);
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
    sessionDirectory: loaded.run.sessionDirectory,
    sessionFile: loaded.run.sessionFile,
    admittedRequestPath: loaded.run.admittedRequestPath,
    baseRevision,
  };
  return {
    admitted,
    run: loaded.run,
    observation: loaded.observation,
  };
}

export type LoadedResumableMergerRun = {
  readonly admitted: AdmittedMergerInvocation;
  readonly run: RoleRunRecord;
  readonly observation: TypedHttp429Observation;
};

/**
 * Load a resumable Merger run for resume. Derived envelope + internal input path
 * are restored from the admitted request (#114).
 */
export async function loadResumableMergerRun(
  home: string,
  runId: string,
): Promise<LoadedResumableMergerRun> {
  const loaded = await loadResumableRunRecord(home, runId);
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
    sessionDirectory: loaded.run.sessionDirectory,
    sessionFile: loaded.run.sessionFile,
    admittedRequestPath: loaded.run.admittedRequestPath,
    mergerInputPath,
    derived,
  };
  return {
    admitted,
    run: loaded.run,
    observation: loaded.observation,
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
  | undefined
> {
  const runDirectory = await findRunDirectoryById(home, runId);
  if (runDirectory === undefined) return undefined;
  const run = await readRoleRunState(runDirectory);
  return run?.role;
}
