/**
 * Public Invocation request admission: optional opaque instruction, frozen
 * Attachments, project default/override (ADR 0052 / #106).
 */
import { execFileSync } from "node:child_process";
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
import {
  COLLECTOR_FIXED_KICKOFF,
  COLLECTOR_LEG_ID_PATTERN,
  loadCollectorManifest,
  parseCollectorPrNumber,
  parseCollectorRepository,
  type CollectorRepository,
} from "../collector-config.ts";
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

export type CollectorLegDeclaration = {
  readonly id: string;
  readonly expectedAuthors: readonly string[];
};

export type AdmittedCollectorInvocation = AdmittedRoleInvocationBase & {
  readonly role: "collector";
  readonly prNumber: number;
  readonly repository: CollectorRepository;
  /** Retained assembled leg manifest path for --ak-collector-legs. */
  readonly legsPath: string;
  readonly manifestDigest: string;
};

export type AdmittedRoleInvocation =
  | AdmittedJudgeInvocation
  | AdmittedCoderInvocation
  | AdmittedCollectorInvocation;

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

export type ParseCollectorArgvResult = {
  prNumber: number;
  legs: CollectorLegDeclaration[];
  instruction: string;
  attachmentPaths: string[];
  project?: string;
  repo?: string;
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

/**
 * Parse one public Collector leg declaration: `id:author[,author...]`.
 * Authors are structural tokens only — never inferred from instruction prose.
 */
export function parseCollectorLegDeclaration(
  raw: string,
): CollectorLegDeclaration {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new CliUsageError("collector --leg requires id:author[,author...]");
  }
  const colon = trimmed.indexOf(":");
  if (colon <= 0 || colon === trimmed.length - 1) {
    throw new CliUsageError(
      `collector --leg must be id:author[,author...], got ${raw}`,
    );
  }
  const id = trimmed.slice(0, colon);
  if (!COLLECTOR_LEG_ID_PATTERN.test(id)) {
    throw new CliUsageError(
      `collector leg id must match ^[a-z][a-z0-9._-]{0,63}$, got ${id}`,
    );
  }
  const authorsPart = trimmed.slice(colon + 1);
  const expectedAuthors: string[] = [];
  for (const piece of authorsPart.split(",")) {
    if (piece.trim() === "" || piece !== piece.trim()) {
      // Reject empty slots and surrounding whitespace inside tokens.
      if (piece.trim() === "") {
        throw new CliUsageError(
          `collector --leg ${id} has an empty expected author slot`,
        );
      }
      throw new CliUsageError(
        `collector --leg ${id} expected author must not include surrounding whitespace`,
      );
    }
    expectedAuthors.push(piece);
  }
  if (expectedAuthors.length === 0) {
    throw new CliUsageError(
      `collector --leg ${id} requires at least one expected author`,
    );
  }
  return { id, expectedAuthors };
}

function parsePositivePrOption(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    throw new CliUsageError("--pr requires a positive pull request number");
  }
  try {
    return parseCollectorPrNumber(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(detail, { cause: error });
  }
}

function parseRepoOption(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") {
    throw new CliUsageError("--repo requires owner/repo");
  }
  return raw;
}

/**
 * Parse Collector-specific argv after the `collector` token.
 * PR number and leg declarations are structural; instruction prose is never mined.
 */
export function parseCollectorArgv(
  args: readonly string[],
): ParseCollectorArgvResult {
  const attachmentPaths: string[] = [];
  let project: string | undefined;
  let repo: string | undefined;
  let prNumber: number | undefined;
  const legs: CollectorLegDeclaration[] = [];
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
    if (token === "--pr") {
      prNumber = parsePositivePrOption(tokens.shift());
      continue;
    }
    if (token.startsWith("--pr=")) {
      prNumber = parsePositivePrOption(token.slice("--pr=".length));
      continue;
    }
    if (token === "--repo") {
      repo = parseRepoOption(tokens.shift());
      continue;
    }
    if (token.startsWith("--repo=")) {
      repo = parseRepoOption(token.slice("--repo=".length));
      continue;
    }
    if (token === "--leg") {
      const value = tokens.shift();
      if (value === undefined || value.trim() === "") {
        throw new CliUsageError("--leg requires id:author[,author...]");
      }
      legs.push(parseCollectorLegDeclaration(value));
      continue;
    }
    if (token.startsWith("--leg=")) {
      legs.push(parseCollectorLegDeclaration(token.slice("--leg=".length)));
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      throw new CliUsageError(`unknown collector option: ${token}`);
    }
    positional.push(token);
  }

  if (prNumber === undefined) {
    throw new CliUsageError("collector requires --pr <positive-integer>");
  }
  if (legs.length === 0) {
    throw new CliUsageError(
      "collector requires at least one --leg id:author[,author...]",
    );
  }

  return {
    prNumber,
    legs,
    instruction: positional.join(" "),
    attachmentPaths,
    ...(project === undefined ? {} : { project }),
    ...(repo === undefined ? {} : { repo }),
  };
}

/**
 * Resolve owner/repo from the project's `origin` remote (github.com only).
 * Supports https and SSH GitHub URL shapes; never scrapes instruction prose.
 */
export function resolveGitHubRemoteRepository(
  projectRoot: string,
): CollectorRepository {
  let remoteUrl: string;
  try {
    remoteUrl = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new CliUsageError(
      "collector requires a github.com origin remote or an explicit --repo owner/repo",
      { cause: error },
    );
  }
  if (remoteUrl.length === 0) {
    throw new CliUsageError(
      "collector requires a github.com origin remote or an explicit --repo owner/repo",
    );
  }

  const ownerRepo = ownerRepoFromGitHubRemoteUrl(remoteUrl);
  if (ownerRepo === undefined) {
    throw new CliUsageError(
      `collector origin remote must be a github.com owner/repo URL, got ${remoteUrl}`,
    );
  }
  try {
    return parseCollectorRepository(ownerRepo);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(detail, { cause: error });
  }
}

function ownerRepoFromGitHubRemoteUrl(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim();
  // git@github.com:owner/repo.git — exact owner/repo identity only.
  const scp = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(trimmed);
  if (scp) {
    return `${scp[1]}/${stripGitSuffix(scp[2]!)}`;
  }
  // ssh://git@github.com/owner/repo(.git) — exact owner/repo identity only.
  const ssh = /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
    trimmed,
  );
  if (ssh) {
    return `${ssh[1]}/${stripGitSuffix(ssh[2]!)}`;
  }
  // https://github.com/owner/repo(.git) and git://github.com/... — exact two-segment path.
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (!/^github\.com$/i.test(parsed.hostname)) return undefined;
  // Non-identity URL material (query/hash/extra path) is not a repository remote.
  if (parsed.search !== "" || parsed.hash !== "") return undefined;
  const parts = parsed.pathname.split("/").filter((p) => p.length > 0);
  if (parts.length !== 2) return undefined;
  return `${parts[0]}/${stripGitSuffix(parts[1]!)}`;
}

function stripGitSuffix(name: string): string {
  return name.toLowerCase().endsWith(".git") ? name.slice(0, -4) : name;
}

export type AdmitCollectorInvocationOptions = {
  home: string;
  cwd: string;
  prNumber: number;
  legs: readonly CollectorLegDeclaration[];
  instruction?: string;
  attachmentPaths?: readonly string[];
  project?: string;
  /** Explicit owner/repo override; defaults from project origin remote. */
  repo?: string;
  createRunId?: () => string;
};

/**
 * Admit a Collector Role run: assemble the retained leg manifest from typed
 * declarations, resolve repository identity, and place the session under #78.
 * Does not preflight PR/author existence against GitHub.
 */
export async function admitCollectorInvocation(
  options: AdmitCollectorInvocationOptions,
): Promise<AdmittedCollectorInvocation> {
  if (options.project !== undefined) {
    requireOptionPath("--project", options.project);
  }
  if (options.legs.length === 0) {
    throw new CliUsageError(
      "collector requires at least one --leg id:author[,author...]",
    );
  }

  let prNumber: number;
  try {
    prNumber = parseCollectorPrNumber(options.prNumber);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(detail, { cause: error });
  }

  const projectRoot = resolve(options.project ?? options.cwd);
  let repository: CollectorRepository;
  if (options.repo !== undefined) {
    try {
      repository = parseCollectorRepository(options.repo);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new CliUsageError(detail, { cause: error });
    }
  } else {
    repository = resolveGitHubRemoteRepository(projectRoot);
  }

  const bookKey = resolveBookKeyFromGit(projectRoot);
  const ledgerHome = resolveActivationLedgerHome(() => options.home);
  const runId = (options.createRunId ?? uuidv7)();
  const runDirectory = join(
    activationBookDirectory(ledgerHome, bookKey),
    "runs",
    `${runId}@collector`,
  );
  const sessionDirectory = join(runDirectory, "session");
  const sessionFile = roleRunSessionFile(sessionDirectory);
  const attachmentsDirectory = join(runDirectory, "attachments");
  ensureRealDirectoryTree(ledgerHome, sessionDirectory);
  ensureRealDirectoryTree(ledgerHome, attachmentsDirectory);

  const attachments: FrozenAttachment[] = [];
  const attachmentPaths = options.attachmentPaths ?? [];
  for (let i = 0; i < attachmentPaths.length; i += 1) {
    attachments.push(
      await freezeRegularFileAttachment(
        attachmentPaths[i]!,
        attachmentsDirectory,
        i,
      ),
    );
  }

  // v1 public path: legs carry only id + expectedAuthors (no request bodies).
  const legsPath = join(runDirectory, "legs.json");
  const assembled = {
    legs: options.legs.map((leg) => ({
      id: leg.id,
      expectedAuthors: [...leg.expectedAuthors],
    })),
  };
  await writeFile(legsPath, `${JSON.stringify(assembled, null, 2)}\n`, "utf8");

  let manifestDigest: string;
  try {
    const manifest = await loadCollectorManifest(legsPath);
    manifestDigest = manifest.digest;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(detail, { cause: error });
  }

  const instruction = options.instruction ?? "";
  const instructionEmpty = instruction.trim() === "";
  const admitted = {
    role: "collector" as const,
    runId,
    bookKey,
    projectRoot,
    instruction,
    instructionEmpty,
    prNumber,
    repository: repository.canonical,
    repositoryDisplay: repository.display,
    legsPath,
    manifestDigest,
    attachments: attachments.map((a) => ({
      provenancePath: a.provenancePath,
      frozenPath: a.frozenPath,
      byteLength: a.byteLength,
      sha256: a.sha256,
      mediaKind: a.mediaKind,
    })),
  };
  const admittedRequestPath = join(runDirectory, "admitted-request.json");
  await writeFile(
    admittedRequestPath,
    `${JSON.stringify(admitted, null, 2)}\n`,
    "utf8",
  );

  return {
    role: "collector",
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
    prNumber,
    repository,
    legsPath,
    manifestDigest,
  };
}

/**
 * Collector always consumes the fixed packaged kickoff (one-shot observation).
 * Optional public instruction is retained only in the admitted request.
 */
export function buildCollectorTransportPrompt(
  _admitted: AdmittedCollectorInvocation,
): string {
  return COLLECTOR_FIXED_KICKOFF;
}
