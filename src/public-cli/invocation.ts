/**
 * Public Invocation request admission: optional opaque instruction, frozen
 * Attachments, project default/override (ADR 0052 / #106).
 */
import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

import {
  activationBookDirectory,
  ensureRealDirectoryTree,
  pathContainedIn,
  resolveActivationLedgerHome,
} from "../activation-ledger-topology.ts";
import { resolveBookKeyFromGit } from "../activation-ledger-git.ts";
import { roleRunSessionCoordinates } from "../sitian-role-run-coordinates.ts";
import { resolveTicketNumberFromAttachmentBodies } from "../ticket-frontmatter.ts";
import {
  loadDoctorCase,
} from "../doctor-evidence.ts";
import type { DoctorCaseIdentity } from "../doctor-contracts.ts";
import {
  COLLECTOR_FIXED_KICKOFF,
  emptyCollectorManifest,
  loadCollectorManifest,
  parseCollectorPrNumber,
  parseCollectorRepository,
  type CollectorRepository,
} from "../collector-config.ts";
import {
  FixerPacketValidationError,
  parseFixerPrerequisites,
  type FixerPrerequisite,
} from "../package-contracts/fixer-packet.ts";
import type { FixerPhase } from "../package-contracts/fixer-output.ts";
import { createProductionMergerGitState } from "../merger-git-state.ts";
import type { MergerGitState } from "../merger-git-state.ts";
import {
  validateMergerInput,
  type MergerInput,
} from "../merger-contracts.ts";
import { sha256Hex } from "../sha256.ts";
import { uuidv7 } from "../uuidv7.ts";
import {
  appendEngineSessionMaterial,
  type EngineSessionMaterial,
} from "../package-resources/engine-material.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  REJECTED_PUBLIC_SPELLINGS,
  createTypedOptionConsumer,
  evaluateTaishiModeOptionContract,
  optionsForOwner,
  resolveTaishiMode,
  type OptionOwner,
  type PublicOptionDefinition,
} from "./option-definitions.ts";

export type FrozenAttachment = {
  /** Original caller path retained only as provenance. */
  readonly provenancePath: string;
  /** Absolute path of the admitted frozen snapshot bytes. */
  readonly frozenPath: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly mediaKind: "regular-file";
};

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
  /**
   * Optional opaque invocation correlation restored from a prior admitted page
   * (ADR 0049 host channel). Admission does not mint ticket-binding ids.
   */
  readonly correlationId?: string;
  /**
   * Typed ticket face from frozen attachment frontmatter (`ticketNumber`).
   * Absent when no attachment carries a valid contract field (unbound).
   */
  readonly ticketNumber?: number;
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

export type AdmittedFixerInvocation = AdmittedRoleInvocationBase & {
  readonly role: "fixer";
  /** Explicit plan or default apply — preserved through admission and continuation. */
  readonly phase: FixerPhase;
  /** Durable opaque instruction path consumed by internal --ak-fix-packet. */
  readonly packetPath: string;
  /** Optional durable prerequisites JSON path for --ak-fixer-prerequisites. */
  readonly prerequisitesPath?: string;
  /** Structurally validated prerequisite declarations frozen at admission. */
  readonly prerequisites: readonly FixerPrerequisite[];
};

export type AdmittedCollectorInvocation = AdmittedRoleInvocationBase & {
  readonly role: "collector";
  readonly prNumber: number;
  readonly repository: CollectorRepository;
  readonly requestManifestPath?: string;
  readonly manifestDigest: string;
};

export type AdmittedDoctorInvocation = AdmittedRoleInvocationBase & {
  readonly role: "doctor";
  /** Positive Issue number that owns the retained single-case evidence. */
  readonly issueNumber: number;
  /** Absolute retained runs root passed to internal --ak-doctor-case. */
  readonly caseRunsPath: string;
  /** Structurally exact case identity from loadDoctorCase (no second packet). */
  readonly caseIdentity: DoctorCaseIdentity;
};

export type AdmittedReviewerInvocation = AdmittedRoleInvocationBase & {
  readonly role: "reviewer";
  /** Required fixed base revision for the pinned review target (ADR 0037). */
  readonly baseRevision: string;
  /**
   * Optional durable authority references/URLs frozen at admission.
   * Spec evidence-child material only — never Standards, never invocation prose promotion.
   */
  readonly authorityRefs: readonly string[];
};

/** Mechanical envelope derived from the active ordinary two-parent merge. */
export type DerivedMergerEnvelope = {
  readonly targetObjectId: string;
  readonly sourceObjectId: string;
  readonly automaticMergeTreeId: string;
  readonly expectedConflictPaths: readonly string[];
  readonly resolutionScope: readonly string[];
};

export type AdmittedMergerInvocation = AdmittedRoleInvocationBase & {
  readonly role: "merger";
  /** Durable internal merger-input JSON path for --ak-merger-input. */
  readonly mergerInputPath: string;
  /** Adapter-derived mechanical facts (not public packet fields). */
  readonly derived: DerivedMergerEnvelope;
};

export type AdmittedRoleInvocation =
  | AdmittedJudgeInvocation
  | AdmittedCoderInvocation
  | AdmittedFixerInvocation
  | AdmittedCollectorInvocation
  | AdmittedDoctorInvocation
  | AdmittedReviewerInvocation
  | AdmittedMergerInvocation;

type RoleInvocationLedgerSource = Pick<
  AdmittedRoleInvocationBase,
  "runId" | "bookKey" | "projectRoot" | "runDirectory" | "sessionDirectory" | "sessionFile" | "correlationId" | "ticketNumber"
>;

/**
 * Effective provider/model selection recorded on the invocation identity page.
 * thinking is present only when the caller/seat supplied it — bare model omits it.
 */
export type InvocationEffectiveModel = {
  readonly provider: string;
  readonly model: string;
  readonly thinking?: string;
};

/** Project effective model onto ledger fields; absent thinking stays absent. */
function effectiveModelLedgerFields(
  model: InvocationEffectiveModel | undefined,
): Record<string, string> {
  if (model === undefined) return {};
  return {
    provider: model.provider,
    model: model.model,
    ...(model.thinking === undefined ? {} : { thinking: model.thinking }),
  };
}

/**
 * Persist one `invocation.json` identity page for the public run.
 * Admission is the sole source for every field; this is the only identity
 * projection and callers never provide an independent ledger shape.
 * When an effective model is known at admission, provider/model (and thinking
 * only when supplied) are written onto the same page.
 */
async function writeRoleInvocationLedger(
  source: RoleInvocationLedgerSource,
  role: AdmittedRoleInvocation["role"],
  effectiveModel?: InvocationEffectiveModel,
): Promise<void> {
  const identity = {
    role,
    runId: source.runId,
    bookKey: source.bookKey,
    projectRoot: source.projectRoot,
    runDirectory: source.runDirectory,
    sessionDirectory: source.sessionDirectory,
    sessionFile: source.sessionFile,
    ...(source.correlationId === undefined ? {} : { correlationId: source.correlationId }),
    ...(source.ticketNumber === undefined ? {} : { ticketNumber: source.ticketNumber }),
    ...effectiveModelLedgerFields(effectiveModel),
  };
  await writeFile(
    join(source.runDirectory, "invocation.json"),
    `${JSON.stringify(identity, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Merge the effective launch model (and optional initial engine) onto the
 * existing invocation identity page (resume / temporary override path — same
 * field shape as admission write).
 * Bare model clears any prior thinking key so absence stays honest.
 * Engine is write-if-present only: undefined leaves any existing key untouched
 * (resume model merge must not erase initial mechanical provenance).
 */
export async function recordEffectiveInvocationModel(
  runDirectory: string,
  model?: InvocationEffectiveModel,
  engine?: string,
): Promise<void> {
  const ledgerPath = join(runDirectory, "invocation.json");
  const current = JSON.parse(await readFile(ledgerPath, "utf8")) as Record<
    string,
    unknown
  >;
  const next: Record<string, unknown> = { ...current };
  if (model !== undefined) {
    next.provider = model.provider;
    next.model = model.model;
    if (model.thinking === undefined) {
      delete next.thinking;
    } else {
      next.thinking = model.thinking;
    }
  }
  if (engine !== undefined) {
    next.engine = engine;
  }
  await writeFile(
    ledgerPath,
    `${JSON.stringify(next, null, 2)}\n`,
    "utf8",
  );
}

/** Merge observed launch-time fields into the single existing invocation.json identity page. */
async function mergeInvocationIdentityPage(
  runDirectory: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const ledgerPath = join(runDirectory, "invocation.json");
  const current = JSON.parse(await readFile(ledgerPath, "utf8")) as Record<string, unknown>;
  await writeFile(
    ledgerPath,
    `${JSON.stringify({
      ...current,
      ...fields,
    }, null, 2)}\n`,
    "utf8",
  );
}

/** Add the identity returned by the production Pi launch seam to its existing ledger page. */
export async function recordLaunchedPiIdentity(
  runDirectory: string,
  identity: { executable: string; version: string },
): Promise<void> {
  await mergeInvocationIdentityPage(runDirectory, {
    piExecutable: identity.executable,
    piVersion: identity.version,
  });
}

/**
 * Observed role-package launch provenance written onto the same invocation.json page.
 * Values are field observations from the public CLI activation seam — never fixed schema markers.
 */
export type LaunchedRolePackageIdentity = {
  /** Canonical absolute path of the selected Internal role entry (extensions/role-runtime.ts). */
  readonly roleEntry: string;
  /** Canonical absolute package root that owns the entry and bin. */
  readonly rolePackageRoot: string;
  /** package.json version of that root as read at launch. */
  readonly rolePackageVersion: string;
  /** How this process crossed into the role runtime (ADR 0052 public CLI). */
  readonly entryMode: "public-cli";
};

/** Read the package root that is about to serve this public run (observed values only). */
export async function observeLaunchedRolePackageIdentity(
  packageRoot: string,
  selectedRoleEntry: string,
): Promise<LaunchedRolePackageIdentity> {
  const rolePackageRoot = packageRoot;
  const raw = JSON.parse(
    await readFile(join(rolePackageRoot, "package.json"), "utf8"),
  ) as { version?: unknown };
  if (typeof raw.version !== "string" || raw.version.trim() === "") {
    throw new Error(
      `role package.json at ${rolePackageRoot} does not declare a nonblank version`,
    );
  }
  return {
    roleEntry: selectedRoleEntry,
    rolePackageRoot,
    rolePackageVersion: raw.version,
    entryMode: "public-cli",
  };
}

/** Add the role-package identity resolved at the public launch seam to its existing ledger page. */
export async function recordLaunchedRolePackageIdentity(
  runDirectory: string,
  identity: LaunchedRolePackageIdentity,
): Promise<void> {
  await mergeInvocationIdentityPage(runDirectory, {
    roleEntry: identity.roleEntry,
    rolePackageRoot: identity.rolePackageRoot,
    rolePackageVersion: identity.rolePackageVersion,
    entryMode: identity.entryMode,
  });
}

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

export type ParseFixerArgvResult = {
  phase: FixerPhase;
  instruction: string;
  attachmentPaths: string[];
  /** Optional path to structurally valid prerequisite JSON array. */
  prerequisitesPath?: string;
  project?: string;
};

export type ParseCollectorArgvResult = {
  prNumber: number;
  instruction: string;
  attachmentPaths: string[];
  project?: string;
  repo?: string;
  requestManifestPath?: string;
};

export type ParseDoctorArgvResult = {
  issueNumber: number;
  /** Optional project-relative retained runs root override. */
  runs?: string;
  instruction: string;
  attachmentPaths: string[];
  project?: string;
};

export type ParseReviewerArgvResult = {
  /** Optional caller prose retained only as admitted provenance. */
  instruction: string;
  attachmentPaths: string[];
  /** Required fixed base revision for the pinned review target. */
  baseRevision: string;
  /** Repeatable durable authority references/URLs (exact order preserved). */
  authorityRefs: string[];
  project?: string;
};

export type ParseMergerArgvResult = {
  instruction: string;
  attachmentPaths: string[];
  project?: string;
};

/**
 * #336/#337/#338 taishi public argv — four faces on one registration seam.
 * - issue (default): ticket N and/or project-root P
 * - sweep (#337): optional positional `sweep` and/or --attach paths;
 *   sweep payload rides exactly one typed JSON attachment (not argv/stdin)
 * - cohort: two labeled issue-number groups
 * - model-groups: one or more project-root scope keys
 */
export type ParseTaishiIssueArgv = {
  readonly query: "issue";
  /** Caller ticket / issue number face (#176 numbering space). */
  readonly ticket?: number;
  /** Direct projectRoot mechanical key (ADR 0068). */
  readonly projectRoot?: string;
};

export type ParseTaishiSweepArgv = {
  readonly query: "sweep";
  /**
   * Public CLI attachment paths (--attach). Sweep mode only (#337).
   * Cardinality validated on the sweep run path (exactly one).
   */
  readonly attachmentPaths: readonly string[];
};

export type ParseTaishiCohortArgv = {
  readonly query: "cohort";
  readonly groups: readonly [
    { readonly groupLabel: string; readonly issues: readonly number[] },
    { readonly groupLabel: string; readonly issues: readonly number[] },
  ];
};

export type ParseTaishiModelGroupsArgv = {
  readonly query: "model-groups";
  readonly projectRoots: readonly string[];
};

export type ParseTaishiArgvResult =
  | ParseTaishiIssueArgv
  | ParseTaishiSweepArgv
  | ParseTaishiCohortArgv
  | ParseTaishiModelGroupsArgv;

/** Honest activation-class failure while deriving the active-merge envelope. */
export class MergerEnvelopeDerivationError extends Error {
  readonly code = "merger-envelope-derivation" as const;
  /** Typed cause for #107 classifyPostAdmissionFailure (isTypedActivationError). */
  readonly knownCause = "activation" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MergerEnvelopeDerivationError";
  }
}

/** Reject missing/blank path values so empty overrides cannot silently degrade. */
function requireOptionPath(
  flag: string,
  value: string | undefined,
): string {
  if (value === undefined || value.trim() === "") {
    throw new CliUsageError(
      flag === "--base"
        ? `${flag} requires a nonempty revision`
        : `${flag} requires a path`,
    );
  }
  return value;
}

/** True when token is a retained rejected spelling for the owner (#342). */
function isRejectedPublicSpelling(owner: OptionOwner, token: string): boolean {
  for (const entry of REJECTED_PUBLIC_SPELLINGS) {
    if (entry.owner !== owner) continue;
    for (const spelling of entry.spellings) {
      if (token === spelling || token.startsWith(`${spelling}=`)) return true;
    }
  }
  return false;
}

/** Role option definitions — sole spelling source for the matching parser. */
function roleOptions(owner: Exclude<OptionOwner, "global">): readonly PublicOptionDefinition[] {
  return optionsForOwner(owner);
}

/**
 * Public --authority-ref admission grammar (refs-only).
 * Unique owner for fresh argv and durable resume restore — no string-only parallel.
 * Accepts durable reference tokens as-is; rejects blank and inline Spec prose
 * (whitespace-bearing sentences). Does not fetch, normalize, or judge content.
 */
export function requireAuthorityRef(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new CliUsageError("--authority-ref requires a nonempty durable reference");
  }
  // Spec prose sentences contain whitespace; durable public refs are single tokens.
  if (/\s/.test(value)) {
    throw new CliUsageError(
      "--authority-ref requires a durable reference, not inline Spec prose",
    );
  }
  return value;
}

/**
 * Parse Judge-specific argv after the `judge` token.
 * Spellings from PUBLIC_OPTION_TABLE.judge; rejects burden family (#342).
 */
export function parseJudgeArgv(args: readonly string[]): ParseJudgeArgvResult {
  const attachmentPaths: string[] = [];
  let project: string | undefined;
  const positional: string[] = [];
  const tokens = [...args];
  const definitions = roleOptions("judge");
  const options = createTypedOptionConsumer(definitions);

  while (tokens.length > 0) {
    if (tokens[0] === "--") {
      tokens.shift();
      positional.push(...tokens);
      break;
    }
    const taken = options.takeDashed(tokens);
    if (taken !== undefined) {
      if (taken.def.id === "attach") {
        attachmentPaths.push(requireOptionPath(taken.def.canonical, taken.value));
        continue;
      }
      if (taken.def.id === "project") {
        project = requireOptionPath(taken.def.canonical, taken.value);
        continue;
      }
      throw new CliUsageError(`unknown judge option: ${taken.def.canonical}`);
    }
    const token = tokens.shift()!;
    // Judge owns burden inference — rejected spellings from REJECTED_PUBLIC_SPELLINGS.
    if (isRejectedPublicSpelling("judge", token)) {
      throw new CliUsageError(
        "judge does not accept a public burden selector; Judge infers its own burden",
      );
    }
    if (token.startsWith("-") && token !== "-") {
      throw new CliUsageError(`unknown judge option: ${token}`);
    }
    positional.push(token);
  }

  options.assertRequired();
  return {
    instruction: positional.join(" "),
    attachmentPaths,
    ...(project === undefined ? {} : { project }),
  };
}

/**
 * Parse Coder-specific argv after the `coder` token.
 * Phase defaults to apply; spellings from PUBLIC_OPTION_TABLE.coder (#342).
 */
export function parseCoderArgv(args: readonly string[]): ParseCoderArgvResult {
  const attachmentPaths: string[] = [];
  let project: string | undefined;
  const positional: string[] = [];
  const tokens = [...args];
  const definitions = roleOptions("coder");
  const options = createTypedOptionConsumer(definitions);

  while (tokens.length > 0) {
    if (tokens[0] === "--") {
      tokens.shift();
      positional.push(...tokens);
      break;
    }
    const taken = options.takeDashed(tokens);
    if (taken !== undefined) {
      if (taken.def.id === "attach") {
        attachmentPaths.push(requireOptionPath(taken.def.canonical, taken.value));
        continue;
      }
      if (taken.def.id === "project") {
        project = requireOptionPath(taken.def.canonical, taken.value);
        continue;
      }
      throw new CliUsageError(`unknown coder option: ${taken.def.canonical}`);
    }
    const token = tokens.shift()!;
    if (token.startsWith("-") && token !== "-") {
      throw new CliUsageError(`unknown coder option: ${token}`);
    }
    positional.push(token);
  }

  // Phase aliases + default come solely from the typed coder phase row (#342).
  const phase = options.consumeLeadingPhase(positional);
  options.assertRequired();

  return {
    phase,
    instruction: positional.join(" "),
    attachmentPaths,
    ...(project === undefined ? {} : { project }),
  };
}

/**
 * Parse Fixer-specific argv after the `fixer` token.
 * Phase defaults to apply; spellings from PUBLIC_OPTION_TABLE.fixer (#342).
 */
export function parseFixerArgv(args: readonly string[]): ParseFixerArgvResult {
  const attachmentPaths: string[] = [];
  let project: string | undefined;
  let prerequisitesPath: string | undefined;
  const positional: string[] = [];
  const tokens = [...args];
  const definitions = roleOptions("fixer");
  const options = createTypedOptionConsumer(definitions);

  while (tokens.length > 0) {
    if (tokens[0] === "--") {
      tokens.shift();
      positional.push(...tokens);
      break;
    }
    const taken = options.takeDashed(tokens);
    if (taken !== undefined) {
      if (taken.def.id === "attach") {
        attachmentPaths.push(requireOptionPath(taken.def.canonical, taken.value));
        continue;
      }
      if (taken.def.id === "project") {
        project = requireOptionPath(taken.def.canonical, taken.value);
        continue;
      }
      if (taken.def.id === "prerequisites") {
        prerequisitesPath = requireOptionPath(taken.def.canonical, taken.value);
        continue;
      }
      throw new CliUsageError(`unknown fixer option: ${taken.def.canonical}`);
    }
    const token = tokens.shift()!;
    if (token.startsWith("-") && token !== "-") {
      throw new CliUsageError(`unknown fixer option: ${token}`);
    }
    positional.push(token);
  }

  // Phase aliases + default come solely from the typed fixer phase row (#342).
  const phase = options.consumeLeadingPhase(positional);
  options.assertRequired();

  return {
    phase,
    instruction: positional.join(" "),
    attachmentPaths,
    ...(prerequisitesPath === undefined ? {} : { prerequisitesPath }),
    ...(project === undefined ? {} : { project }),
  };
}

async function freezeRegularFileAttachment(
  sourcePath: string,
  destinationDir: string,
  index: number,
): Promise<{ attachment: FrozenAttachment; body: Buffer }> {
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
    attachment: {
      provenancePath: absolute,
      frozenPath,
      byteLength: bytes.byteLength,
      sha256: sha256Hex(bytes),
      mediaKind: "regular-file",
    },
    body: bytes,
  };
}

/** Freeze attachments and resolve typed ticketNumber from frozen bodies (bind-if-present). */
async function freezeAttachmentsWithTicketNumber(
  attachmentPaths: readonly string[],
  attachmentsDirectory: string,
): Promise<{
  readonly attachments: FrozenAttachment[];
  readonly ticketNumber?: number;
}> {
  const attachments: FrozenAttachment[] = [];
  const bodies: Buffer[] = [];
  for (let i = 0; i < attachmentPaths.length; i += 1) {
    const frozen = await freezeRegularFileAttachment(
      attachmentPaths[i]!,
      attachmentsDirectory,
      i,
    );
    attachments.push(frozen.attachment);
    bodies.push(frozen.body);
  }
  const ticketNumber = resolveTicketNumberFromAttachmentBodies(bodies);
  return {
    attachments,
    ...(ticketNumber === undefined ? {} : { ticketNumber }),
  };
}

function ticketAdmissionFields(
  ticketNumber: number | undefined,
): { ticketNumber?: number } {
  return ticketNumber === undefined ? {} : { ticketNumber };
}

export type AdmitJudgeInvocationOptions = {
  home: string;
  cwd: string;
  instruction: string;
  attachmentPaths: readonly string[];
  project?: string;
  /** Injectable clock/id for tests. */
  createRunId?: () => string;
  /** Effective model for this invocation — written onto invocation.json. */
  model?: InvocationEffectiveModel;
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
  const runId = (options.createRunId ?? uuidv7)();
  const { ledgerHome, bookKey, runDirectory, sessionDirectory, sessionFile } =
    roleRunSessionCoordinates({ cwd: projectRoot, runId, role: "judge", home: options.home });
  const attachmentsDirectory = join(runDirectory, "attachments");
  ensureRealDirectoryTree(ledgerHome, sessionDirectory);
  ensureRealDirectoryTree(ledgerHome, attachmentsDirectory);

  const { attachments, ticketNumber } = await freezeAttachmentsWithTicketNumber(
    options.attachmentPaths,
    attachmentsDirectory,
  );
  const ticketFields = ticketAdmissionFields(ticketNumber);

  const instruction = options.instruction;
  const instructionEmpty = instruction.trim() === "";
  const admitted = {
    role: "judge" as const,
    runId,
    bookKey,
    projectRoot,
    runDirectory,
    sessionDirectory,
    sessionFile,
    ...ticketFields,
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
  await writeRoleInvocationLedger(admitted, admitted.role, options.model);

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
    ...ticketFields,
  };
}

/** Build the Pi prompt transport for an admitted Judge request. */
export function buildJudgeTransportPrompt(
  admitted: AdmittedJudgeInvocation,
  engineMaterial?: EngineSessionMaterial,
): string {
  const lines: string[] = [admitted.instructionEmpty ? "" : admitted.instruction];
  if (admitted.attachments.length > 0) {
    lines.push("");
    lines.push("Admitted Attachments (frozen snapshot paths; read these bytes):");
    for (const attachment of admitted.attachments) {
      lines.push(`- ${attachment.frozenPath}`);
    }
  }
  return appendEngineSessionMaterial(lines, engineMaterial).join("\n");
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
  /** Effective model for this invocation — written onto invocation.json. */
  model?: InvocationEffectiveModel;
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
  const runId = (options.createRunId ?? uuidv7)();
  const { ledgerHome, bookKey, runDirectory, sessionDirectory, sessionFile } =
    roleRunSessionCoordinates({ cwd: projectRoot, runId, role: "coder", home: options.home });
  const attachmentsDirectory = join(runDirectory, "attachments");
  ensureRealDirectoryTree(ledgerHome, sessionDirectory);
  ensureRealDirectoryTree(ledgerHome, attachmentsDirectory);

  const { attachments, ticketNumber } = await freezeAttachmentsWithTicketNumber(
    options.attachmentPaths,
    attachmentsDirectory,
  );
  const ticketFields = ticketAdmissionFields(ticketNumber);

  const taskPath = join(runDirectory, "task.md");
  await writeFile(taskPath, instruction, "utf8");

  const admitted = {
    role: "coder" as const,
    phase: options.phase,
    runId,
    bookKey,
    projectRoot,
    runDirectory,
    sessionDirectory,
    sessionFile,
    ...ticketFields,
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
  await writeRoleInvocationLedger(admitted, admitted.role, options.model);

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
    ...ticketFields,
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

export type AdmitFixerInvocationOptions = {
  home: string;
  cwd: string;
  phase: FixerPhase;
  instruction: string;
  attachmentPaths: readonly string[];
  /** Optional caller path to prerequisite JSON array; malformed grammar rejects here. */
  prerequisitesPath?: string;
  project?: string;
  createRunId?: () => string;
  /** Effective model for this invocation — written onto invocation.json. */
  model?: InvocationEffectiveModel;
};

/**
 * Admit a Fixer Role run on the common Invocation request plus optional prerequisites.
 * Nonblank instruction remains authoritative. Phase defaults to apply at parse time.
 * Prerequisite grammar is structural; unmet/insufficient prerequisites stay Fixer judgments.
 */
export async function admitFixerInvocation(
  options: AdmitFixerInvocationOptions,
): Promise<AdmittedFixerInvocation> {
  if (options.project !== undefined) {
    requireOptionPath("--project", options.project);
  }
  const instruction = options.instruction;
  if (instruction.trim() === "") {
    throw new CliUsageError(
      "fixer requires a nonblank repair instruction",
    );
  }
  if (options.phase !== "plan" && options.phase !== "apply") {
    throw new CliUsageError("fixer phase must be plan or apply");
  }

  // Validate/read prerequisites before freezing request materials.
  let prerequisites: readonly FixerPrerequisite[] = Object.freeze([]);
  let prerequisitesSource: string | undefined;
  if (options.prerequisitesPath !== undefined) {
    const absolutePrereq = isAbsolute(options.prerequisitesPath)
      ? options.prerequisitesPath
      : resolve(options.prerequisitesPath);
    try {
      prerequisitesSource = await readFile(absolutePrereq, "utf8");
    } catch (error) {
      throw new CliUsageError(
        `fixer prerequisites path is unreadable: ${options.prerequisitesPath}`,
        { cause: error },
      );
    }
    try {
      prerequisites = parseFixerPrerequisites(prerequisitesSource);
    } catch (error) {
      if (error instanceof FixerPacketValidationError) {
        throw new CliUsageError(error.message, { cause: error });
      }
      throw error;
    }
  }

  const projectRoot = resolve(options.project ?? options.cwd);
  const runId = (options.createRunId ?? uuidv7)();
  const { ledgerHome, bookKey, runDirectory, sessionDirectory, sessionFile } =
    roleRunSessionCoordinates({ cwd: projectRoot, runId, role: "fixer", home: options.home });
  const attachmentsDirectory = join(runDirectory, "attachments");
  ensureRealDirectoryTree(ledgerHome, sessionDirectory);
  ensureRealDirectoryTree(ledgerHome, attachmentsDirectory);

  const { attachments, ticketNumber } = await freezeAttachmentsWithTicketNumber(
    options.attachmentPaths,
    attachmentsDirectory,
  );
  const ticketFields = ticketAdmissionFields(ticketNumber);

  let prerequisitesPath: string | undefined;
  if (prerequisitesSource !== undefined) {
    prerequisitesPath = join(runDirectory, "prerequisites.json");
    await writeFile(
      prerequisitesPath,
      `${JSON.stringify(prerequisites, null, 2)}\n`,
      "utf8",
    );
  }

  const packetPath = join(runDirectory, "fix-packet.md");
  await writeFile(packetPath, instruction, "utf8");

  const admitted = {
    role: "fixer" as const,
    phase: options.phase,
    runId,
    bookKey,
    projectRoot,
    runDirectory,
    sessionDirectory,
    sessionFile,
    ...ticketFields,
    instruction,
    instructionEmpty: false,
    packetPath,
    ...(prerequisitesPath === undefined ? {} : { prerequisitesPath }),
    prerequisites: prerequisites.map((entry) => ({
      id: entry.id,
      requirement: entry.requirement,
    })),
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
  await writeRoleInvocationLedger(admitted, admitted.role, options.model);

  return {
    role: "fixer",
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
    packetPath,
    ...(prerequisitesPath === undefined ? {} : { prerequisitesPath }),
    prerequisites,
    ...ticketFields,
  };
}

/**
 * Build the Pi prompt transport for an admitted Fixer request.
 * Instruction bytes live at packetPath; prerequisites at optional path.
 * Diagnosis method is available via package --skill, not forced into this prompt.
 */
export function buildFixerTransportPrompt(
  admitted: AdmittedFixerInvocation,
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

function parsePositivePrOption(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") throw new CliUsageError("--pr requires a positive pull request number");
  try { return parseCollectorPrNumber(raw); } catch (error) { throw new CliUsageError(error instanceof Error ? error.message : String(error), { cause: error }); }
}
function parseRepoOption(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") throw new CliUsageError("--repo requires owner/repo");
  return raw;
}
export function parseCollectorArgv(args: readonly string[]): ParseCollectorArgvResult {
  // Spellings from PUBLIC_OPTION_TABLE.collector (#342).
  const attachmentPaths: string[] = [];
  let project: string | undefined;
  let repo: string | undefined;
  let prNumber: number | undefined;
  let requestManifestPath: string | undefined;
  const positional: string[] = [];
  const tokens = [...args];
  const definitions = roleOptions("collector");
  const options = createTypedOptionConsumer(definitions);
  while (tokens.length > 0) {
    if (tokens[0] === "--") {
      tokens.shift();
      positional.push(...tokens);
      break;
    }
    const taken = options.takeDashed(tokens);
    if (taken !== undefined) {
      if (taken.def.id === "attach") {
        attachmentPaths.push(requireOptionPath(taken.def.canonical, taken.value));
        continue;
      }
      if (taken.def.id === "project") {
        project = requireOptionPath(taken.def.canonical, taken.value);
        continue;
      }
      if (taken.def.id === "pr") {
        prNumber = parsePositivePrOption(taken.value);
        continue;
      }
      if (taken.def.id === "repo") {
        repo = parseRepoOption(taken.value);
        continue;
      }
      if (taken.def.id === "request-manifest") {
        requestManifestPath = requireOptionPath(taken.def.canonical, taken.value);
        continue;
      }
      throw new CliUsageError(`unknown collector option: ${taken.def.canonical}`);
    }
    const token = tokens.shift()!;
    if (token.startsWith("-") && token !== "-") {
      throw new CliUsageError(`unknown collector option: ${token}`);
    }
    positional.push(token);
  }
  // Unconditional required (e.g. --pr) from typed table via shared consumer (#342).
  options.assertRequired();
  return {
    prNumber: prNumber!,
    instruction: positional.join(" "),
    attachmentPaths,
    ...(project === undefined ? {} : { project }),
    ...(repo === undefined ? {} : { repo }),
    ...(requestManifestPath === undefined ? {} : { requestManifestPath }),
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
  instruction?: string;
  attachmentPaths?: readonly string[];
  project?: string;
  /** Explicit owner/repo override; defaults from project origin remote. */
  repo?: string;
  /** Optional public request configuration; copied into the admitted run. */
  requestManifestPath?: string;
  createRunId?: () => string;
  /** Effective model for this invocation — written onto invocation.json. */
  model?: InvocationEffectiveModel;
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

  // Validate optional request-manifest before freezing request materials.
  let manifest = emptyCollectorManifest();
  let manifestCanonicalJson: string | undefined;
  if (options.requestManifestPath !== undefined) {
    try {
      manifest = await loadCollectorManifest(options.requestManifestPath);
      manifestCanonicalJson = manifest.canonicalJson;
    } catch (error) {
      throw new CliUsageError(error instanceof Error ? error.message : String(error), { cause: error });
    }
  }
  const manifestDigest = manifest.digest;

  const runId = (options.createRunId ?? uuidv7)();
  const { ledgerHome, bookKey, runDirectory, sessionDirectory, sessionFile } =
    roleRunSessionCoordinates({ cwd: projectRoot, runId, role: "collector", home: options.home });
  const attachmentsDirectory = join(runDirectory, "attachments");
  ensureRealDirectoryTree(ledgerHome, sessionDirectory);
  ensureRealDirectoryTree(ledgerHome, attachmentsDirectory);

  const { attachments, ticketNumber } = await freezeAttachmentsWithTicketNumber(
    options.attachmentPaths ?? [],
    attachmentsDirectory,
  );
  const ticketFields = ticketAdmissionFields(ticketNumber);

  let requestManifestPath: string | undefined;
  if (manifestCanonicalJson !== undefined) {
    requestManifestPath = join(runDirectory, "request-manifest.json");
    await writeFile(requestManifestPath, manifestCanonicalJson, "utf8");
  }

  const instruction = options.instruction ?? "";
  const instructionEmpty = instruction.trim() === "";
  const admitted = {
    role: "collector" as const,
    runId,
    bookKey,
    projectRoot,
    runDirectory,
    sessionDirectory,
    sessionFile,
    ...ticketFields,
    instruction,
    instructionEmpty,
    prNumber,
    repository: repository.canonical,
    repositoryDisplay: repository.display,
    ...(requestManifestPath === undefined ? {} : { requestManifestPath }),
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
  await writeRoleInvocationLedger(admitted, admitted.role, options.model);

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
    ...(requestManifestPath === undefined ? {} : { requestManifestPath }),
    manifestDigest,
    ...ticketFields,
  };
}

/**
 * Collector always consumes the fixed packaged kickoff (one-shot observation).
 * Optional public instruction is retained only in the admitted request.
 */
export function buildCollectorTransportPrompt(
  _admitted: AdmittedCollectorInvocation,
): string {
  // Exact historical fixed kickoff bytes (one-shot observation).
  return COLLECTOR_FIXED_KICKOFF;
}

/** Positive Issue number grammar shared with Doctor case path identity. */
const DOCTOR_ISSUE_NUMBER_PATTERN = /^[1-9]\d*$/;

/** Match retained Doctor case runs roots (ADR 0017 / loadDoctorCase). */
const DOCTOR_CASE_RUNS_PATH_PATTERN =
  /\/\.ak-roles\/books\/[^/]+\/issues\/([1-9]\d*)\/runs$/;

/**
 * Parse a positive Issue number for public Doctor admission.
 * Leading zeros and non-integers are structural rejects.
 */
export function parseDoctorIssueNumber(raw: string): number {
  const trimmed = raw.trim();
  if (!DOCTOR_ISSUE_NUMBER_PATTERN.test(trimmed)) {
    throw new CliUsageError(
      `doctor --issue must be a positive integer, got ${raw}`,
    );
  }
  return Number(trimmed);
}

/**
 * Parse Doctor-specific argv after the `doctor` token.
 * Requires --issue; optional confined --runs override; common --attach/--project.
 */
export function parseDoctorArgv(args: readonly string[]): ParseDoctorArgvResult {
  // Spellings from PUBLIC_OPTION_TABLE.doctor (#342).
  const attachmentPaths: string[] = [];
  let project: string | undefined;
  let issueRaw: string | undefined;
  let runs: string | undefined;
  const positional: string[] = [];
  const tokens = [...args];
  const definitions = roleOptions("doctor");
  const options = createTypedOptionConsumer(definitions);

  while (tokens.length > 0) {
    if (tokens[0] === "--") {
      tokens.shift();
      positional.push(...tokens);
      break;
    }
    const taken = options.takeDashed(tokens);
    if (taken !== undefined) {
      if (taken.def.id === "issue") {
        if (taken.value === undefined || taken.value.trim() === "") {
          throw new CliUsageError("doctor --issue requires a positive integer");
        }
        issueRaw = taken.value;
        continue;
      }
      if (taken.def.id === "runs") {
        if (taken.value === undefined || taken.value.trim() === "") {
          throw new CliUsageError("doctor --runs requires a path");
        }
        runs = taken.value;
        continue;
      }
      if (taken.def.id === "attach") {
        attachmentPaths.push(requireOptionPath(taken.def.canonical, taken.value));
        continue;
      }
      if (taken.def.id === "project") {
        project = requireOptionPath(taken.def.canonical, taken.value);
        continue;
      }
      throw new CliUsageError(`unknown doctor option: ${taken.def.canonical}`);
    }
    const token = tokens.shift()!;
    if (token.startsWith("-") && token !== "-") {
      throw new CliUsageError(`unknown doctor option: ${token}`);
    }
    positional.push(token);
  }

  // Unconditional required (e.g. --issue) from typed table via shared consumer (#342).
  options.assertRequired();
  const issueNumber = parseDoctorIssueNumber(issueRaw!);

  if (runs !== undefined && runs.trim() === "") {
    throw new CliUsageError("doctor --runs requires a path");
  }

  return {
    issueNumber,
    instruction: positional.join(" "),
    attachmentPaths,
    ...(project === undefined ? {} : { project }),
    ...(runs === undefined ? {} : { runs }),
  };
}

export type AdmitDoctorInvocationOptions = {
  home: string;
  cwd: string;
  issueNumber: number;
  /** Optional project-relative retained runs root override. */
  runs?: string;
  instruction?: string;
  attachmentPaths?: readonly string[];
  project?: string;
  createRunId?: () => string;
  /** Effective model for this invocation — written onto invocation.json. */
  model?: InvocationEffectiveModel;
};

/**
 * Resolve the retained Doctor case runs root from Issue identity.
 * Default is the #78 book locator; optional --runs must stay project-confined
 * and match Doctor case grammar for the same issue number.
 */
export async function resolveDoctorCaseRunsPath(options: {
  home: string;
  projectRoot: string;
  bookKey: string;
  issueNumber: number;
  runs?: string;
}): Promise<string> {
  const ledgerHome = resolveActivationLedgerHome(() => options.home);
  const defaultRuns = join(
    activationBookDirectory(ledgerHome, options.bookKey),
    "issues",
    String(options.issueNumber),
    "runs",
  );

  if (options.runs === undefined) {
    return defaultRuns;
  }

  const raw = options.runs.trim();
  if (raw === "") {
    throw new CliUsageError("doctor --runs requires a path");
  }
  // Project-relative only — absolute overrides would bypass confinement.
  if (isAbsolute(raw)) {
    throw new CliUsageError(
      "doctor --runs must be a project-relative path",
    );
  }
  const resolved = resolve(options.projectRoot, raw);
  if (
    resolved !== options.projectRoot &&
    !pathContainedIn(options.projectRoot, resolved)
  ) {
    throw new CliUsageError(
      "doctor --runs escapes the project root",
    );
  }

  let real: string;
  try {
    real = await realpath(resolved);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(
      `doctor --runs is not a readable retained runs root: ${detail}`,
      { cause: error },
    );
  }

  const normalized = real.split(sep).join("/");
  const match = normalized.match(DOCTOR_CASE_RUNS_PATH_PATTERN);
  if (!match) {
    throw new CliUsageError(
      "doctor --runs must be an .ak-roles/books/<book>/issues/<n>/runs directory",
    );
  }
  if (Number(match[1]) !== options.issueNumber) {
    throw new CliUsageError(
      `doctor --runs issue ${match[1]} does not match --issue ${options.issueNumber}`,
    );
  }
  return real;
}

/**
 * Admit a Doctor Role run: resolve Issue → retained runs root via #78 (or a
 * confined override), construct the structurally exact case identity through
 * loadDoctorCase, and place the Doctor session under the book runs lane.
 * Does not copy session content into a second store.
 */
export async function admitDoctorInvocation(
  options: AdmitDoctorInvocationOptions,
): Promise<AdmittedDoctorInvocation> {
  if (options.project !== undefined) {
    requireOptionPath("--project", options.project);
  }
  if (
    !Number.isInteger(options.issueNumber) ||
    options.issueNumber < 1 ||
    !DOCTOR_ISSUE_NUMBER_PATTERN.test(String(options.issueNumber))
  ) {
    throw new CliUsageError(
      `doctor --issue must be a positive integer, got ${options.issueNumber}`,
    );
  }

  const projectRoot = resolve(options.project ?? options.cwd);
  const runId = (options.createRunId ?? uuidv7)();
  const { ledgerHome, bookKey, runDirectory, sessionDirectory, sessionFile } =
    roleRunSessionCoordinates({ cwd: projectRoot, runId, role: "doctor", home: options.home });

  let caseRunsPath: string;
  try {
    caseRunsPath = await resolveDoctorCaseRunsPath({
      home: options.home,
      projectRoot,
      bookKey,
      issueNumber: options.issueNumber,
      ...(options.runs === undefined ? {} : { runs: options.runs }),
    });
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(detail, { cause: error });
  }

  // Default #78 locator may not exist yet — ensure the empty runs root so
  // loadDoctorCase can form an empty case and Doctor's refusal owns insufficiency.
  if (options.runs === undefined) {
    ensureRealDirectoryTree(ledgerHome, caseRunsPath);
  }

  let caseIdentity: DoctorCaseIdentity;
  try {
    const patient = await loadDoctorCase(caseRunsPath);
    if (patient.identity.issueNumber !== options.issueNumber) {
      throw new CliUsageError(
        `doctor case issue ${patient.identity.issueNumber} does not match --issue ${options.issueNumber}`,
      );
    }
    caseIdentity = patient.identity;
    caseRunsPath = await realpath(caseRunsPath);
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(
      `doctor case could not be constructed from retained evidence: ${detail}`,
      { cause: error },
    );
  }

  const attachmentsDirectory = join(runDirectory, "attachments");
  ensureRealDirectoryTree(ledgerHome, sessionDirectory);
  ensureRealDirectoryTree(ledgerHome, attachmentsDirectory);

  const { attachments, ticketNumber } = await freezeAttachmentsWithTicketNumber(
    options.attachmentPaths ?? [],
    attachmentsDirectory,
  );
  const ticketFields = ticketAdmissionFields(ticketNumber);

  const instruction = options.instruction ?? "";
  const instructionEmpty = instruction.trim() === "";
  const admitted = {
    role: "doctor" as const,
    runId,
    bookKey,
    projectRoot,
    runDirectory,
    sessionDirectory,
    sessionFile,
    ...ticketFields,
    instruction,
    instructionEmpty,
    issueNumber: options.issueNumber,
    caseRunsPath,
    caseIdentity,
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
  await writeRoleInvocationLedger(admitted, admitted.role, options.model);

  return {
    role: "doctor",
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
    issueNumber: options.issueNumber,
    caseRunsPath,
    caseIdentity,
    ...ticketFields,
  };
}

/** Build the Pi prompt transport for an admitted Doctor request. */
export function buildDoctorTransportPrompt(
  admitted: AdmittedDoctorInvocation,
): string {
  const lines: string[] = [admitted.instructionEmpty ? "" : admitted.instruction];
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
 * Parse Reviewer-specific argv after the `reviewer` token.
 * Public flags: --project, required --base, optional repeatable --authority-ref.
 * Reviewer gathers its own evidence; users submit neither attachments nor capability packets.
 * Caller instruction remains scope/procedure provenance — not Spec authority.
 */
export function parseReviewerArgv(
  args: readonly string[],
): ParseReviewerArgvResult {
  // Spellings from PUBLIC_OPTION_TABLE.reviewer (#342). No --attach face.
  const attachmentPaths: string[] = [];
  const authorityRefs: string[] = [];
  let project: string | undefined;
  let baseRevision: string | undefined;
  const positional: string[] = [];
  const tokens = [...args];
  const definitions = roleOptions("reviewer");
  const options = createTypedOptionConsumer(definitions);

  while (tokens.length > 0) {
    if (tokens[0] === "--") {
      tokens.shift();
      positional.push(...tokens);
      break;
    }
    const taken = options.takeDashed(tokens);
    if (taken !== undefined) {
      if (taken.def.id === "project") {
        project = requireOptionPath(taken.def.canonical, taken.value);
        continue;
      }
      if (taken.def.id === "base") {
        baseRevision = requireOptionPath(taken.def.canonical, taken.value);
        continue;
      }
      if (taken.def.id === "authority-ref") {
        authorityRefs.push(requireAuthorityRef(taken.value));
        continue;
      }
      throw new CliUsageError(`unknown reviewer option: ${taken.def.canonical}`);
    }
    const token = tokens.shift()!;
    if (token.startsWith("-") && token !== "-") {
      throw new CliUsageError(`unknown reviewer option: ${token}`);
    }
    positional.push(token);
  }

  // Unconditional required (e.g. --base) from typed table via shared consumer (#342).
  options.assertRequired();
  return {
    instruction: positional.join(" "),
    attachmentPaths,
    baseRevision: baseRevision!,
    authorityRefs,
    ...(project === undefined ? {} : { project }),
  };
}

export type AdmitReviewerInvocationOptions = {
  home: string;
  cwd: string;
  /** Optional caller prose retained only as admitted provenance — never semantic control. */
  instruction: string;
  attachmentPaths: readonly string[];
  baseRevision: string;
  /** Optional durable authority references/URLs; frozen unchanged at admission. */
  authorityRefs?: readonly string[];
  project?: string;
  createRunId?: () => string;
  /** Effective model for this invocation — written onto invocation.json. */
  model?: InvocationEffectiveModel;
};

/**
 * Admit a Reviewer Role run on the fixed base only.
 * Caller instruction is optional provenance; Reviewer acquires issue/authority independently.
 * Optional authorityRefs are frozen as durable references only — not Spec prose.
 */
export async function admitReviewerInvocation(
  options: AdmitReviewerInvocationOptions,
): Promise<AdmittedReviewerInvocation> {
  if (options.project !== undefined) {
    requireOptionPath("--project", options.project);
  }
  if (options.baseRevision.trim() === "") {
    throw new CliUsageError("--base requires a nonempty revision");
  }
  const authorityRefs = Object.freeze(
    (options.authorityRefs ?? []).map((ref) => requireAuthorityRef(ref)),
  );

  const projectRoot = resolve(options.project ?? options.cwd);
  const runId = (options.createRunId ?? uuidv7)();
  const { ledgerHome, bookKey, runDirectory, sessionDirectory, sessionFile } =
    roleRunSessionCoordinates({ cwd: projectRoot, runId, role: "reviewer", home: options.home });
  const attachmentsDirectory = join(runDirectory, "attachments");
  ensureRealDirectoryTree(ledgerHome, sessionDirectory);
  ensureRealDirectoryTree(ledgerHome, attachmentsDirectory);

  // Public parse already rejects attachments; keep freeze loop for structural symmetry.
  const { attachments, ticketNumber } = await freezeAttachmentsWithTicketNumber(
    options.attachmentPaths,
    attachmentsDirectory,
  );
  const ticketFields = ticketAdmissionFields(ticketNumber);

  const instruction = options.instruction;
  const instructionEmpty = instruction.trim() === "";
  const admitted = {
    role: "reviewer" as const,
    runId,
    bookKey,
    projectRoot,
    runDirectory,
    sessionDirectory,
    sessionFile,
    ...ticketFields,
    instruction,
    instructionEmpty,
    baseRevision: options.baseRevision,
    authorityRefs: [...authorityRefs],
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
  await writeRoleInvocationLedger(admitted, admitted.role, options.model);

  return {
    role: "reviewer",
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
    baseRevision: options.baseRevision,
    authorityRefs,
    ...ticketFields,
  };
}

/**
 * Build the Pi prompt transport for an admitted Reviewer request.
 * Semantic input is fixed base only — caller instruction stays provenance on disk.
 * Optional engine material follows the same dual-path coordinates as Judge (#376/#378).
 */
export function buildReviewerTransportPrompt(
  admitted: AdmittedReviewerInvocation,
  engineMaterial?: EngineSessionMaterial,
): string {
  const lines = [
    `Base revision for the fixed review target: ${admitted.baseRevision}`,
    "Use this exact revision as the fixed review point.",
  ];
  return appendEngineSessionMaterial(lines, engineMaterial).join("\n");
}

/**
 * Parse Merger-specific argv after the `merger` token.
 * Spellings from PUBLIC_OPTION_TABLE.merger; internal packet fields rejected (#342).
 */
export function parseMergerArgv(args: readonly string[]): ParseMergerArgvResult {
  const attachmentPaths: string[] = [];
  let project: string | undefined;
  const positional: string[] = [];
  const tokens = [...args];
  const definitions = roleOptions("merger");
  const options = createTypedOptionConsumer(definitions);

  while (tokens.length > 0) {
    if (tokens[0] === "--") {
      tokens.shift();
      positional.push(...tokens);
      break;
    }
    const taken = options.takeDashed(tokens);
    if (taken !== undefined) {
      if (taken.def.id === "attach") {
        attachmentPaths.push(requireOptionPath(taken.def.canonical, taken.value));
        continue;
      }
      if (taken.def.id === "project") {
        project = requireOptionPath(taken.def.canonical, taken.value);
        continue;
      }
      throw new CliUsageError(`unknown merger option: ${taken.def.canonical}`);
    }
    const token = tokens.shift()!;
    // Rejected public spellings (#342) plus other internal packet field faces.
    if (
      isRejectedPublicSpelling("merger", token) ||
      token === "--targetObjectId" ||
      token.startsWith("--targetObjectId=") ||
      token === "--sourceObjectId" ||
      token.startsWith("--sourceObjectId=") ||
      token === "--expectedConflictPaths" ||
      token.startsWith("--expectedConflictPaths=") ||
      token === "--resolutionScope" ||
      token.startsWith("--resolutionScope=")
    ) {
      throw new CliUsageError(
        "merger does not accept public packet fields; the adapter derives the active-merge envelope",
      );
    }
    if (token.startsWith("-") && token !== "-") {
      throw new CliUsageError(`unknown merger option: ${token}`);
    }
    positional.push(token);
  }

  options.assertRequired();
  return {
    instruction: positional.join(" "),
    attachmentPaths,
    ...(project === undefined ? {} : { project }),
  };
}

function mergerMaterialFromUtf8(text: string): MergerInput["materials"]["task"] {
  const bytes = Buffer.from(text, "utf8");
  return Object.freeze({
    bytesBase64: bytes.toString("base64"),
    sha256: sha256Hex(bytes),
  });
}

/**
 * Derive the mechanical Merger envelope from an already-active ordinary merge.
 * Uses the production Git seam (HEAD, sole MERGE_HEAD, AUTO_MERGE, unmerged set).
 * Failures are activation-class facts — not CLI semantic guesses.
 */
export async function deriveMergerEnvelopeFromActiveMerge(
  projectRoot: string,
  gitState: MergerGitState = createProductionMergerGitState(projectRoot),
): Promise<DerivedMergerEnvelope> {
  let state;
  try {
    state = await gitState.activeMerge();
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim() !== ""
        ? error.message
        : "Assigned repository does not have one ordinary in-progress merge";
    throw new MergerEnvelopeDerivationError(message, { cause: error });
  }
  if (state.unmergedPaths.length === 0) {
    throw new MergerEnvelopeDerivationError(
      "Assigned repository does not have one ordinary in-progress merge with a complete conflict set",
    );
  }
  const expectedConflictPaths = Object.freeze([...state.unmergedPaths]);
  // Scope is derived as the complete conflict set; the role may not broaden it.
  const resolutionScope = Object.freeze([...state.unmergedPaths]);
  return Object.freeze({
    targetObjectId: state.targetObjectId,
    sourceObjectId: state.sourceObjectId,
    automaticMergeTreeId: state.automaticMergeTreeId,
    expectedConflictPaths,
    resolutionScope,
  });
}

export type AdmitMergerInvocationOptions = {
  home: string;
  cwd: string;
  instruction: string;
  attachmentPaths: readonly string[];
  project?: string;
  createRunId?: () => string;
  /** Test seam; production binds createProductionMergerGitState(projectRoot). */
  gitState?: MergerGitState;
  /** Effective model for this invocation — written onto invocation.json. */
  model?: InvocationEffectiveModel;
};

/**
 * Admit a Merger Role run on the common Invocation request.
 * Mechanical envelope (parents, AUTO_MERGE, conflicts, scope) is derived from
 * the active merge — callers never supply public packet fields for those facts.
 */
export async function admitMergerInvocation(
  options: AdmitMergerInvocationOptions,
): Promise<AdmittedMergerInvocation> {
  if (options.project !== undefined) {
    requireOptionPath("--project", options.project);
  }
  const instruction = options.instruction;
  if (instruction.trim() === "") {
    throw new CliUsageError("merger requires a nonblank task instruction");
  }

  const projectRoot = resolve(options.project ?? options.cwd);
  // Derive mechanical envelope before placing a run identity so no-merge/drift
  // fails honestly without orphan ledger rows or guessed packet fields.
  const derived = await deriveMergerEnvelopeFromActiveMerge(
    projectRoot,
    options.gitState ?? createProductionMergerGitState(projectRoot),
  );

  const runId = (options.createRunId ?? uuidv7)();
  const { ledgerHome, bookKey, runDirectory, sessionDirectory, sessionFile } =
    roleRunSessionCoordinates({ cwd: projectRoot, runId, role: "merger", home: options.home });
  const attachmentsDirectory = join(runDirectory, "attachments");
  ensureRealDirectoryTree(ledgerHome, sessionDirectory);
  ensureRealDirectoryTree(ledgerHome, attachmentsDirectory);

  const { attachments, ticketNumber } = await freezeAttachmentsWithTicketNumber(
    options.attachmentPaths,
    attachmentsDirectory,
  );
  const ticketFields = ticketAdmissionFields(ticketNumber);

  // Intent materials seed primary-source investigation; the method owns the work.
  const targetIntent = mergerMaterialFromUtf8(
    `Investigate primary sources for target parent ${derived.targetObjectId}. Do not invent intent.`,
  );
  const sourceIntent = mergerMaterialFromUtf8(
    `Investigate primary sources for source parent ${derived.sourceObjectId}. Do not invent intent.`,
  );
  const taskMaterial = mergerMaterialFromUtf8(instruction);
  const authorityMaterial = mergerMaterialFromUtf8(instruction);

  // Validate merger envelope before placing admitted identity.
  const mergerInput = validateMergerInput({
    version: 1,
    attemptId: runId,
    targetObjectId: derived.targetObjectId,
    sourceObjectId: derived.sourceObjectId,
    materials: {
      task: taskMaterial,
      authority: authorityMaterial,
      targetIntent,
      sourceIntent,
    },
    expectedConflictPaths: [...derived.expectedConflictPaths],
    resolutionScope: [...derived.resolutionScope],
    // Authorized checks remain available on the assignment; default none.
    authorizedChecks: [],
  });

  const mergerInputPath = join(runDirectory, "merger-input.json");
  await writeFile(
    mergerInputPath,
    `${JSON.stringify(mergerInput, null, 2)}\n`,
    "utf8",
  );

  const admitted = {
    role: "merger" as const,
    runId,
    bookKey,
    projectRoot,
    runDirectory,
    sessionDirectory,
    sessionFile,
    ...ticketFields,
    instruction,
    instructionEmpty: false,
    mergerInputPath,
    derived: {
      targetObjectId: derived.targetObjectId,
      sourceObjectId: derived.sourceObjectId,
      automaticMergeTreeId: derived.automaticMergeTreeId,
      expectedConflictPaths: [...derived.expectedConflictPaths],
      resolutionScope: [...derived.resolutionScope],
    },
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
  await writeRoleInvocationLedger(admitted, admitted.role, options.model);

  return {
    role: "merger",
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
    mergerInputPath,
    derived: admitted.derived,
    ...ticketFields,
  };
}

/**
 * Build the Pi prompt transport for an admitted Merger request.
 * Every invocation forces package merge-only method expansion before conflict work.
 */
export function buildMergerTransportPrompt(
  admitted: AdmittedMergerInvocation,
): string {
  const lines: string[] = [
    `/skill:resolving-merge-conflicts ${admitted.instruction}`,
  ];
  if (admitted.attachments.length > 0) {
    lines.push("");
    lines.push("Admitted Attachments (frozen snapshot paths; read these bytes):");
    for (const attachment of admitted.attachments) {
      lines.push(`- ${attachment.frozenPath}`);
    }
  }
  return lines.join("\n");
}

const TAISHI_TICKET_NUMBER_PATTERN = /^[1-9]\d*$/;

/**
 * Parse a positive ticket / issue number for public taishi admission.
 * Leading zeros and non-integers are structural rejects (same face as #176).
 * `flag` names the actual argv face in diagnostics (cohort group lists reuse this).
 */
export function parseTaishiTicketNumber(
  raw: string,
  flag: string = "--ticket",
): number {
  const trimmed = raw.trim();
  if (!TAISHI_TICKET_NUMBER_PATTERN.test(trimmed)) {
    throw new CliUsageError(
      `taishi ${flag} must be a positive integer, got ${raw}`,
    );
  }
  const value = Number(trimmed);
  // Digit-only strings beyond MAX_SAFE_INTEGER round or become Infinity — reject.
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CliUsageError(
      `taishi ${flag} must be a positive integer, got ${raw}`,
    );
  }
  return value;
}

function parseTaishiIssueNumberList(raw: string, flag: string): number[] {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new CliUsageError(`${flag} requires a comma-separated positive integer list`);
  }
  const parts = trimmed.split(",").map((part) => part.trim());
  if (parts.some((part) => part === "")) {
    throw new CliUsageError(`${flag} requires a comma-separated positive integer list`);
  }
  // Same numeric rule as --ticket; diagnostic names the actual group flag.
  return parts.map((part) => parseTaishiTicketNumber(part, flag));
}

function requireOptionValue(
  flag: string,
  value: string | undefined,
  what: string,
): string {
  if (value === undefined || value.trim() === "") {
    throw new CliUsageError(`${flag} requires ${what}`);
  }
  return value;
}

/**
 * Parse taishi-specific argv after the `taishi` token (#336/#337/#338).
 * Spellings + mode relation contracts from PUBLIC_OPTION_TABLE.taishi / TAISHI_* (#342).
 * Mode exclusion, conditional requiredness, cardinality, and at-least-one are
 * table-driven — do not restate them as parallel handwritten branches here.
 * Unconditional required:true also goes through the shared consumer.
 */
export function parseTaishiArgv(args: readonly string[]): ParseTaishiArgvResult {
  const valueLists = new Map<string, string[]>();
  const tokens = [...args];
  const definitions = roleOptions("taishi");
  // Shared typed consumer: dashed + positional take, repeatable, required (#342).
  const options = createTypedOptionConsumer(definitions);

  const pushValue = (id: string, value: string): void => {
    const existing = valueLists.get(id);
    if (existing === undefined) valueLists.set(id, [value]);
    else existing.push(value);
  };

  while (tokens.length > 0) {
    if (tokens[0] === "--") {
      tokens.shift();
      if (tokens.length > 0) {
        throw new CliUsageError(`unexpected taishi argument: ${tokens[0]}`);
      }
      break;
    }
    const taken = options.takeDashed(tokens);
    if (taken !== undefined) {
      if (taken.def.valueMetavar === null) {
        pushValue(taken.def.id, "");
        continue;
      }
      if (taken.def.id === "ticket") {
        if (taken.value === undefined || taken.value.trim() === "") {
          throw new CliUsageError("taishi --ticket requires a positive integer");
        }
        pushValue("ticket", taken.value);
        continue;
      }
      if (taken.def.id === "project-root") {
        pushValue(
          "project-root",
          requireOptionPath(taken.def.canonical, taken.value),
        );
        continue;
      }
      if (taken.def.id === "attach") {
        pushValue(
          "attach",
          requireOptionPath(taken.def.canonical, taken.value),
        );
        continue;
      }
      if (taken.def.id === "group-a-label" || taken.def.id === "group-b-label") {
        pushValue(
          taken.def.id,
          requireOptionValue(taken.def.canonical, taken.value, "a label"),
        );
        continue;
      }
      if (
        taken.def.id === "group-a-issues" || taken.def.id === "group-b-issues"
      ) {
        pushValue(
          taken.def.id,
          requireOptionValue(
            taken.def.canonical,
            taken.value,
            "a comma-separated positive integer list",
          ),
        );
        continue;
      }
      throw new CliUsageError(`unknown taishi option: ${taken.def.canonical}`);
    }
    const token = tokens.shift()!;
    if (token.startsWith("-") && token !== "-") {
      throw new CliUsageError(`unknown taishi option: ${token}`);
    }
    // Positional selectors (e.g. sweep) via shared typed consumer — not a parallel list.
    const positional = options.takePositional(token);
    if (positional !== undefined) {
      pushValue(positional.id, "");
      continue;
    }
    throw new CliUsageError(`unexpected taishi argument: ${token}`);
  }

  const counts = new Map<string, number>();
  for (const [id, values] of valueLists) {
    counts.set(id, values.length);
  }
  options.assertRequired();
  const mode = resolveTaishiMode(new Set(counts.keys()));
  const verdict = evaluateTaishiModeOptionContract(mode, counts);
  if (!verdict.ok) {
    throw new CliUsageError(verdict.message);
  }

  if (mode === "cohort") {
    const groupALabel = valueLists.get("group-a-label")![0]!;
    const groupAIssuesRaw = valueLists.get("group-a-issues")![0]!;
    const groupBLabel = valueLists.get("group-b-label")![0]!;
    const groupBIssuesRaw = valueLists.get("group-b-issues")![0]!;
    return {
      query: "cohort",
      groups: [
        {
          groupLabel: groupALabel,
          issues: parseTaishiIssueNumberList(groupAIssuesRaw, "--group-a-issues"),
        },
        {
          groupLabel: groupBLabel,
          issues: parseTaishiIssueNumberList(groupBIssuesRaw, "--group-b-issues"),
        },
      ],
    };
  }

  if (mode === "model-groups") {
    return {
      query: "model-groups",
      projectRoots: valueLists.get("project-root") ?? [],
    };
  }

  if (mode === "sweep") {
    return {
      query: "sweep",
      attachmentPaths: valueLists.get("attach") ?? [],
    };
  }

  const ticketRaw = valueLists.get("ticket")?.[0];
  const projectRoot = valueLists.get("project-root")?.[0];
  return {
    query: "issue",
    ...(ticketRaw === undefined
      ? {}
      : { ticket: parseTaishiTicketNumber(ticketRaw) }),
    ...(projectRoot === undefined ? {} : { projectRoot }),
  };
}
