/**
 * Public Invocation request admission: optional opaque instruction, caller
 * attachment paths as-is, project default/override (ADR 0052 / #106 / #1165).
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import {
  activationBookDirectory,
  ensureRealDirectoryTree,
  homeFromRunDirectory,
  pathContainedIn,
  resolveActivationLedgerHome,
} from "../activation-ledger-topology.ts";
import { resolveBookKeyFromGit } from "../activation-ledger-git.ts";
import {
  ensureRoleRunDirectory,
  ensureRoleRunPlacement,
  formatRunLeaf,
  isUnboundRunDirectory,
  listBookRunDirectories,
  roleRunPlacement,
  type RoleRunSubject,
} from "../role-run-placement.ts";
import type {
  DurablePrincipal,
  DurablePrincipalAuthority,
} from "../host-contracts.ts";
import type { PackagedRole, PublicRoleRecord } from "../packaged-role-registry.ts";
import {
  packagedAdmittedSubject,
  packagedArgvResult,
  packagedBareToken,
  packagedBaseIsRevision,
  packagedEmitsAuthorityRefs,
  packagedPublicInstructionSubject,
  packagedRoleMetadata,
  packagedStoresSourceRunRaw,
  packagedSubjectChoices,
} from "../packaged-role-registry.ts";
import {
  isSafePositiveTicketNumber,
  parseTicketNumber,
  readBoardTicketNumber,
  requireSafePositiveTicketNumber,
} from "../run-ticket-number.ts";
import {
  rewriteRunDirectoryPathFields,
} from "../role-run-relocation.ts";
import { readPageSync, renderCurrentSync, updateSectionSync, writeSectionSync } from "../run-dossier.ts";
import {
  loadDoctorCase,
} from "../doctor-evidence.ts";
import type { DoctorCaseIdentity } from "../doctor-contracts.ts";
import {
  parseCollectorPrNumber,
  parseCollectorRepository,
  type CollectorRepository,
} from "../collector-config.ts";
import { ownerRepoFromGitHubRemoteUrl } from "./github-remote.ts";
import type { FixerPhase } from "../package-contracts/fixer-output.ts";
import { createProductionMergerGitState } from "../merger-git-state.ts";
import type { MergerGitState } from "../merger-git-state.ts";
import {
  validateMergerInput,
  type MergerInput,
} from "../merger-contracts.ts";
import { sha256Hex } from "../sha256.ts";
import { rehomeUnboundTicketProvenance } from "../ticket-provenance.ts";
import { uuidv7 } from "../uuidv7.ts";
import {
  type NotarySourceRunLocator,
} from "../notary-contracts.ts";
import {
  NotarySourceRunError,
  resolveNotarySourceRunLocator,
} from "../notary-source-run.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  REJECTED_PUBLIC_SPELLINGS,
  createTypedOptionConsumer,
  evaluateAnalystModeOptionContract,
  optionsForOwner,
  resolveAnalystMode,
  type OptionOwner,
  type PublicOptionDefinition,
  type TakenTypedOption,
  type TypedOptionConsumer,
} from "./option-definitions.ts";
import type { PublicThinkingLevel } from "./registry.ts";

import { errorText, isRecord } from "../unknown-value.ts";

/** Caller-supplied attachment path recorded as-is (#1165). */
export type FrozenAttachment = {
  readonly path: string;
};

/** Normalize admitted attachment records (caller path only; #1165). */
export function normalizeAdmittedAttachment(raw: unknown): FrozenAttachment | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const path = record.path;
  // Opaque caller path — keep "" / whitespace; only a non-string is absent.
  if (typeof path === "string") return { path };
  return undefined;
}

function admitCallerAttachments(
  attachmentPaths: readonly string[],
): readonly FrozenAttachment[] {
  return attachmentPaths.map((path) => ({ path }));
}

/** Shared admitted Role run identity (#106 common Invocation + #109 Coder). */
export type AdmittedRoleInvocationBase = {
  readonly runId: string;
  readonly bookKey: string;
  readonly projectRoot: string;
  /** Opaque instruction bytes as submitted. */
  readonly instruction: string;
  /** True when the caller supplied a literally empty instruction (length 0). */
  readonly instructionEmpty: boolean;
  readonly attachments: readonly FrozenAttachment[];
  readonly runDirectory: string;
  /** Host-issued opaque durable principal (coordinates only via authority.decode). */
  readonly principal: DurablePrincipal;
  /**
   * Optional opaque invocation correlation restored from a prior admitted page
   * (ADR 0049 host channel). Admission does not mint ticket-binding ids.
   */
  readonly correlationId?: string;
  /** Direct callers retained across same-run resumes, in first-observed order. */
  readonly correlationIds?: readonly string[];
  /**
   * Typed ticketNumber after known-identity reuse or notary source-run inheritance
   * (#635 / #709). Admission does not bind from CLI flag or attachment frontmatter.
   */
  readonly ticketNumber?: number;
  /** Effective model from invocation identity; restored on resume when no CLI model is given. */
  readonly model?: InvocationEffectiveModel;
};

export type AdmittedJudgeInvocation = AdmittedRoleInvocationBase & {
  readonly role: "judge";
};

export type AdmittedCountersignInvocation = AdmittedRoleInvocationBase & {
  readonly role: "countersign";
  /**
   * Parent run directory (#747 / #987 gate same-parent resume). Persisted on first
   * mint when gate supplies parentRunPath; independent of ticket-number lookup.
   */
  readonly sourceRunPath?: string;
};

export type AdmittedGleanerLeftInvocation = AdmittedRoleInvocationBase & {
  readonly role: "gleaner-left";
  /** Required comparison-base revision for the unanchored merge-candidate diff. */
  readonly baseRevision: string;
};

export type AdmittedInspectorInvocation = AdmittedRoleInvocationBase & {
  readonly role: "inspector";
  /** Parent run directory (#747 / #879); independent of dialogue instruction. */
  readonly sourceRunPath?: string;
};

export type AdmittedGatekeeperInvocation = AdmittedRoleInvocationBase & {
  readonly role: "gatekeeper";
};

export type AdmittedNavigatorInvocation = AdmittedRoleInvocationBase & {
  readonly role: "navigator";
};

export type AdmittedAuditorInvocation = AdmittedRoleInvocationBase & {
  readonly role: "auditor";
};

export type AdmittedDiaristInvocation = AdmittedRoleInvocationBase & {
  readonly role: "diarist";
};

export type AdmittedSecretariatInvocation = AdmittedRoleInvocationBase & {
  readonly role: "secretariat";
};

export type CoderPhase = "plan" | "apply";

export type AdmittedCoderInvocation = AdmittedRoleInvocationBase & {
  readonly role: "coder";
  /** Explicit plan or default apply — preserved through admission and continuation. */
  readonly phase: CoderPhase;
};

export type AdmittedFixerInvocation = AdmittedRoleInvocationBase & {
  readonly role: "fixer";
  /** Explicit plan or default apply — preserved through admission and continuation. */
  readonly phase: FixerPhase;
  /** Optional caller --prerequisites path as-is (#1168; package does not read it). */
  readonly prerequisitesPath?: string;
};

export type AdmittedCollectorInvocation = AdmittedRoleInvocationBase & {
  readonly role: "collector";
  /** Bound at admission when explicit --pr; otherwise the LLM locates via host CLI. */
  readonly prNumber?: number;
  readonly repository: CollectorRepository;
  readonly requestManifestPath?: string;
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

export type AdmittedNotaryInvocation = AdmittedRoleInvocationBase & {
  readonly role: "notary";
  /** Absolute source run directory passed to internal --ak-notary-source-run. */
  readonly sourceRunPath: string;
  /** Typed locator identity bound at admission (self-fetch target). */
  readonly sourceRun: NotarySourceRunLocator;
};

/** Durable single-axis Reviewer lens. Parallel default is parse-only omission, never admitted. */
export type ReviewerLens = "completeness" | "correctness";

export type AdmittedReviewerInvocation = AdmittedRoleInvocationBase & {
  readonly role: "reviewer";
  /** Required fixed base revision for the pinned review target (ADR 0037). */
  readonly baseRevision: string;
  /** Frozen single-axis shape for an ordinary Reviewer run; reused on resume. */
  readonly lens: ReviewerLens;
  /**
   * Required durable authority references/URLs frozen at admission.
   * Projected as Skill-internal `--authority` inputs; never free-text reverse-parse.
   */
  readonly authorityRefs: readonly string[];
};

/** Mechanical materials read from current Git state (may be empty). */
export type DerivedMergerEnvelope = {
  readonly targetObjectId: string;
  readonly sourceObjectId: string;
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
  | AdmittedCountersignInvocation
  | AdmittedGleanerLeftInvocation
  | AdmittedInspectorInvocation
  | AdmittedGatekeeperInvocation
  | AdmittedNavigatorInvocation
  | AdmittedAuditorInvocation
  | AdmittedDiaristInvocation
  | AdmittedSecretariatInvocation
  | AdmittedCoderInvocation
  | AdmittedFixerInvocation
  | AdmittedCollectorInvocation
  | AdmittedDoctorInvocation
  | AdmittedNotaryInvocation
  | AdmittedReviewerInvocation
  | AdmittedMergerInvocation;

export type RunDirectoryRelocation = {
  readonly oldRunDirectory: string;
  readonly newRunDirectory: string;
};

/** Persistence projection only — not carried on Admitted (opaque principal owns identity). */
type RoleInvocationLedgerSource = Pick<
  AdmittedRoleInvocationBase,
  "runId" | "bookKey" | "projectRoot" | "runDirectory" | "correlationId" | "ticketNumber"
> & {
  readonly sessionDirectory: string;
  readonly sessionFile: string;
};

/** Shared admission placement from an injected host authority (no consumer Pi default). */
export type AdmissionPlacement = {
  readonly principal: DurablePrincipal;
  readonly sessionDirectory: string;
  readonly sessionFile: string;
  readonly runDirectory: string;
  readonly attachmentsDirectory: string;
  readonly ledgerHome: string;
  readonly bookKey: string;
};

/** Issue a principal from the single authoritative role-run placement. */
export function issueAdmissionPlacement(
  authority: DurablePrincipalAuthority,
  request: {
    readonly cwd: string;
    readonly runId: string;
    readonly role: AdmittedRoleInvocation["role"];
    /** Typed identity, when supplied; never derive it from CLI prose. */
    readonly subject: RoleRunSubject;
    readonly home?: string;
    /** Placement may be computed before a same-ticket lookup without touching disk. */
    readonly materialize?: boolean;
  },
): AdmissionPlacement {
  const ledgerHome = resolveActivationLedgerHome(request.home);
  const bookKey = resolveBookKeyFromGit(request.cwd);
  const placement = roleRunPlacement(ledgerHome, {
    bookKey,
    subject: request.subject,
    runId: request.runId,
    role: request.role,
  });
  if (request.materialize !== false) ensureRoleRunPlacement(ledgerHome, placement);
  return {
    principal: authority.seal(placement),
    ...placement,
    ledgerHome,
    bookKey,
  };
}

/**
 * Unique `admitted` section projection of current.json: top-level sessionDirectory/sessionFile
 * (base wire shape). Memory Admitted keeps only the opaque principal — never dual-carry.
 */
function writeAdmittedRequestPersistence(
  runDirectory: string,
  body: Record<string, unknown>,
  coordinates: { readonly sessionDirectory: string; readonly sessionFile: string },
): void {
  const { principal: _omitPrincipal, ...rest } = body;
  writeSectionSync(runDirectory, "admitted", {
    ...rest,
    sessionDirectory: coordinates.sessionDirectory,
    sessionFile: coordinates.sessionFile,
  });
}

/**
 * Effective provider/model selection recorded on the invocation identity page.
 * thinking is present only when the caller/seat supplied it — bare model omits it.
 * Thinking is opaque pass-through (#683); no local whitelist filter on restore.
 */
export type InvocationEffectiveModel = {
  readonly provider: string;
  readonly model: string;
  readonly thinking?: PublicThinkingLevel;
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

export { homeFromRunDirectory };

/**
 * Persist the `invocation` identity section of current.json for the public run.
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
  writeSectionSync(source.runDirectory, "invocation", identity);
}

/**
 * Merge the effective launch model / engine / host onto the existing invocation
 * identity page (resume / temporary override path — same field shape as admission).
 * Bare model clears any prior thinking key so absence stays honest.
 *
 * Engine axis (#617 Scope 1 / #883): `string` writes, `null` deletes (authoritative
 * seat projection when the live table has no engine/model), `undefined` preserves
 * any existing key for non-authoritative partial updates.
 * Host stays write-if-present (`string` only).
 */
export async function recordEffectiveInvocationModel(
  runDirectory: string,
  model?: InvocationEffectiveModel,
  engine?: string | null,
  host?: string,
  engineModel?: string | null,
): Promise<void> {
  updateSectionSync(runDirectory, "invocation", (current) => {
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
    if (engine === null) {
      delete next.engine;
    } else if (engine !== undefined) {
      next.engine = engine;
    }
    if (engineModel === null) {
      delete next.engineModel;
    } else if (engineModel !== undefined) {
      next.engineModel = engineModel;
    }
    if (host !== undefined) {
      next.host = host;
    }
    return next;
  });
}

/** Merge observed launch-time fields into the single existing invocation section of current.json. */
async function mergeInvocationIdentityPage(
  runDirectory: string,
  fields: Record<string, unknown>,
): Promise<void> {
  updateSectionSync(runDirectory, "invocation", (current) => ({
    ...current,
    ...fields,
  }));
}

/**
 * Persist parent --source-run path onto the admitted section for officer resume lookup (#747).
 * Reuses the existing notary sourceRunPath key; does not invent a new field name.
 */
export async function persistAdmittedSourceRunPath(
  admitted: AdmittedRoleInvocation,
  sourceRunPath: string,
  auditorSubject?: "judge" | "doctor",
): Promise<void> {
  if (sourceRunPath.trim() === "") {
    throw new Error("persistAdmittedSourceRunPath requires a non-empty sourceRunPath");
  }
  updateSectionSync(admitted.runDirectory, "admitted", (current) => {
    if (typeof current.sourceRunPath === "string" && current.sourceRunPath !== sourceRunPath) {
      throw new Error(
        `persistAdmittedSourceRunPath refuses to replace ${current.sourceRunPath} with ${sourceRunPath}`,
      );
    }
    const sameSubject = auditorSubject === undefined || current.auditorSubject === auditorSubject;
    if (current.sourceRunPath === sourceRunPath && sameSubject) return undefined;
    return {
      ...current,
      sourceRunPath,
      ...(auditorSubject === undefined ? {} : { auditorSubject }),
    };
  });
}

/**
 * Bind a post-admission resolved ticketNumber onto the in-memory admitted
 * object and both durable sections (invocation + admitted).
 * A later typed role receipt replaces an earlier assertion (#1025).
 */
export async function bindAdmittedTicketNumber(
  admitted: AdmittedRoleInvocation,
  ticketNumber: number,
): Promise<void> {
  if (admitted.ticketNumber === ticketNumber) return;
  await bindTicketNumberOnRunDirectory(admitted.runDirectory, ticketNumber);
  (admitted as { ticketNumber?: number }).ticketNumber = ticketNumber;
}

/** Persist each direct caller observed while a retained run is resumed. */
export async function recordAdmittedCorrelation(
  admitted: AdmittedRoleInvocation,
  correlationId: string,
): Promise<void> {
  let correlationIds: string[] = [];
  updateSectionSync(admitted.runDirectory, "admitted", (current) => {
    const prior = [
      ...(Array.isArray(current.correlationIds)
        ? current.correlationIds.filter((value): value is string =>
            typeof value === "string" && value.trim() !== ""
          )
        : []),
      ...(typeof current.correlationId === "string" && current.correlationId.trim() !== ""
        ? [current.correlationId]
        : []),
    ];
    correlationIds = [...new Set([...prior, correlationId])];
    return { ...current, correlationId, correlationIds };
  });
  await mergeInvocationIdentityPage(admitted.runDirectory, {
    correlationId,
    correlationIds,
  });
  const mutable = admitted as {
    correlationId?: string;
    correlationIds?: readonly string[];
  };
  mutable.correlationId = correlationId;
  mutable.correlationIds = correlationIds;
}

/** File a role run under its latest typed ticket identity. */
export async function relocateAdmittedRunToTicket(
  admitted: AdmittedRoleInvocation,
  authority: DurablePrincipalAuthority,
  heldLease?: { relocate(runDirectory: string): void },
): Promise<RunDirectoryRelocation | undefined> {
  if (admitted.ticketNumber === undefined || !isUnboundRunDirectory(admitted.runDirectory)) return undefined;
  const oldRunDirectory = admitted.runDirectory;
  const ledgerHome = resolveActivationLedgerHome(homeFromRunDirectory(oldRunDirectory));
  const target = roleRunPlacement(ledgerHome, {
    bookKey: admitted.bookKey,
    subject: { ticketNumber: admitted.ticketNumber },
    runId: admitted.runId,
    role: admitted.role,
  });
  ensureRoleRunDirectory(ledgerHome, dirname(target.runDirectory));
  // Host sealing is pure identity projection, but may reject the coordinates.
  // Keep that failure before the filesystem commit point.
  const principal = authority.seal(target);

  if (admitted.role !== "diarist") {
    const childRunIds = readPageSync(oldRunDirectory, "admitted")?.childDiaristRunIds;
    for (const childRunId of Array.isArray(childRunIds) ? childRunIds : []) {
      if (typeof childRunId !== "string") continue;
      const childDirectory = join(dirname(oldRunDirectory), formatRunLeaf(childRunId, "diarist"));
      // A child that already filed under a ticket keeps its own assertion.
      if (!existsSync(childDirectory)) continue;
      const childTarget = roleRunPlacement(ledgerHome, {
        bookKey: admitted.bookKey,
        subject: { ticketNumber: admitted.ticketNumber },
        runId: childRunId,
        role: "diarist",
      });
      authority.seal(childTarget);
      await bindTicketNumberOnRunDirectory(childDirectory, admitted.ticketNumber);
      await rehomeUnboundTicketProvenance(childDirectory, admitted.ticketNumber, admitted.projectRoot, homeFromRunDirectory(oldRunDirectory));
      ensureRoleRunDirectory(ledgerHome, dirname(childTarget.runDirectory));
      await rename(childDirectory, childTarget.runDirectory);
      // Finished child legs will not settle again; refresh derived host.original
      // after the rename commit. A derived render fault must not undo or block
      // the committed placement (#1161 L1) — note and keep the true cause.
      try {
        renderCurrentSync(childTarget.runDirectory);
      } catch (error) {
        process.stderr.write(
          `[invocation] current.json render refused after child relocate; placement kept: ${childTarget.runDirectory}: ${errorText(error)}\n`,
        );
      }
    }
  }

  // The first ticket assignment moves only an unbound diarist's own diary.
  if (admitted.role === "diarist") {
    await rehomeUnboundTicketProvenance(oldRunDirectory, admitted.ticketNumber, admitted.projectRoot, homeFromRunDirectory(oldRunDirectory));
  }

  // Rename commits the run placement. Diary assignment above is a Sitian append
  // outside the atomic directory move.
  // Persisted paths are resolved from typed run identity on read.
  await rename(oldRunDirectory, target.runDirectory);

  // rename moved the open lock inode with the directory. Transfer cleanup and
  // admitted path ownership immediately after the commit — before any derived
  // render that may refuse (#1161 L1 / BASE order).
  heldLease?.relocate(target.runDirectory);

  const admittedRecord = admitted as unknown as Record<string, unknown>;
  rewriteRunDirectoryPathFields(
    admittedRecord,
    [
      "runDirectory",
      "mergerInputPath",
    ],
    oldRunDirectory,
    target.runDirectory,
  );
  // #1165/#1168: caller file-flag paths stay as given. Obsolete copy fields
  // (taskPath/packetPath) are not rewritten — stock volumes keep their bytes.
  (admitted as { principal: DurablePrincipal }).principal = principal;

  // current.json projects host.original from this run directory. Ownership is
  // already transferred; a refuse still carries the true cause to the caller
  // (#1161 L1) without leaving the leg under the unbound path.
  renderCurrentSync(target.runDirectory);

  return { oldRunDirectory, newRunDirectory: target.runDirectory };
}

/** Persist the exact child identity; later parent binding never inspects siblings. */
export async function recordChildDiaristRun(
  parent: AdmittedRoleInvocation,
  childRunId: string,
): Promise<void> {
  updateSectionSync(parent.runDirectory, "admitted", (page) => {
    const existing = Array.isArray(page.childDiaristRunIds)
      ? page.childDiaristRunIds.filter((runId): runId is string => typeof runId === "string")
      : [];
    const childDiaristRunIds = existing.includes(childRunId) ? existing : [...existing, childRunId];
    return { ...page, childDiaristRunIds };
  });
}

/**
 * Bind ticket identity onto a run directory's durable pages when the admitted
 * object is not in hand (起居郎 accept hook after LLM assertion, #771).
 * Idempotent when the same number is already on the pages.
 */
export async function bindTicketNumberOnRunDirectory(
  runDirectory: string,
  ticketNumber: number,
): Promise<void> {
  requireSafePositiveTicketNumber(
    ticketNumber,
    "bindTicketNumberOnRunDirectory",
  );
  let unchanged = false;
  updateSectionSync(runDirectory, "admitted", (admitted) => {
    if (admitted.ticketNumber === ticketNumber) {
      unchanged = true;
      return undefined;
    }
    return { ...admitted, ticketNumber };
  });
  if (unchanged) return;
  await mergeInvocationIdentityPage(runDirectory, { ticketNumber });
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
 * Observed role-package launch provenance written onto the same state.jsonl invocation row.
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

/** Trim, then the shared ticket spelling. Callers keep their own diagnostic text. */
function rejectUnlessTicketNumber(raw: string, message: string): number {
  const parsed = parseTicketNumber(raw.trim());
  if (parsed === undefined) throw new CliUsageError(message);
  return parsed;
}

/** Positive ticket number for analyst query-scope face (and shared integer parse). */
export function parsePositiveTicketNumber(
  raw: string,
  flag: string,
): number {
  return rejectUnlessTicketNumber(
    raw,
    `${flag} must be a positive integer, got ${raw}`,
  );
}

/**
 * One token scan for public argv.
 * Callers assign values; `--` still ends flag parsing.
 * Analyst keeps its own assignment. Public seats assign in `parsePublicSeatArgv`.
 */
function scanPublicArgv(
  args: readonly string[],
  options: TypedOptionConsumer,
  handlers: {
    readonly onDashed: (taken: TakenTypedOption) => void;
    readonly onBare: (token: string) => void;
    readonly onDoubleDash: (rest: readonly string[]) => void;
  },
): void {
  const tokens = [...args];
  while (tokens.length > 0) {
    if (tokens[0] === "--") {
      tokens.shift();
      handlers.onDoubleDash(tokens);
      return;
    }
    const taken = options.takeDashed(tokens);
    if (taken !== undefined) {
      handlers.onDashed(taken);
      continue;
    }
    handlers.onBare(tokens.shift()!);
  }
}

function appendBareInstruction(
  owner: string,
  token: string,
  positional: string[],
): void {
  if (token.startsWith("-") && token !== "-") {
    throw new CliUsageError(`unknown ${owner} option: ${token}`);
  }
  positional.push(token);
}

/** LLM public seats. Analyst stays on its own deterministic argv. */
export type PublicSeatArgvOwner = Exclude<OptionOwner, "global" | "analyst">;

type SeatArgvFields = {
  attachmentPaths: string[];
  project?: string;
  positional: string[];
  prerequisitesPath?: string;
  prNumber?: number;
  repo?: string;
  requestManifestPath?: string;
  issueNumber?: number;
  runs?: string;
  sourceRun?: string;
  baseRevision?: string;
  lens?: ReviewerLens;
  authorityRefs: string[];
  subject?: "judge" | "doctor";
};

function isMergerInternalPacketFace(token: string): boolean {
  return (
    token === "--targetObjectId" || token.startsWith("--targetObjectId=")
    || token === "--sourceObjectId" || token.startsWith("--sourceObjectId=")
    || token === "--expectedConflictPaths" || token.startsWith("--expectedConflictPaths=")
    || token === "--resolutionScope" || token.startsWith("--resolutionScope=")
  );
}

/** One assignment for every public-seat option id. Owner only selects the table. */
function assignPublicSeatOption(
  owner: PublicSeatArgvOwner,
  taken: TakenTypedOption,
  fields: SeatArgvFields,
): void {
  const value = taken.value;
  switch (taken.def.id) {
    case "attach":
      // #1165: file-flag values are opaque; only a missing argument is a usage error.
      fields.attachmentPaths.push(requireProvidedOptionValue(taken.def.canonical, value));
      return;
    case "project":
      fields.project = requireOptionPath(taken.def.canonical, value);
      return;
    case "subject": {
      const raw = typeof value === "string" ? value.trim() : "";
      const subject = packagedAdmittedSubject(owner, raw);
      if (subject === undefined) {
        const allowed = packagedSubjectChoices(owner)?.join("|") ?? "";
        throw new CliUsageError(
          `${owner} --subject must be ${allowed}, got ${value ?? "(missing)"}`,
        );
      }
      fields.subject = subject;
      return;
    }
    case "source-run": {
      const text = typeof value === "string" ? value : "";
      if (text.trim() === "") {
        throw new CliUsageError(`${owner} --source-run requires a run locator`);
      }
      fields.sourceRun = packagedStoresSourceRunRaw(owner) ? text : text.trim();
      return;
    }
    case "base":
      fields.baseRevision = packagedBaseIsRevision(owner)
        ? requireReviewerBaseRevision(value)
        : requireOptionPath(taken.def.canonical, value);
      return;
    case "lens":
      fields.lens = requireReviewerLens(value);
      return;
    case "authority-ref":
      fields.authorityRefs.push(requireAuthorityRef(value));
      return;
    case "prerequisites":
      // #1168: same opaque file-flag rule as --attach.
      fields.prerequisitesPath = requireProvidedOptionValue(taken.def.canonical, value);
      return;
    case "pr":
      fields.prNumber = parsePositivePrOption(value);
      return;
    case "repo":
      fields.repo = parseRepoOption(value);
      return;
    case "request-manifest":
      // #1165: file-flag values are opaque; only a missing argument is a usage error.
      fields.requestManifestPath = requireProvidedOptionValue(taken.def.canonical, value);
      return;
    case "issue": {
      if (value === undefined || value.trim() === "") {
        throw new CliUsageError("doctor --issue requires a positive integer");
      }
      fields.issueNumber = parseDoctorIssueNumber(value);
      return;
    }
    case "runs": {
      if (value === undefined || value.trim() === "") {
        throw new CliUsageError("doctor --runs requires a path");
      }
      fields.runs = value;
      return;
    }
    default:
      throw new CliUsageError(`unknown ${owner} option: ${taken.def.canonical}`);
  }
}

function rejectSeatBareToken(owner: PublicSeatArgvOwner, token: string): void {
  const bare = packagedBareToken(owner);
  if (bare === "burden" && isRejectedPublicSpelling(owner, token)) {
    throw new CliUsageError(
      "judge does not accept a public burden selector; Judge infers its own burden",
    );
  }
  if (
    bare === "packet"
    && (isRejectedPublicSpelling(owner, token) || isMergerInternalPacketFace(token))
  ) {
    throw new CliUsageError(
      "merger does not accept public packet fields; the adapter reads Git merge materials",
    );
  }
  if (bare === "instruction") {
    if (token.startsWith("-") && token !== "-") {
      throw new CliUsageError(`unknown notary option: ${token}`);
    }
    throw new CliUsageError(
      "notary rejects caller prompt/instruction; only --source-run locator is admitted",
    );
  }
}

/**
 * Sole public-seat argv parse. Seat rows differ by the option table and by
 * which result keys that table produces. Analyst does not enter here.
 */
export function parsePublicSeatArgv(
  owner: PublicSeatArgvOwner,
  args: readonly string[],
): PublicSeatParse {
  if (packagedBareToken(owner) === "burden") {
    const dd = args.indexOf("--");
    const preDd = dd === -1 ? args : args.slice(0, dd);
    for (const token of preDd) {
      if (isRejectedPublicSpelling(owner, token)) {
        throw new CliUsageError(
          "judge does not accept a public burden selector; Judge infers its own burden",
        );
      }
    }
  }
  const fields: SeatArgvFields = {
    attachmentPaths: [],
    positional: [],
    authorityRefs: [],
  };
  const options = createTypedOptionConsumer(roleOptions(owner));
  scanPublicArgv(args, options, {
    onDashed(taken) {
      assignPublicSeatOption(owner, taken, fields);
    },
    onBare(token) {
      rejectSeatBareToken(owner, token);
      appendBareInstruction(owner, token, fields.positional);
    },
    onDoubleDash(rest) {
      if (packagedBareToken(owner) === "instruction" && rest.length > 0) {
        throw new CliUsageError(
          "notary rejects caller prompt/instruction; only --source-run locator is admitted",
        );
      }
      fields.positional.push(...rest);
    },
  });

  const phaseDef = optionsForOwner(owner).find(
    (def) => def.id === "phase" && def.form === "positional",
  );
  const phase = phaseDef === undefined
    ? undefined
    : options.consumeLeadingPhase(fields.positional);
  options.assertRequired();

  const project = fields.project === undefined ? {} : { project: fields.project };
  if (packagedArgvResult(owner) === "source-run") {
    const sourceRun = fields.sourceRun;
    if (sourceRun === undefined || sourceRun.trim() === "") {
      throw new CliUsageError(`${owner} --source-run requires a run locator`);
    }
    return { sourceRun, ...project };
  }
  const instruction = fields.positional.join(" ");
  const material = packagedArgvResult(owner) === "instruction"
    ? { instruction, ...project }
    : { instruction, attachmentPaths: fields.attachmentPaths, ...project };
  return {
    ...material,
    ...(phase === undefined ? {} : { phase }),
    ...(fields.prerequisitesPath === undefined ? {} : { prerequisitesPath: fields.prerequisitesPath }),
    ...(fields.prNumber === undefined ? {} : { prNumber: fields.prNumber }),
    ...(fields.repo === undefined ? {} : { repo: fields.repo }),
    ...(fields.requestManifestPath === undefined ? {} : { requestManifestPath: fields.requestManifestPath }),
    ...(fields.issueNumber === undefined ? {} : { issueNumber: fields.issueNumber }),
    ...(fields.runs === undefined ? {} : { runs: fields.runs }),
    ...(fields.sourceRun === undefined ? {} : { sourceRun: fields.sourceRun }),
    ...(fields.baseRevision === undefined ? {} : { baseRevision: fields.baseRevision }),
    ...(fields.lens === undefined ? {} : { lens: fields.lens }),
    ...(packagedEmitsAuthorityRefs(owner) ? { authorityRefs: fields.authorityRefs } : {}),
    ...(fields.subject === undefined ? {} : { subject: fields.subject }),
  };
}

/**
 * #336/#337/#338/#399 analyst public argv — three live faces on one registration seam.
 * - issue (default): bare whole-book or --ticket N (cwd git common-dir)
 * - sweep (#337): optional positional `sweep` and/or --attach paths;
 *   sweep payload rides exactly one typed JSON attachment (not argv/stdin)
 * - cohort: two labeled issue-number groups
 * --project-root deleted; --model-groups public face disabled (library kernel retained).
 */
export type ParseAnalystIssueArgv = {
  readonly query: "issue";
  /** Caller ticket / issue number face (#176 numbering space). */
  readonly ticket?: number;
};

export type ParseAnalystSweepArgv = {
  readonly query: "sweep";
  /**
   * Public CLI attachment paths (--attach). Sweep mode only (#337).
   * Cardinality validated on the sweep run path (exactly one).
   */
  readonly attachmentPaths: readonly string[];
};

export type ParseAnalystCohortArgv = {
  readonly query: "cohort";
  /** Tokens before cwd-book stamping; bare N resolves at run (#412). */
  readonly groups: readonly [
    {
      readonly groupLabel: string;
      readonly issues: readonly AnalystCohortIssueToken[];
    },
    {
      readonly groupLabel: string;
      readonly issues: readonly AnalystCohortIssueToken[];
    },
  ];
};

export type ParseAnalystArgvResult =
  | ParseAnalystIssueArgv
  | ParseAnalystSweepArgv
  | ParseAnalystCohortArgv;

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

/**
 * #1165 file flags (--attach / --request-manifest): keep the provided string
 * opaque (including spaces and ""). Only a missing argument is a usage error.
 */
function requireProvidedOptionValue(
  flag: string,
  value: string | undefined,
): string {
  if (value === undefined) {
    throw new CliUsageError(`${flag} requires a path`);
  }
  return value;
}

/**
 * Shared Skill-arg token rule for caller-controlled values projected into the
 * space-joined Skill invocation line. Rejects blank, whitespace (smuggles the
 * next option), and a leading `-` (read as the next Skill option). Not a
 * general free-text gate — only the projection admission seam.
 */
function skillArgTokenFault(
  value: string | undefined,
): "empty" | "whitespace" | "optionLike" | undefined {
  if (value === undefined || value.trim() === "") return "empty";
  if (/\s/.test(value)) return "whitespace";
  if (value.startsWith("-")) return "optionLike";
  return undefined;
}

function requireSkillArgToken(
  value: string | undefined,
  messages: { empty: string; whitespace: string; optionLike: string },
): string {
  const fault = skillArgTokenFault(value);
  if (fault !== undefined) throw new CliUsageError(messages[fault]);
  return value as string;
}

/**
 * Durable reviewer base on resume. Same token rule as fresh `--base`,
 * with the resume-owned missing/damaged split.
 */
export function admittedReviewerBaseFault(
  value: string | undefined,
): "missing" | "damaged" | undefined {
  const fault = skillArgTokenFault(value);
  if (fault === undefined) return undefined;
  return fault === "empty" ? "missing" : "damaged";
}

/**
 * Reviewer --base admission: nonempty single Skill-arg token (shared rule with
 * requireAuthorityRef). Multi-token / option-like values smuggle extra flags
 * (e.g. `--lens all`, `--authority x`).
 */
export function requireReviewerBaseRevision(value: string | undefined): string {
  return requireSkillArgToken(value, {
    empty: "--base requires a nonempty revision",
    whitespace: "--base requires a single-token revision",
    optionLike: "--base requires a single-token revision",
  });
}

/** Shared ReviewerLens predicate — sole interpretation owner for fresh + durable. */
export function isReviewerLens(value: unknown): value is ReviewerLens {
  return value === "completeness" || value === "correctness";
}

/** Admitted single-axis lens enum; public `--lens all` and bare omission are not admitted values. */
export function requireReviewerLens(value: string | undefined): ReviewerLens {
  const trimmed = (value ?? "").trim();
  if (!isReviewerLens(trimmed)) {
    throw new CliUsageError("--lens requires completeness or correctness");
  }
  return trimmed;
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
 * Accepts durable reference tokens as-is; rejects blank, inline Spec prose
 * (whitespace-bearing sentences), and option-like leading `-` (Skill-arg boundary).
 * Does not fetch, normalize, or judge content.
 */
export function requireAuthorityRef(value: string | undefined): string {
  return requireSkillArgToken(value, {
    empty: "--authority-ref requires a nonempty durable reference",
    whitespace: "--authority-ref requires a durable reference, not inline Spec prose",
    optionLike: "--authority-ref requires a durable reference, not inline Spec prose",
  });
}

function ticketAdmissionFields(
  ticketNumber: number | undefined,
): { ticketNumber?: number } {
  if (ticketNumber === undefined) return {};
  return {
    ticketNumber: requireSafePositiveTicketNumber(
      ticketNumber,
      "assertedTicketNumber",
    ),
  };
}

/** Project an already-typed summons ticket into admit options. Absent stays absent. */
export function summonedTicketFields(
  ticketNumber: number | undefined,
): { assertedTicketNumber?: number } {
  if (ticketNumber === undefined) return {};
  return { assertedTicketNumber: ticketNumber };
}

/**
 * Fields every public admit call shares, including the summons ticket.
 * Seat runners spread this once; they do not restate ticket placement.
 */
export function admissionCallerOptions(env: {
  readonly home: string;
  readonly principalAuthority: DurablePrincipalAuthority;
  readonly cwd: string;
  readonly createRunId?: () => string;
  readonly model?: InvocationEffectiveModel;
  readonly correlationId?: string;
  readonly boundTicketNumber?: number;
}): {
  readonly home: string;
  readonly principalAuthority: DurablePrincipalAuthority;
  readonly cwd: string;
  readonly createRunId?: () => string;
  readonly model?: InvocationEffectiveModel;
  readonly correlationId?: string;
  readonly assertedTicketNumber?: number;
} {
  return {
    home: env.home,
    principalAuthority: env.principalAuthority,
    cwd: env.cwd,
    ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
    ...(env.model === undefined ? {} : { model: env.model }),
    ...(env.correlationId === undefined || env.correlationId.trim() === ""
      ? {}
      : { correlationId: env.correlationId }),
    ...summonedTicketFields(env.boundTicketNumber),
  };
}

/** Parsed public-seat argv fields the single admit path reads. */
export type PublicSeatParse = {
  readonly instruction?: string;
  readonly attachmentPaths?: readonly string[];
  readonly project?: string;
  readonly phase?: "plan" | "apply";
  readonly prerequisitesPath?: string;
  readonly prNumber?: number;
  readonly repo?: string;
  readonly requestManifestPath?: string;
  readonly issueNumber?: number;
  readonly runs?: string;
  readonly sourceRun?: string;
  readonly baseRevision?: string;
  readonly lens?: "completeness" | "correctness";
  readonly authorityRefs?: readonly string[];
  readonly subject?: "judge" | "doctor";
};

/**
 * Sole admit call. Kind comes from the composition-root record.
 * Placement stays ticketAdmissionFields. Seat field checks live in this function only.
 */
type RoleForAdmission<K extends PublicRoleRecord["admission"]> = Extract<
  PublicRoleRecord,
  { readonly admission: K }
>["role"];

export function admitPublicRole<R extends PackagedRole>(
  role: R,
  parsed: PublicSeatParse,
  env: Parameters<typeof admissionCallerOptions>[0],
  override?: {
    readonly assertedTicketNumber?: number;
    readonly deferPersistence?: boolean;
    /** Locator already resolved on the new-summon path. Absent callers still resolve. */
    readonly resolvedSourceRun?: NotarySourceRunLocator;
  },
): Promise<Extract<AdmittedRoleInvocation, { readonly role: R }>>;
export async function admitPublicRole(
  role: PackagedRole,
  parsed: PublicSeatParse,
  env: Parameters<typeof admissionCallerOptions>[0],
  override?: {
    readonly assertedTicketNumber?: number;
    readonly deferPersistence?: boolean;
    /** Locator already resolved on the new-summon path. Absent callers still resolve. */
    readonly resolvedSourceRun?: NotarySourceRunLocator;
  },
): Promise<AdmittedRoleInvocation> {
  const record = packagedRoleMetadata(role);
  if (record === undefined) {
    throw new CliUsageError(`unknown role: ${role}`);
  }
  const shared = {
    ...admissionCallerOptions(env),
    ...(override?.assertedTicketNumber === undefined
      ? {}
      : { assertedTicketNumber: override.assertedTicketNumber }),
  };
  const instruction = parsed.instruction ?? "";
  const attachmentPaths = parsed.attachmentPaths ?? [];
  const project = parsed.project === undefined ? {} : { project: parsed.project };
  switch (record.admission) {
    case "instruction":
      return admitStandardMaterialInvocation(
        role as RoleForAdmission<"instruction">,
        {
          ...shared,
          instruction,
          attachmentPaths,
          ...project,
        },
      );
    case "court-materials":
      return admitStandardMaterialInvocation("countersign", {
        ...shared,
        instruction,
        attachmentPaths,
        ...project,
        ...(override?.deferPersistence === undefined
          ? {}
          : { deferPersistence: override.deferPersistence }),
      });
    case "worker-task": {
      if (instruction.trim() === "") {
        throw new CliUsageError("coder requires a nonblank task instruction");
      }
      const phase = parsed.phase ?? "apply";
      if (!record.phases.some((item) => item === phase)) {
        throw new CliUsageError("coder phase must be plan or apply");
      }
      // #1168: dispatch text is the first message only — no task.md copy.
      return admitStandardMaterialInvocation("coder", {
        ...shared,
        instruction,
        attachmentPaths,
        ...project,
        placedFields: async () => ({ phase }),
      });
    }
    case "worker-packet": {
      if (instruction.trim() === "") {
        throw new CliUsageError("fixer requires a nonblank repair instruction");
      }
      const phase = parsed.phase ?? "apply";
      if (!record.phases.some((item) => item === phase)) {
        throw new CliUsageError("fixer phase must be plan or apply");
      }
      // #1168: dispatch once as first message; --prerequisites path as-is.
      return admitStandardMaterialInvocation("fixer", {
        ...shared,
        instruction,
        attachmentPaths,
        ...project,
        placedFields: async () => ({
          phase,
          ...(parsed.prerequisitesPath === undefined
            ? {}
            : { prerequisitesPath: parsed.prerequisitesPath }),
        }),
      });
    }
    case "collect-target": {
      const explicitPrNumber = parsed.prNumber;
      const projectRoot = resolve(parsed.project ?? shared.cwd);
      let repository: CollectorRepository;
      if (parsed.repo !== undefined) {
        try {
          repository = parseCollectorRepository(parsed.repo);
        } catch (error) {
          const detail = errorText(error);
          throw new CliUsageError(detail, { cause: error });
        }
      } else {
        repository = resolveGitHubRemoteRepository(projectRoot);
      }
      // #1165: pass caller path as-is; package does not read, validate, or rewrite.
      const admittedCollector = await admitStandardMaterialInvocation("collector", {
        ...shared,
        instruction,
        attachmentPaths,
        ...project,
        placedFields: async () => {
          // #1088: explicit --pr only. Unbound PR is located by the LLM via host CLI.
          return {
            ...(explicitPrNumber === undefined ? {} : { prNumber: explicitPrNumber }),
            repository: repository.canonical,
            repositoryDisplay: repository.display,
            ...(parsed.requestManifestPath === undefined
              ? {}
              : { requestManifestPath: parsed.requestManifestPath }),
          };
        },
      });
      return { ...admittedCollector, repository };
    }
    case "case-identity": {
      if (parsed.issueNumber === undefined) {
        throw new CliUsageError(
          `doctor --issue must be a positive integer, got ${Number.NaN}`,
        );
      }
      const issueNumber = parsed.issueNumber;
      return admitStandardMaterialInvocation("doctor", {
        ...shared,
        instruction,
        attachmentPaths,
        ...project,
        placedFields: async (placed) => {
          let caseRunsPath: string;
          try {
            caseRunsPath = await resolveDoctorCaseRunsPath({
              home: shared.home,
              projectRoot: placed.projectRoot,
              bookKey: placed.bookKey,
              issueNumber,
              ...(parsed.runs === undefined ? {} : { runs: parsed.runs }),
            });
          } catch (error) {
            if (error instanceof CliUsageError) throw error;
            const detail = errorText(error);
            throw new CliUsageError(detail, { cause: error });
          }
          if (parsed.runs === undefined) {
            ensureRealDirectoryTree(placed.ledgerHome, caseRunsPath);
          }
          let caseIdentity: DoctorCaseIdentity;
          try {
            const patient = await loadDoctorCase(
              caseRunsPath,
              parsed.runs === undefined ? undefined : placed.projectRoot,
            );
            if (patient.identity.issueNumber !== issueNumber) {
              throw new CliUsageError(
                `doctor case issue ${patient.identity.issueNumber} does not match --issue ${issueNumber}`,
              );
            }
            caseIdentity = patient.identity;
            caseRunsPath = await realpath(caseRunsPath);
          } catch (error) {
            if (error instanceof CliUsageError) throw error;
            const detail = errorText(error);
            throw new CliUsageError(
              `doctor case could not be constructed from retained evidence: ${detail}`,
              { cause: error },
            );
          }
          return {
            issueNumber,
            caseRunsPath,
            caseIdentity,
          };
        },
      });
    }
    case "source-locator": {
      const projectRoot = resolve(parsed.project ?? shared.cwd);
      let sourceRun = override?.resolvedSourceRun;
      if (sourceRun === undefined) {
        try {
          sourceRun = await resolveNotarySourceRunLocator({
            projectRoot,
            sourceRun: parsed.sourceRun ?? "",
            home: shared.home,
          });
        } catch (error) {
          if (error instanceof NotarySourceRunError) {
            throw new CliUsageError(error.message, { cause: error });
          }
          throw error;
        }
      }
      // Board ticket on the source run wins; otherwise the summons ticket. Code does not infer one.
      const inheritedTicketNumber = await readBoardTicketNumber(sourceRun.runDirectory);
      const knownTicketNumber = inheritedTicketNumber ?? shared.assertedTicketNumber;
      return admitStandardMaterialInvocation("notary", {
        ...shared,
        ...(knownTicketNumber === undefined
          ? {}
          : { assertedTicketNumber: knownTicketNumber }),
        instruction: "",
        attachmentPaths: [],
        ...project,
        recordAttachments: false,
        admittedFields: {
          sourceRunPath: sourceRun.runDirectory,
          sourceRun,
        },
      });
    }
    case "gleaner": {
      const baseRevision = parsed.baseRevision ?? "";
      if (baseRevision.trim() === "") {
        throw new CliUsageError("--base requires a nonempty revision");
      }
      return admitStandardMaterialInvocation("gleaner-left", {
        ...shared,
        instruction,
        attachmentPaths: [],
        ...project,
        recordAttachments: false,
        admittedFields: { baseRevision },
      });
    }
    case "review-basis": {
      if (parsed.lens === undefined) {
        throw new CliUsageError("--lens requires completeness or correctness");
      }
      if (parsed.baseRevision === undefined) {
        throw new CliUsageError("--base requires a nonempty revision");
      }
      const rawRefs = parsed.authorityRefs ?? [];
      if (rawRefs.length === 0) {
        throw new CliUsageError("reviewer requires --authority-ref <ref>");
      }
      const lens = parsed.lens;
      const baseRevision = parsed.baseRevision;
      const authorityRefs = Object.freeze([...rawRefs]);
      const admittedReviewer = await admitStandardMaterialInvocation("reviewer", {
        ...shared,
        instruction,
        attachmentPaths,
        ...project,
        admittedFields: {
          baseRevision,
          lens,
          authorityRefs: [...authorityRefs],
        },
      });
      return { ...admittedReviewer, authorityRefs };
    }
    case "merge-envelope": {
      if (instruction.trim() === "") {
        throw new CliUsageError("merger requires a nonblank task instruction");
      }
      const projectRoot = resolve(parsed.project ?? shared.cwd);
      const derived = await deriveMergerEnvelopeFromActiveMerge(
        projectRoot,
        createProductionMergerGitState(projectRoot),
      );
      return admitStandardMaterialInvocation("merger", {
        ...shared,
        instruction,
        attachmentPaths,
        ...project,
        placedFields: async (placed) => {
          const targetLabel = derived.targetObjectId === "" ? "(none observed)" : derived.targetObjectId;
          const sourceLabel = derived.sourceObjectId === "" ? "(none observed)" : derived.sourceObjectId;
          // #1168: git facts stay; do not encode dispatch text as task/authority copies.
          const mergerInput = validateMergerInput({
            attemptId: placed.runId,
            targetObjectId: derived.targetObjectId,
            sourceObjectId: derived.sourceObjectId,
            materials: {
              targetIntent: mergerMaterialFromUtf8(
                `Investigate primary sources for target parent ${targetLabel}. Do not invent intent.`,
              ),
              sourceIntent: mergerMaterialFromUtf8(
                `Investigate primary sources for source parent ${sourceLabel}. Do not invent intent.`,
              ),
            },
            expectedConflictPaths: [...derived.expectedConflictPaths],
            resolutionScope: [...derived.resolutionScope],
            authorizedChecks: [],
          });
          const mergerInputPath = join(placed.runDirectory, "merger-input.json");
          await writeFile(
            mergerInputPath,
            `${JSON.stringify(mergerInput, null, 2)}\n`,
            "utf8",
          );
          return {
            mergerInputPath,
            derived: {
              targetObjectId: derived.targetObjectId,
              sourceObjectId: derived.sourceObjectId,
              expectedConflictPaths: [...derived.expectedConflictPaths],
              resolutionScope: [...derived.resolutionScope],
            },
          };
        },
      });
    }
  }
}

/** One placement subject: a typed ticket already on the summons, otherwise unbound. */
function admissionSubject(ticketNumber: number | undefined): RoleRunSubject {
  const fields = ticketAdmissionFields(ticketNumber);
  if (fields.ticketNumber === undefined) return { unbound: true };
  return { ticketNumber: fields.ticketNumber };
}

export type AdmitJudgeInvocationOptions = {
  home: string;
  cwd: string;
  instruction: string;
  attachmentPaths: readonly string[];
  project?: string;
  /** Injectable clock/id for tests. */
  createRunId?: () => string;
  principalAuthority: DurablePrincipalAuthority;
  /** Effective model for this invocation — written onto the state.jsonl invocation row. */
  model?: InvocationEffectiveModel;
  /** Typed ticket already on this summons (起居录 / parent board). Never parsed from prose. */
  assertedTicketNumber?: number;
};

export type AdmitInspectorInvocationOptions = AdmitJudgeInvocationOptions & {
  correlationId?: string;
  /** Typed identity from the caller or an already-bound run. */
  assertedTicketNumber?: number;
};

export type AdmitGatekeeperInvocationOptions = AdmitInspectorInvocationOptions;
export type AdmitNavigatorInvocationOptions = AdmitInspectorInvocationOptions;
export type AdmitDiaristInvocationOptions = AdmitInspectorInvocationOptions;
export type AdmitSecretariatInvocationOptions = AdmitInspectorInvocationOptions;

type PlacedRoleAdmission = {
  readonly runId: string;
  readonly bookKey: string;
  readonly projectRoot: string;
  readonly runDirectory: string;
  readonly principal: DurablePrincipal;
  readonly sessionDirectory: string;
  readonly sessionFile: string;
  readonly attachments: readonly FrozenAttachment[];
  readonly attachmentsDirectory: string;
  readonly ledgerHome: string;
  readonly ticketFields: ReturnType<typeof ticketAdmissionFields>;
};

/**
 * One admission placement (#505): typed ticket already on the summons, otherwise unbound.
 * Every public seat persists through this function. Seat-only fields are supplied by the caller.
 */
async function placeRoleAdmission(options: {
  readonly role: AdmittedRoleInvocation["role"];
  readonly home: string;
  readonly principalAuthority: DurablePrincipalAuthority;
  readonly cwd: string;
  readonly project?: string;
  readonly createRunId?: () => string;
  /** Reuse a reserved run id (deferred countersign materialization). */
  readonly runId?: string;
  readonly assertedTicketNumber?: number;
  readonly attachmentPaths: readonly string[];
  /** When false, leave attachments empty (deferred countersign / seats without attach). */
  readonly recordAttachments?: boolean;
  /** Countersign reserves coordinates, then materializes after identity lookup. */
  readonly materialize?: boolean;
}): Promise<PlacedRoleAdmission> {
  const projectRoot = resolve(options.project ?? options.cwd);
  const runId = options.runId ?? (options.createRunId ?? uuidv7)();
  const ticketFields = ticketAdmissionFields(options.assertedTicketNumber);
  const {
    principal,
    sessionDirectory,
    sessionFile,
    runDirectory,
    attachmentsDirectory,
    ledgerHome,
    bookKey,
  } = issueAdmissionPlacement(options.principalAuthority, {
    cwd: projectRoot,
    runId,
    role: options.role,
    subject: admissionSubject(options.assertedTicketNumber),
    home: options.home,
    ...(options.materialize === undefined ? {} : { materialize: options.materialize }),
  });
  const attachments = options.recordAttachments === false
    ? []
    : admitCallerAttachments(options.attachmentPaths);
  return {
    runId,
    bookKey,
    projectRoot,
    runDirectory,
    principal,
    sessionDirectory,
    sessionFile,
    attachments,
    attachmentsDirectory,
    ledgerHome,
    ticketFields,
  };
}

function persistedAttachmentRefs(
  attachments: readonly FrozenAttachment[],
): ReadonlyArray<{ path: string }> {
  return attachments.map((attachment) => ({ path: attachment.path }));
}

async function persistPlacedAdmission(
  admitted: {
    readonly role: AdmittedRoleInvocation["role"];
    readonly runId: string;
    readonly bookKey: string;
    readonly projectRoot: string;
    readonly runDirectory: string;
    readonly principal: DurablePrincipal;
    readonly instruction: string;
    readonly instructionEmpty: boolean;
    readonly correlationId?: string;
    readonly ticketNumber?: number;
    readonly attachments: ReturnType<typeof persistedAttachmentRefs>;
  },
  placed: PlacedRoleAdmission,
  model: InvocationEffectiveModel | undefined,
): Promise<void> {
  writeAdmittedRequestPersistence(placed.runDirectory, admitted, {
    sessionDirectory: placed.sessionDirectory,
    sessionFile: placed.sessionFile,
  });
  await writeRoleInvocationLedger(
    {
      ...admitted,
      sessionDirectory: placed.sessionDirectory,
      sessionFile: placed.sessionFile,
    },
    admitted.role,
    model,
  );
}

/**
 * Shared admission: project check, placement, attachment freeze,
 * admitted and invocation section write.
 * Countersign passes deferPersistence so same-ticket lookup can reserve coordinates
 * before materializeCountersignInvocation writes the page.
 * Seats whose extra facts are known before placement pass them as admittedFields.
 * Seats whose extra facts depend on the placed run pass placedFields
 * (merger writes merger-input.json with git facts; coder/fixer dispatch is first-message only, #1168).
 */
async function admitStandardMaterialInvocation<
  R extends PackagedRole,
  Extra extends object = {},
>(
  role: R,
  options: AdmitInspectorInvocationOptions & {
    /** Reserve coordinates; skip placement disk and admitted section write. */
    readonly deferPersistence?: boolean;
    /** Leave attachments empty (gleaner-left / notary / deferred countersign). */
    readonly recordAttachments?: boolean;
    /** Seat facts already validated by admitPublicRole. */
    readonly admittedFields?: Extra;
    /** Seat facts that exist only after placement. Written before the admitted page. */
    readonly placedFields?: (placed: PlacedRoleAdmission) => Extra | Promise<Extra>;
  },
): Promise<AdmittedRoleInvocationBase & { readonly role: R } & Extra> {
  const defer = options.deferPersistence === true;
  const skipAttachments = defer || options.recordAttachments === false;
  const placed = await placeRoleAdmission({
    role,
    home: options.home,
    principalAuthority: options.principalAuthority,
    cwd: options.cwd,
    attachmentPaths: options.attachmentPaths,
    ...(skipAttachments ? { recordAttachments: false } : {}),
    ...(defer ? { materialize: false } : {}),
    ...(options.project === undefined ? {} : { project: options.project }),
    ...(options.createRunId === undefined ? {} : { createRunId: options.createRunId }),
    ...(options.assertedTicketNumber === undefined
      ? {}
      : { assertedTicketNumber: options.assertedTicketNumber }),
  });
  const correlationFields =
    options.correlationId === undefined
      ? {}
      : { correlationId: options.correlationId };
  const instruction = options.instruction;
  // Admitted emptiness is literal absence, not whitespace-only (#1165 J3).
  const instructionEmpty = instruction.length === 0;
  const placedExtra = options.placedFields === undefined ? undefined : await options.placedFields(placed);
  const admittedFields = {
    ...(options.admittedFields ?? ({} as Extra)),
    ...(placedExtra ?? ({} as Extra)),
  };
  const admitted = {
    role,
    runId: placed.runId,
    bookKey: placed.bookKey,
    projectRoot: placed.projectRoot,
    runDirectory: placed.runDirectory,
    principal: placed.principal,
    ...correlationFields,
    instruction,
    instructionEmpty,
    ...admittedFields,
    attachments: persistedAttachmentRefs(placed.attachments),
    ...placed.ticketFields,
  };
  if (!defer) await persistPlacedAdmission(admitted, placed, options.model);
  return {
    role,
    runId: placed.runId,
    bookKey: placed.bookKey,
    projectRoot: placed.projectRoot,
    instruction,
    instructionEmpty,
    attachments: placed.attachments,
    runDirectory: placed.runDirectory,
    principal: placed.principal,
    ...correlationFields,
    ...placed.ticketFields,
    ...admittedFields,
  };
}

export type AdmitAuditorInvocationOptions = AdmitInspectorInvocationOptions;

type InstructionTransportSource = {
  readonly role?: string;
  readonly instruction: string;
  readonly instructionEmpty?: boolean;
  readonly attachments: readonly { readonly path: string }[];
  readonly requestManifestPath?: string;
  readonly prerequisitesPath?: string;
  readonly baseRevision?: string;
  readonly lens?: ReviewerLens;
  readonly authorityRefs?: readonly string[];
  readonly sourceRunPath?: string;
};

function admittedTransportPromptKind(
  admitted: InstructionTransportSource,
): "instruction" | "fixed-kickoff" | "baseline" | "skill-args" {
  if (admitted.role === undefined) return "instruction";
  const record = packagedRoleMetadata(admitted.role);
  if (record !== undefined && "transportPrompt" in record) return record.transportPrompt;
  return "instruction";
}

/**
 * One initial prompt transport. The registry `transportPrompt` leaf selects
 * a fixed kickoff, a bound baseline, or frozen skill args. Absent means the
 * caller instruction plus caller attachment paths as-is (#1165).
 * Engine / outsourcing material rides startup readingMaterial (#1167), not here.
 */
export function buildInstructionTransportPrompt(
  admitted: InstructionTransportSource,
): string {
  const kind = admittedTransportPromptKind(admitted);
  if (kind === "fixed-kickoff") {
    if (admitted.sourceRunPath === undefined || admitted.sourceRunPath.trim() === "") {
      throw new Error("fixed-kickoff transport prompt is missing the source run pointer");
    }
    return admitted.sourceRunPath;
  }
  if (kind === "baseline") {
    if (admitted.baseRevision === undefined) {
      throw new Error("baseline transport prompt is missing the bound revision");
    }
    const lines = [admitted.baseRevision];
    // Use raw admitted.instruction — do not gate on instructionEmpty metadata
    // (old pages may set that flag wrong while still holding whitespace text).
    if (admitted.instruction.length > 0) {
      lines.push("", admitted.instruction);
    }
    return lines.join("\n");
  }
  if (kind === "skill-args") {
    if (
      admitted.baseRevision === undefined
      || admitted.lens === undefined
      || admitted.authorityRefs === undefined
    ) {
      throw new Error("skill-args transport prompt is missing frozen skill args");
    }
    const lines = [buildReviewerSkillArgProjection({
      baseRevision: admitted.baseRevision,
      lens: admitted.lens,
      authorityRefs: admitted.authorityRefs,
    })];
    if (admitted.instruction.length > 0) {
      lines.push("", admitted.instruction);
    }
    return lines.join("\n");
  }
  // #1165 J3 / #1168: assemble from the admitted instruction bytes themselves.
  const lines: string[] = [admitted.instruction];
  // #1164/#1165/#1168: each caller path keeps its file-flag provenance.
  const flaggedPaths: string[] = [
    ...admitted.attachments.map((attachment) => `--attach ${attachment.path}`),
    ...(admitted.requestManifestPath === undefined
      ? []
      : [`--request-manifest ${admitted.requestManifestPath}`]),
    ...(admitted.prerequisitesPath === undefined
      ? []
      : [`--prerequisites ${admitted.prerequisitesPath}`]),
  ];
  if (flaggedPaths.length > 0) {
    lines.push("");
    lines.push("已受理附件：");
    for (const entry of flaggedPaths) {
      lines.push(`- ${entry}`);
    }
  }
  return lines.join("\n");
}

export type AdmitCountersignInvocationOptions = {
  home: string;
  cwd: string;
  instruction: string;
  attachmentPaths: readonly string[];
  project?: string;
  /** Injectable clock/id for tests. */
  createRunId?: () => string;
  principalAuthority: DurablePrincipalAuthority;
  /** Effective model for this invocation — written onto the state.jsonl invocation row. */
  model?: InvocationEffectiveModel;
  correlationId?: string;
  /** Same-ticket lookup may select an existing run before a new run is persisted. */
  deferPersistence?: boolean;
  /** Typed ticket already on this summons. Placement uses it; code does not infer one. */
  assertedTicketNumber?: number;
};

/** Persist a deferred Countersign admission after same-ticket lookup found no retained run. */
export async function materializeCountersignInvocation(
  admitted: AdmittedCountersignInvocation,
  options: Pick<AdmitCountersignInvocationOptions, "home" | "principalAuthority" | "model"> & {
    attachmentPaths: readonly string[];
    /** Typed ticket known before the deferred run is written. */
    ticketNumber?: number;
  },
): Promise<void> {
  const placed = await placeRoleAdmission({
    role: "countersign",
    home: options.home,
    principalAuthority: options.principalAuthority,
    cwd: admitted.projectRoot,
    attachmentPaths: options.attachmentPaths,
    runId: admitted.runId,
    ...(options.ticketNumber === undefined ? {} : { assertedTicketNumber: options.ticketNumber }),
  });
  const placement = placed;
  (admitted as { runDirectory: string }).runDirectory = placement.runDirectory;
  (admitted as { principal: DurablePrincipal }).principal = placement.principal;
  const ticketFields = ticketAdmissionFields(options.ticketNumber);
  if (ticketFields.ticketNumber !== undefined) {
    (admitted as { ticketNumber?: number }).ticketNumber = ticketFields.ticketNumber;
  }
  (admitted as { attachments: readonly FrozenAttachment[] }).attachments = placement.attachments;
  writeAdmittedRequestPersistence(admitted.runDirectory, admitted, {
    sessionDirectory: placement.sessionDirectory,
    sessionFile: placement.sessionFile,
  });
  await writeRoleInvocationLedger(
    { ...admitted, sessionDirectory: placement.sessionDirectory, sessionFile: placement.sessionFile },
    admitted.role,
    options.model,
  );
}

/** Load the admitted section written at admission (Navigator work-context seam). */
export async function loadAdmittedJudgeRequest(
  runDirectory: string,
): Promise<{
  instruction: string;
  instructionEmpty: boolean;
  attachments: readonly FrozenAttachment[];
} | undefined> {
  try {
    const record = readPageSync(runDirectory, "admitted");
    if (record === undefined) return undefined;
    if (!packagedPublicInstructionSubject(record.role)) return undefined;
    if (typeof record.instruction !== "string") return undefined;
    if (typeof record.instructionEmpty !== "boolean") return undefined;
    if (!Array.isArray(record.attachments)) return undefined;
    const attachments = record.attachments
      .map((item) => normalizeAdmittedAttachment(item))
      .filter((item): item is FrozenAttachment => item !== undefined);
    return {
      instruction: record.instruction,
      instructionEmpty: record.instructionEmpty,
      attachments,
    };
  } catch {
    return undefined;
  }
}

export type AdmitFixerInvocationOptions = {
  home: string;
  principalAuthority: DurablePrincipalAuthority;
  cwd: string;
  phase: FixerPhase;
  instruction: string;
  attachmentPaths: readonly string[];
  /** Optional caller --prerequisites path as-is (#1168). */
  prerequisitesPath?: string;
  project?: string;
  createRunId?: () => string;
  /** Effective model for this invocation — written onto the state.jsonl invocation row. */
  model?: InvocationEffectiveModel;
  /** Typed ticket already on this summons. Placement uses it; code does not infer one. */
  assertedTicketNumber?: number;
};

function parsePositivePrOption(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") throw new CliUsageError("--pr requires a positive pull request number");
  try { return parseCollectorPrNumber(raw); } catch (error) { throw new CliUsageError(errorText(error), { cause: error }); }
}
function parseRepoOption(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") throw new CliUsageError("--repo requires owner/repo");
  return raw;
}
/**
 * Resolve owner/repo from the project's `origin` remote (github.com only).
 * Supports https and SSH GitHub URL shapes; never scrapes instruction prose.
 * Missing origin / non-github remote → usage. Git execution failure → true cause (exit 1).
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
    // git remote get-url exit 2 = no such remote; other failures keep true cause.
    if (isGitRemoteMissing(error)) {
      throw new CliUsageError(
        "collector requires a github.com origin remote or an explicit --repo owner/repo",
        { cause: error },
      );
    }
    throw new Error("collector git failed: cannot read origin remote URL", {
      cause: error instanceof Error ? error : new Error(String(error)),
    });
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
    const detail = errorText(error);
    throw new CliUsageError(detail, { cause: error });
  }
}

/**
 * git remote get-url: exit 2 = no such remote on common git (missing config).
 * Other statuses keep true cause — do not broaden into usage (#676 B).
 */
function isGitRemoteMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const status = (error as { status?: unknown }).status;
  return status === 2;
}

/**
 * Parse a positive Issue number for public Doctor admission.
 * Leading zeros and non-integers are structural rejects.
 */
export function parseDoctorIssueNumber(raw: string): number {
  return rejectUnlessTicketNumber(
    raw,
    `doctor --issue must be a positive integer, got ${raw}`,
  );
}

/**
 * Resolve the retained Doctor case runs root from Issue identity.
 * Default is the #78 book locator; optional --runs must stay project-confined.
 * loadDoctorCase owns retained-root grammar at IO; admission matches its case identity.
 */
export async function resolveDoctorCaseRunsPath(options: {
  home: string;
  projectRoot: string;
  bookKey: string;
  issueNumber: number;
  runs?: string;
}): Promise<string> {
  const ledgerHome = resolveActivationLedgerHome(options.home);
  // Canonical topology: <book>/<ticket>/runs (docs/dossier-topology.md).
  const defaultRuns = join(
    activationBookDirectory(ledgerHome, options.bookKey),
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
    const detail = errorText(error);
    throw new CliUsageError(
      `doctor --runs is not a readable retained runs root: ${detail}`,
      { cause: error },
    );
  }

  return real;
}

export type AdmitReviewerInvocationOptions = {
  home: string;
  principalAuthority: DurablePrincipalAuthority;
  cwd: string;
  /** Optional caller prose retained only as admitted provenance — never semantic control. */
  instruction: string;
  attachmentPaths: readonly string[];
  baseRevision: string;
  /** Explicit single-axis shape, frozen unchanged at admission and resume. */
  lens: ReviewerLens;
  /** Required durable authority references/URLs; frozen unchanged at admission. */
  authorityRefs: readonly string[];
  project?: string;
  createRunId?: () => string;
  correlationId?: string;
  /** Effective model for this invocation — written onto the state.jsonl invocation row. */
  model?: InvocationEffectiveModel;
  /** Typed ticket already on this summons. Placement uses it; code does not infer one. */
  assertedTicketNumber?: number;
};

/** Frozen Skill arg projection shared by initial and resume (never reverse-parsed). */
export function buildReviewerSkillArgProjection(
  admitted: Pick<AdmittedReviewerInvocation, "baseRevision" | "lens" | "authorityRefs">,
): string {
  return [
    `--base ${admitted.baseRevision}`,
    `--lens ${admitted.lens}`,
    ...admitted.authorityRefs.map((ref) => `--authority ${ref}`),
  ].join(" ");
}

function mergerMaterialFromUtf8(text: string): MergerInput["materials"]["targetIntent"] {
  const bytes = Buffer.from(text, "utf8");
  return Object.freeze({
    bytesBase64: bytes.toString("base64"),
    sha256: sha256Hex(bytes),
  });
}

/**
 * Read merger materials from current Git state.
 * No in-progress merge / empty conflict set still yields materials (possibly empty);
 * code does not gate attendance on merge state (#827).
 */
export async function deriveMergerEnvelopeFromActiveMerge(
  projectRoot: string,
  gitState: MergerGitState = createProductionMergerGitState(projectRoot),
): Promise<DerivedMergerEnvelope> {
  const state = await gitState.activeMerge();
  const expectedConflictPaths = Object.freeze([...state.unmergedPaths]);
  const resolutionScope = Object.freeze([...state.unmergedPaths]);
  return Object.freeze({
    targetObjectId: state.targetObjectId,
    sourceObjectId: state.sourceObjectId,
    expectedConflictPaths,
    resolutionScope,
  });
}

export type AdmitMergerInvocationOptions = {
  home: string;
  principalAuthority: DurablePrincipalAuthority;
  cwd: string;
  instruction: string;
  attachmentPaths: readonly string[];
  project?: string;
  createRunId?: () => string;
  /** Effective model for this invocation — written onto the state.jsonl invocation row. */
  model?: InvocationEffectiveModel;
  /** Typed ticket already on this summons. Placement uses it; code does not infer one. */
  assertedTicketNumber?: number;
};

/**
 * Parse a positive ticket / issue number for public analyst admission.
 * Leading zeros and non-integers are structural rejects (same face as #176).
 * `flag` names the actual argv face in diagnostics (cohort group lists reuse this).
 */
export function parseAnalystTicketNumber(
  raw: string,
  flag: string = "--ticket",
): number {
  return rejectUnlessTicketNumber(
    raw,
    `analyst ${flag} must be a positive integer, got ${raw}`,
  );
}

/**
 * One cohort issue token before cwd-book stamping.
 * - bare N → join cwd book at run time (#412 / #399 ticket口径)
 * - book:N → explicit cross-book join (last ":" + positive integer RHS)
 */
export type AnalystCohortIssueToken =
  | { readonly kind: "bare"; readonly issueNumber: number }
  | {
      readonly kind: "book-qualified";
      readonly bookKey: string;
      readonly issueNumber: number;
    };

/**
 * Parse one cohort issue token: bare positive integer or `book:N`.
 * Book keys may contain ":" (e.g. synthetic `root:<path>`) — split on the last
 * colon only when the RHS is a positive integer token.
 */
export function parseAnalystCohortIssueToken(
  raw: string,
  flag: string,
): AnalystCohortIssueToken {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new CliUsageError(
      `${flag} requires a comma-separated list of N or book:N`,
    );
  }
  const sep = trimmed.lastIndexOf(":");
  if (sep > 0) {
    const rhs = trimmed.slice(sep + 1);
    if (parseTicketNumber(rhs) !== undefined) {
      const bookKey = trimmed.slice(0, sep);
      if (bookKey.trim() === "") {
        throw new CliUsageError(
          `${flag} book:N requires a non-empty book key, got ${raw}`,
        );
      }
      return {
        kind: "book-qualified",
        bookKey,
        issueNumber: parseAnalystTicketNumber(rhs, flag),
      };
    }
  }
  return {
    kind: "bare",
    issueNumber: parseAnalystTicketNumber(trimmed, flag),
  };
}

/**
 * Sole cohort list grammar (#412): split on unescaped commas. `\,` is a literal
 * comma and `\\` a literal backslash — both round-trip, so any directory-name
 * book key (ADR 0048) is expressible. Any other `\x` stays literally `\x`, so
 * pre-existing unescaped input never changes meaning. Colons remain owned by
 * the token's lastIndexOf(':') rule.
 */
function splitAnalystCohortIssueListParts(raw: string): string[] {
  const parts: string[] = [];
  let current = "";
  let escaped = false;
  for (const ch of raw) {
    if (escaped) {
      current += ch === "," || ch === "\\" ? ch : `\\${ch}`;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === ",") {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(escaped ? `${current}\\` : current);
  return parts;
}

function parseAnalystCohortIssueTokenList(
  raw: string,
  flag: string,
): AnalystCohortIssueToken[] {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new CliUsageError(
      `${flag} requires a comma-separated list of N or book:N`,
    );
  }
  const parts = splitAnalystCohortIssueListParts(trimmed).map((part) =>
    part.trim(),
  );
  if (parts.some((part) => part === "")) {
    throw new CliUsageError(
      `${flag} requires a comma-separated list of N or book:N`,
    );
  }
  return parts.map((part) => parseAnalystCohortIssueToken(part, flag));
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
 * Parse analyst-specific argv after the `analyst` token (#336/#337/#338).
 * Spellings + mode relation contracts from PUBLIC_OPTION_TABLE.analyst / ANALYST_* (#342).
 * Mode exclusion, conditional requiredness, cardinality, and at-least-one are
 * table-driven — do not restate them as parallel handwritten branches here.
 * Unconditional required:true also goes through the shared consumer.
 */
export function parseAnalystArgv(args: readonly string[]): ParseAnalystArgvResult {
  const valueLists = new Map<string, string[]>();
  const definitions = roleOptions("analyst");
  // Shared typed consumer: dashed + positional take, repeatable, required (#342).
  const options = createTypedOptionConsumer(definitions);

  const pushValue = (id: string, value: string): void => {
    const existing = valueLists.get(id);
    if (existing === undefined) valueLists.set(id, [value]);
    else existing.push(value);
  };

  scanPublicArgv(args, options, {
    onDashed(taken) {
      if (taken.def.valueMetavar === null) {
        pushValue(taken.def.id, "");
        return;
      }
      if (taken.def.id === "ticket") {
        if (taken.value === undefined || taken.value.trim() === "") {
          throw new CliUsageError("analyst --ticket requires a positive integer");
        }
        pushValue("ticket", taken.value);
        return;
      }
      if (taken.def.id === "attach") {
        pushValue(
          "attach",
          requireProvidedOptionValue(taken.def.canonical, taken.value),
        );
        return;
      }
      if (taken.def.id === "group-a-label" || taken.def.id === "group-b-label") {
        pushValue(
          taken.def.id,
          requireOptionValue(taken.def.canonical, taken.value, "a label"),
        );
        return;
      }
      if (
        taken.def.id === "group-a-issues" || taken.def.id === "group-b-issues"
      ) {
        pushValue(
          taken.def.id,
          requireOptionValue(
            taken.def.canonical,
            taken.value,
            "a comma-separated list of N or book:N",
          ),
        );
        return;
      }
      throw new CliUsageError(`unknown analyst option: ${taken.def.canonical}`);
    },
    onBare(token) {
      // #399: deleted --project-root; disabled --model-groups public face.
      if (isRejectedPublicSpelling("analyst", token)) {
        if (token === "--project-root" || token.startsWith("--project-root=")) {
          throw new CliUsageError(
            "analyst no longer accepts --project-root (deleted); use bare call for whole book or --ticket N (cwd git common-dir selects the book)",
          );
        }
        if (token === "--model-groups" || token.startsWith("--model-groups=")) {
          throw new CliUsageError(
            "analyst --model-groups public CLI face is disabled; input face is being redesigned for multi-issue comparison (see follow-up ticket)",
          );
        }
        throw new CliUsageError(`unknown analyst option: ${token}`);
      }
      if (token.startsWith("-") && token !== "-") {
        throw new CliUsageError(`unknown analyst option: ${token}`);
      }
      // Positional selectors (e.g. sweep) via shared typed consumer — not a parallel list.
      const positional = options.takePositional(token);
      if (positional !== undefined) {
        pushValue(positional.id, "");
        return;
      }
      throw new CliUsageError(`unexpected analyst argument: ${token}`);
    },
    onDoubleDash(rest) {
      if (rest.length > 0) {
        throw new CliUsageError(`unexpected analyst argument: ${rest[0]}`);
      }
    },
  });

  const counts = new Map<string, number>();
  for (const [id, values] of valueLists) {
    counts.set(id, values.length);
  }
  options.assertRequired();
  const mode = resolveAnalystMode(new Set(counts.keys()));
  const verdict = evaluateAnalystModeOptionContract(mode, counts);
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
          issues: parseAnalystCohortIssueTokenList(
            groupAIssuesRaw,
            "--group-a-issues",
          ),
        },
        {
          groupLabel: groupBLabel,
          issues: parseAnalystCohortIssueTokenList(
            groupBIssuesRaw,
            "--group-b-issues",
          ),
        },
      ],
    };
  }

  if (mode === "sweep") {
    return {
      query: "sweep",
      attachmentPaths: valueLists.get("attach") ?? [],
    };
  }

  const ticketRaw = valueLists.get("ticket")?.[0];
  return {
    query: "issue",
    ...(ticketRaw === undefined
      ? {}
      : { ticket: parseAnalystTicketNumber(ticketRaw) }),
  };
}
