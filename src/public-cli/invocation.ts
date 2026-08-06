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

export type AdmittedJudgeInvocation = {
  readonly role: "judge";
  readonly runId: string;
  readonly bookKey: string;
  readonly projectRoot: string;
  /** Optional opaque instruction bytes as submitted (may be empty). */
  readonly instruction: string;
  /** True when the caller supplied no nonblank instruction. */
  readonly instructionEmpty: boolean;
  readonly attachments: readonly FrozenAttachment[];
  readonly runDirectory: string;
  readonly sessionDirectory: string;
  readonly admittedRequestPath: string;
};

export type ParseJudgeArgvResult = {
  instruction: string;
  attachmentPaths: string[];
  project?: string;
};

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
      const value = tokens.shift();
      if (value === undefined) throw new CliUsageError("--attach requires a path");
      attachmentPaths.push(value);
      continue;
    }
    if (token.startsWith("--attach=")) {
      attachmentPaths.push(token.slice("--attach=".length));
      continue;
    }
    if (token === "--project") {
      const value = tokens.shift();
      if (value === undefined) throw new CliUsageError("--project requires a path");
      project = value;
      continue;
    }
    if (token.startsWith("--project=")) {
      project = token.slice("--project=".length);
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
