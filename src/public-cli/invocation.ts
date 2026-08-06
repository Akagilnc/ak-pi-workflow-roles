/**
 * Public Invocation request admission: optional opaque instruction, frozen
 * Attachments, project default/override (ADR 0052 / #106).
 */
import {
  lstat,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

import {
  activationBookDirectory,
  ensureRealDirectoryTree,
  resolveActivationLedgerHome,
} from "../activation-ledger-topology.ts";
import { resolveBookKeyFromGit } from "../activation-ledger-git.ts";
import { sha256Hex } from "../sha256.ts";
import { uuidv7 } from "../uuidv7.ts";
import { CliUsageError } from "./cli-errors.ts";

/** Transport-only envelope for a structurally empty public request. Not a semantic task. */
export const EMPTY_INVOCATION_TRANSPORT_ENVELOPE =
  "[ak-role:structurally-empty-request]" as const;

export type FrozenAttachment = {
  /** Original caller path retained only as provenance. */
  readonly provenancePath: string;
  /** Absolute path of the admitted frozen snapshot bytes. */
  readonly frozenPath: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly mediaKind: "regular-file";
};

/** Durable Pi session file principal name under a Role run's private session directory. */
export const ROLE_RUN_SESSION_FILE_NAME = "session.jsonl" as const;

/** Exact Pi session file principal path for a Role run session directory. */
export function roleRunSessionFile(sessionDirectory: string): string {
  return join(sessionDirectory, ROLE_RUN_SESSION_FILE_NAME);
}

/** Shared admitted Role run identity (#106 common Invocation + #109 Coder). */
export type AdmittedRoleInvocationBase = {
  readonly runId: string;
  readonly bookKey: string;
  readonly projectRoot: string;
  /** Opaque instruction bytes as submitted. */
  readonly instruction: string;
  /** True when the caller supplied no nonblank instruction. */
  readonly instructionEmpty: boolean;
  readonly attachments: readonly FrozenAttachment[];
  readonly runDirectory: string;
  readonly sessionDirectory: string;
  /** Exact Pi session file principal (bound at admission; reopened on resume). */
  readonly sessionFile: string;
  readonly admittedRequestPath: string;
};

export type AdmittedJudgeInvocation = AdmittedRoleInvocationBase & {
  readonly role: "judge";
};

export type CoderPhase = "plan" | "apply";

export type AdmittedCoderInvocation = AdmittedRoleInvocationBase & {
  readonly role: "coder";
  /** Explicit plan or default apply — preserved through admission and continuation. */
  readonly phase: CoderPhase;
  /** Durable task file path consumed by internal --ak-coder-task. */
  readonly taskPath: string;
};

export type AdmittedRoleInvocation =
  | AdmittedJudgeInvocation
  | AdmittedCoderInvocation;

export type ParseJudgeArgvResult = {
  instruction: string;
  attachmentPaths: string[];
  project?: string;
};

export type ParseCoderArgvResult = {
  phase: CoderPhase;
  instruction: string;
  attachmentPaths: string[];
  project?: string;
};

/** Reject missing/blank path values so empty overrides cannot silently degrade. */
function requireOptionPath(flag: "--project" | "--attach", value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new CliUsageError(`${flag} requires a path`);
  }
  return value;
}

/**
 * Parse Judge-specific argv after the `judge` token.
 * Rejects any public burden selector/hint and unknown flags.
 */
export function parseJudgeArgv(args: readonly string[]): ParseJudgeArgvResult {
  const attachmentPaths: string[] = [];
  let project: string | undefined;
  const positional: string[] = [];
  const tokens = [...args];

  while (tokens.length > 0) {
    const token = tokens.shift()!;
    if (token === "--") {
      positional.push(...tokens);
      break;
    }
    if (token === "--attach") {
      attachmentPaths.push(requireOptionPath("--attach", tokens.shift()));
      continue;
    }
    if (token.startsWith("--attach=")) {
      attachmentPaths.push(
        requireOptionPath("--attach", token.slice("--attach=".length)),
      );
      continue;
    }
    if (token === "--project") {
      project = requireOptionPath("--project", tokens.shift());
      continue;
    }
    if (token.startsWith("--project=")) {
      project = requireOptionPath("--project", token.slice("--project=".length));
      continue;
    }
    // Judge owns burden inference — no public burden selector or hint.
    if (
      token === "--burden" ||
      token.startsWith("--burden=") ||
      token === "--ak-judge-burden" ||
      token.startsWith("--ak-judge-burden=") ||
      token === "--judge-burden" ||
      token.startsWith("--judge-burden=")
    ) {
      throw new CliUsageError(
        "judge does not accept a public burden selector; Judge infers its own burden",
      );
    }
    if (token.startsWith("-") && token !== "-") {
      throw new CliUsageError(`unknown judge option: ${token}`);
    }
    positional.push(token);
  }

  return {
    instruction: positional.join(" "),
    attachmentPaths,
    ...(project === undefined ? {} : { project }),
  };
}

/**
 * Parse Coder-specific argv after the `coder` token.
 * Phase defaults to apply; explicit `plan` or `apply` as the first positional is preserved.
 * Common Invocation flags: --attach / --project.
 */
export function parseCoderArgv(args: readonly string[]): ParseCoderArgvResult {
  const attachmentPaths: string[] = [];
  let project: string | undefined;
  const positional: string[] = [];
  const tokens = [...args];

  while (tokens.length > 0) {
    const token = tokens.shift()!;
    if (token === "--") {
      positional.push(...tokens);
      break;
    }
    if (token === "--attach") {
      attachmentPaths.push(requireOptionPath("--attach", tokens.shift()));
      continue;
    }
    if (token.startsWith("--attach=")) {
      attachmentPaths.push(
        requireOptionPath("--attach", token.slice("--attach=".length)),
      );
      continue;
    }
    if (token === "--project") {
      project = requireOptionPath("--project", tokens.shift());
      continue;
    }
    if (token.startsWith("--project=")) {
      project = requireOptionPath("--project", token.slice("--project=".length));
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      throw new CliUsageError(`unknown coder option: ${token}`);
    }
    positional.push(token);
  }

  let phase: CoderPhase = "apply";
  if (positional[0] === "plan" || positional[0] === "apply") {
    phase = positional.shift() as CoderPhase;
  }

  return {
    phase,
    instruction: positional.join(" "),
    attachmentPaths,
    ...(project === undefined ? {} : { project }),
  };
}

async function freezeRegularFileAttachment(
  sourcePath: string,
  destinationDir: string,
  index: number,
): Promise<FrozenAttachment> {
  const absolute = isAbsolute(sourcePath) ? sourcePath : resolve(sourcePath);
  let st;
  try {
    st = await lstat(absolute);
  } catch (error) {
    throw new CliUsageError(
      `attachment is not a readable regular file: ${sourcePath}`,
      { cause: error },
    );
  }
  if (!st.isFile() || st.isSymbolicLink()) {
    throw new CliUsageError(
      `attachment must be a regular file (not a directory or symlink): ${sourcePath}`,
    );
  }
  const bytes = await readFile(absolute);
  const name = `${String(index).padStart(2, "0")}-${basename(absolute)}`;
  const frozenPath = join(destinationDir, name);
  await writeFile(frozenPath, bytes);
  return {
    provenancePath: absolute,
    frozenPath,
    byteLength: bytes.byteLength,
    sha256: sha256Hex(bytes),
    mediaKind: "regular-file",
  };
}

export type AdmitJudgeInvocationOptions = {
  home: string;
  cwd: string;
  instruction: string;
  attachmentPaths: readonly string[];
  project?: string;
  /** Injectable clock/id for tests. */
  createRunId?: () => string;
};

/**
 * Atomically admit a Judge Role run: freeze Attachments, persist the request,
 * and reserve session placement under the #78 ledger book.
 */
export async function admitJudgeInvocation(
  options: AdmitJudgeInvocationOptions,
): Promise<AdmittedJudgeInvocation> {
  // Empty project override must not reach resolve("") → cwd (silent default).
  if (options.project !== undefined) {
    requireOptionPath("--project", options.project);
  }
  const projectRoot = resolve(options.project ?? options.cwd);
  const bookKey = resolveBookKeyFromGit(projectRoot);
  const ledgerHome = resolveActivationLedgerHome(() => options.home);
  const runId = (options.createRunId ?? uuidv7)();
  const runDirectory = join(
    activationBookDirectory(ledgerHome, bookKey),
    "runs",
    `${runId}@judge`,
  );
  const sessionDirectory = join(runDirectory, "session");
  const sessionFile = roleRunSessionFile(sessionDirectory);
  const attachmentsDirectory = join(runDirectory, "attachments");
  ensureRealDirectoryTree(ledgerHome, sessionDirectory);
  ensureRealDirectoryTree(ledgerHome, attachmentsDirectory);

  const attachments: FrozenAttachment[] = [];
  for (let i = 0; i < options.attachmentPaths.length; i += 1) {
    attachments.push(
      await freezeRegularFileAttachment(
        options.attachmentPaths[i]!,
        attachmentsDirectory,
        i,
      ),
    );
  }

  const instruction = options.instruction;
  const instructionEmpty = instruction.trim() === "";
  const admitted = {
    role: "judge" as const,
    runId,
    bookKey,
    projectRoot,
    instruction,
    instructionEmpty,
    attachments: attachments.map((a) => ({
      provenancePath: a.provenancePath,
      frozenPath: a.frozenPath,
      byteLength: a.byteLength,
      sha256: a.sha256,
      mediaKind: a.mediaKind,
    })),
  };
  const admittedRequestPath = join(runDirectory, "admitted-request.json");
  await writeFile(admittedRequestPath, `${JSON.stringify(admitted, null, 2)}\n`, "utf8");

  return {
    role: "judge",
    runId,
    bookKey,
    projectRoot,
    instruction,
    instructionEmpty,
    attachments,
    runDirectory,
    sessionDirectory,
    sessionFile,
    admittedRequestPath,
  };
}

/**
 * Build the Pi prompt transport for an admitted Judge request.
 * Empty public requests receive the canonical nonblank transport envelope only —
 * no invented semantic task content.
 */
export function buildJudgeTransportPrompt(
  admitted: AdmittedJudgeInvocation,
): string {
  const lines: string[] = [];
  if (admitted.instructionEmpty) {
    lines.push(EMPTY_INVOCATION_TRANSPORT_ENVELOPE);
  } else {
    lines.push(admitted.instruction);
  }
  if (admitted.attachments.length > 0) {
    lines.push("");
    lines.push("Admitted Attachments (frozen snapshot paths; read these bytes):");
    for (const attachment of admitted.attachments) {
      lines.push(`- ${attachment.frozenPath}`);
    }
  }
  return lines.join("\n");
}

/** Load admitted-request.json written at admission (Navigator work-context seam). */
export async function loadAdmittedJudgeRequest(
  runDirectory: string,
): Promise<{
  instruction: string;
  instructionEmpty: boolean;
  attachments: readonly FrozenAttachment[];
} | undefined> {
  try {
    const raw = JSON.parse(
      await readFile(join(runDirectory, "admitted-request.json"), "utf8"),
    ) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const record = raw as Record<string, unknown>;
    if (record.role !== "judge") return undefined;
    if (typeof record.instruction !== "string") return undefined;
    if (typeof record.instructionEmpty !== "boolean") return undefined;
    if (!Array.isArray(record.attachments)) return undefined;
    return {
      instruction: record.instruction,
      instructionEmpty: record.instructionEmpty,
      attachments: record.attachments as FrozenAttachment[],
    };
  } catch {
    return undefined;
  }
}

export async function ensureRunArtifactsDir(runDirectory: string): Promise<string> {
  const dir = join(runDirectory, "artifacts");
  await mkdir(dir, { recursive: true });
  return dir;
}

export type AdmitCoderInvocationOptions = {
  home: string;
  cwd: string;
  phase: CoderPhase;
  instruction: string;
  attachmentPaths: readonly string[];
  project?: string;
  createRunId?: () => string;
};

/**
 * Admit a Coder Role run on the common Invocation request.
 * Nonblank task remains authoritative: blank instruction is a structural reject.
 * Phase (default apply / explicit plan) is frozen into the admitted request.
 */
export async function admitCoderInvocation(
  options: AdmitCoderInvocationOptions,
): Promise<AdmittedCoderInvocation> {
  if (options.project !== undefined) {
    requireOptionPath("--project", options.project);
  }
  const instruction = options.instruction;
  if (instruction.trim() === "") {
    throw new CliUsageError(
      "coder requires a nonblank task instruction",
    );
  }
  if (options.phase !== "plan" && options.phase !== "apply") {
    throw new CliUsageError("coder phase must be plan or apply");
  }

  const projectRoot = resolve(options.project ?? options.cwd);
  const bookKey = resolveBookKeyFromGit(projectRoot);
  const ledgerHome = resolveActivationLedgerHome(() => options.home);
  const runId = (options.createRunId ?? uuidv7)();
  const runDirectory = join(
    activationBookDirectory(ledgerHome, bookKey),
    "runs",
    `${runId}@coder`,
  );
  const sessionDirectory = join(runDirectory, "session");
  const sessionFile = roleRunSessionFile(sessionDirectory);
  const attachmentsDirectory = join(runDirectory, "attachments");
  ensureRealDirectoryTree(ledgerHome, sessionDirectory);
  ensureRealDirectoryTree(ledgerHome, attachmentsDirectory);

  const attachments: FrozenAttachment[] = [];
  for (let i = 0; i < options.attachmentPaths.length; i += 1) {
    attachments.push(
      await freezeRegularFileAttachment(
        options.attachmentPaths[i]!,
        attachmentsDirectory,
        i,
      ),
    );
  }

  const taskPath = join(runDirectory, "task.md");
  await writeFile(taskPath, instruction, "utf8");

  const admitted = {
    role: "coder" as const,
    phase: options.phase,
    runId,
    bookKey,
    projectRoot,
    instruction,
    instructionEmpty: false,
    taskPath,
    attachments: attachments.map((a) => ({
      provenancePath: a.provenancePath,
      frozenPath: a.frozenPath,
      byteLength: a.byteLength,
      sha256: a.sha256,
      mediaKind: a.mediaKind,
    })),
  };
  const admittedRequestPath = join(runDirectory, "admitted-request.json");
  await writeFile(admittedRequestPath, `${JSON.stringify(admitted, null, 2)}\n`, "utf8");

  return {
    role: "coder",
    phase: options.phase,
    runId,
    bookKey,
    projectRoot,
    instruction,
    instructionEmpty: false,
    attachments,
    runDirectory,
    sessionDirectory,
    sessionFile,
    admittedRequestPath,
    taskPath,
  };
}

/**
 * Build the Pi prompt transport for an admitted Coder request.
 * Task bytes already live at taskPath for --ak-coder-task; the prompt carries
 * the same instruction plus frozen Attachment paths.
 */
export function buildCoderTransportPrompt(
  admitted: AdmittedCoderInvocation,
): string {
  const lines: string[] = [admitted.instruction];
  if (admitted.attachments.length > 0) {
    lines.push("");
    lines.push("Admitted Attachments (frozen snapshot paths; read these bytes):");
    for (const attachment of admitted.attachments) {
      lines.push(`- ${attachment.frozenPath}`);
    }
  }
  return lines.join("\n");
}
