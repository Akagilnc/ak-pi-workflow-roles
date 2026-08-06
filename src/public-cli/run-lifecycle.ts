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
import {
  roleRunSessionFile,
  type AdmittedJudgeInvocation,
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
  readonly role: "judge";
  readonly state: RoleRunState;
  readonly bookKey: string;
  readonly projectRoot: string;
  readonly sessionDirectory: string;
  /** Exact Pi session file principal reopened on resume (not directory-latest). */
  readonly sessionFile: string;
  readonly runDirectory: string;
  readonly admittedRequestPath: string;
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
 * Only HTTP 429 from Codex/xAI is retained; other statuses and providers are ignored.
 * Never inspects diagnostic prose.
 */
export async function recordTypedProviderHttpStatus(
  runDirectory: string,
  observation: { readonly httpStatus: number; readonly provider: string },
): Promise<void> {
  if (observation.httpStatus !== 429) return;
  if (!isV1ResumableProvider(observation.provider)) return;
  const body: TypedHttp429Observation = {
    httpStatus: 429,
    provider: observation.provider,
  };
  await writeFile(
    typedProviderHttpPath(runDirectory),
    `${JSON.stringify(body)}\n`,
    "utf8",
  );
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
    if (record.role !== "judge") return undefined;
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
    // Prefer durable principal; fall back only for in-progress records that
    // predate the field but still own a private session directory.
    const sessionFile =
      typeof record.sessionFile === "string" && record.sessionFile.trim() !== ""
        ? record.sessionFile
        : roleRunSessionFile(record.sessionDirectory);
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
    return {
      runId: record.runId,
      role: "judge",
      state: record.state,
      bookKey: record.bookKey,
      projectRoot: record.projectRoot,
      sessionDirectory: record.sessionDirectory,
      sessionFile,
      runDirectory: runDir,
      admittedRequestPath: record.admittedRequestPath,
      ...(resumable === undefined ? {} : { resumable }),
    };
  } catch {
    return undefined;
  }
}

export async function markRunAdmitted(
  admitted: AdmittedJudgeInvocation,
): Promise<void> {
  await writeRoleRunState(admitted.runDirectory, {
    runId: admitted.runId,
    role: "judge",
    state: "admitted",
    bookKey: admitted.bookKey,
    projectRoot: admitted.projectRoot,
    sessionDirectory: admitted.sessionDirectory,
    sessionFile: admitted.sessionFile,
    admittedRequestPath: admitted.admittedRequestPath,
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

export type LoadedResumableJudgeRun = {
  readonly admitted: AdmittedJudgeInvocation;
  readonly run: RoleRunRecord;
  readonly observation: TypedHttp429Observation;
};

/**
 * Load a resumable Judge run for resume. Rejects unknown, terminal, and
 * non-resumable IDs without replaying dispatch.
 */
export async function loadResumableJudgeRun(
  home: string,
  runId: string,
): Promise<LoadedResumableJudgeRun> {
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
    }
  } catch {
    throw new CliUsageError(
      `role run admitted request is unreadable: ${runId}`,
    );
  }
  const admitted: AdmittedJudgeInvocation = {
    role: "judge",
    runId: run.runId,
    bookKey: run.bookKey,
    projectRoot: run.projectRoot,
    instruction,
    instructionEmpty,
    attachments,
    runDirectory: run.runDirectory,
    sessionDirectory: run.sessionDirectory,
    sessionFile: run.sessionFile,
    admittedRequestPath: run.admittedRequestPath,
  };
  return {
    admitted,
    run,
    observation: run.resumable,
  };
}
