/**
 * Public Invocation request admission: optional opaque instruction, frozen
 * Attachments, project default/override (ADR 0052 / #106).
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

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
  roleRunArtifactsDirectory,
  roleRunPlacement,
  type RoleRunSubject,
} from "../role-run-placement.ts";
import type {
  DurablePrincipal,
  DurablePrincipalAuthority,
} from "../host-contracts.ts";
import type { PackagedRole } from "../packaged-role-registry.ts";
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
  readBoardTicketNumber,
  requireSafePositiveTicketNumber,
} from "../run-ticket-number.ts";
import {
  rewriteRunDirectoryPathFields,
  rewriteRunDirectoryPathValue,
} from "../role-run-relocation.ts";
import {
  loadDoctorCase,
} from "../doctor-evidence.ts";
import { projectCourtTicketNumbers } from "../diarist-contracts.ts";
import type { DoctorCaseIdentity } from "../doctor-contracts.ts";
import {
  emptyCollectorManifest,
  loadCollectorManifest,
  parseCollectorPrNumber,
  parseCollectorRepository,
  type CollectorRepository,
} from "../collector-config.ts";
import { resolveCollectorTarget } from "../collector-target.ts";
import { ownerRepoFromGitHubRemoteUrl } from "./github-remote.ts";
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
import { rehomeUnboundTicketProvenance } from "../ticket-provenance.ts";
import { uuidv7 } from "../uuidv7.ts";
import {
  NOTARY_FIXED_KICKOFF,
  type NotarySourceRunLocator,
} from "../notary-contracts.ts";
import {
  NotarySourceRunError,
  resolveNotarySourceRunLocator,
} from "../notary-source-run.ts";
import {
  appendEngineSessionMaterial,
  type EngineSessionMaterial,
} from "../package-resources/engine-material.ts";
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
  /** Host-issued opaque durable principal (coordinates only via authority.decode). */
  readonly principal: DurablePrincipal;
  readonly admittedRequestPath: string;
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
   * #871 typed co-review set for this countersign run (durable run fact).
   * Main ticket remains `ticketNumber`; this set drives per-ticket court diarist refresh.
   * Whole-set replace on new typed submission — never union with history.
   */
  courtTicketNumbers?: readonly number[];
  /**
   * Load-time durable set damage diagnostic (#871 B7). Resume must settle as
   * countersign controlled failure with this text — never structural exit 2 or main-only.
   */
  courtTicketNumbersDamage?: string;
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
  /** Bound at admission when explicit/--pr or unique head/commit; otherwise role binds. */
  readonly prNumber?: number;
  readonly repository: CollectorRepository;
  readonly requestManifestPath?: string;
  readonly manifestDigest: string;
  /** Wait-window ms (#678 D4); default applied at role activate when omitted. */
  readonly waitWindowMs?: number;
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
  readonly artifactsDirectory: string;
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
    /** Identity already asserted by 起居郎; never derive this from CLI parameters. */
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
 * Unique admitted-request.json persistence projection: top-level sessionDirectory/sessionFile
 * (base wire shape). Memory Admitted keeps only the opaque principal — never dual-carry.
 */
async function writeAdmittedRequestPersistence(
  admittedRequestPath: string,
  body: Record<string, unknown>,
  coordinates: { readonly sessionDirectory: string; readonly sessionFile: string },
): Promise<void> {
  const { principal: _omitPrincipal, ...rest } = body;
  const projection = {
    ...rest,
    sessionDirectory: coordinates.sessionDirectory,
    sessionFile: coordinates.sessionFile,
  };
  await writeFile(
    admittedRequestPath,
    `${JSON.stringify(projection, null, 2)}\n`,
    "utf8",
  );
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

/**
 * Persist parent --source-run path onto admitted-request for officer resume lookup (#747).
 * Reuses the existing notary sourceRunPath key; does not invent a new field name.
 */
export async function persistAdmittedSourceRunPath(
  admitted: AdmittedRoleInvocation,
  sourceRunPath: string,
): Promise<void> {
  if (sourceRunPath.trim() === "") {
    throw new Error("persistAdmittedSourceRunPath requires a non-empty sourceRunPath");
  }
  const admittedPath = admitted.admittedRequestPath;
  const current = JSON.parse(await readFile(admittedPath, "utf8")) as Record<
    string,
    unknown
  >;
  if (typeof current.sourceRunPath === "string") {
    if (current.sourceRunPath === sourceRunPath) return;
    throw new Error(
      `persistAdmittedSourceRunPath refuses to replace ${current.sourceRunPath} with ${sourceRunPath}`,
    );
  }
  await writeFile(
    admittedPath,
    `${JSON.stringify({ ...current, sourceRunPath }, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Bind a post-admission resolved ticketNumber onto the in-memory admitted
 * object and both durable pages (invocation.json + admitted-request.json).
 * Used by known-ticket reuse when admission was unbound (#635 / #709).
 * Never clears an existing binding.
 */
export async function bindAdmittedTicketNumber(
  admitted: AdmittedRoleInvocation,
  ticketNumber: number,
): Promise<void> {
  if (admitted.ticketNumber !== undefined) {
    if (admitted.ticketNumber === ticketNumber) return;
    throw new Error(
      `bindAdmittedTicketNumber refuses to replace existing ticket #${admitted.ticketNumber} with #${ticketNumber}`,
    );
  }
  await bindTicketNumberOnRunDirectory(admitted.runDirectory, ticketNumber);
  (admitted as { ticketNumber?: number }).ticketNumber = ticketNumber;
}

/** Persist each direct caller observed while a retained run is resumed. */
export async function recordAdmittedCorrelation(
  admitted: AdmittedRoleInvocation,
  correlationId: string,
): Promise<void> {
  const current = JSON.parse(
    await readFile(admitted.admittedRequestPath, "utf8"),
  ) as Record<string, unknown>;
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
  const correlationIds = [...new Set([...prior, correlationId])];
  await writeFile(
    admitted.admittedRequestPath,
    `${JSON.stringify({ ...current, correlationId, correlationIds }, null, 2)}\n`,
    "utf8",
  );
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

/**
 * #871: persist the typed co-review set as a countersign run fact (admitted-request +
 * invocation.json). Whole-set replace — never union with a prior set. Main ticket
 * binding stays on `ticketNumber` alone. Projection reuses the sole contract helper;
 * principal membership is mandatory.
 */
export async function bindCourtTicketNumbersOnAdmitted(
  admitted: AdmittedCountersignInvocation,
  courtTicketNumbers: readonly number[],
): Promise<void> {
  if (admitted.ticketNumber === undefined) {
    throw new Error(
      "bindCourtTicketNumbersOnAdmitted requires a bound principal ticketNumber",
    );
  }
  const principal = requireSafePositiveTicketNumber(
    admitted.ticketNumber,
    "bindCourtTicketNumbersOnAdmitted principal ticketNumber",
  );
  // Strict write path: every member must already be a lawful number (no soft filter).
  for (const item of courtTicketNumbers) {
    if (!isSafePositiveTicketNumber(item)) {
      throw new Error(
        `bindCourtTicketNumbersOnAdmitted requires safe positive integers, got ${String(item)}`,
      );
    }
  }
  const projected = projectCourtTicketNumbers(courtTicketNumbers, {
    principalTicket: principal,
  });
  if (projected === null || projected.length === 0) {
    throw new Error("bindCourtTicketNumbersOnAdmitted requires a non-empty ticket set");
  }
  const frozen = Object.freeze([...projected]);
  const admittedPath = admitted.admittedRequestPath;
  const current = JSON.parse(await readFile(admittedPath, "utf8")) as Record<
    string,
    unknown
  >;
  await writeFile(
    admittedPath,
    `${JSON.stringify({ ...current, courtTicketNumbers: frozen }, null, 2)}\n`,
    "utf8",
  );
  await mergeInvocationIdentityPage(admitted.runDirectory, {
    courtTicketNumbers: frozen,
  });
  admitted.courtTicketNumbers = frozen;
}

/** Move a settled first-entry run from unbound to its asserted ticket directory. */
export async function relocateAdmittedRunToTicket(
  admitted: AdmittedRoleInvocation,
  authority: DurablePrincipalAuthority,
  heldLease?: { relocate(runDirectory: string): void },
): Promise<{ oldRunDirectory: string; newRunDirectory: string } | undefined> {
  if (admitted.ticketNumber === undefined || !admitted.runDirectory.includes(`${sep}unbound${sep}runs${sep}`)) return undefined;
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
    const parentPage = JSON.parse(await readFile(admitted.admittedRequestPath, "utf8")) as Record<string, unknown>;
    const childRunIds = parentPage.childDiaristRunIds;
    for (const childRunId of Array.isArray(childRunIds) ? childRunIds : []) {
      if (typeof childRunId !== "string") continue;
      const childDirectory = join(dirname(oldRunDirectory), `${childRunId}@diarist`);
      const childTarget = roleRunPlacement(ledgerHome, {
        bookKey: admitted.bookKey,
        subject: { ticketNumber: admitted.ticketNumber },
        runId: childRunId,
        role: "diarist",
      });
      authority.seal(childTarget);
      if (!existsSync(childDirectory) && existsSync(childTarget.runDirectory)) continue;
      await bindTicketNumberOnRunDirectory(childDirectory, admitted.ticketNumber);
      await rehomeUnboundTicketProvenance(childDirectory, admitted.ticketNumber, admitted.projectRoot, homeFromRunDirectory(oldRunDirectory));
      ensureRoleRunDirectory(ledgerHome, dirname(childTarget.runDirectory));
      await rename(childDirectory, childTarget.runDirectory);
    }
  }

  // An identity diarist can file before its caller obtains a ticket. Both its
  // own bind and the caller's later bind use this existing relocation seam.
  if (admitted.role === "diarist") {
    await rehomeUnboundTicketProvenance(oldRunDirectory, admitted.ticketNumber, admitted.projectRoot, homeFromRunDirectory(oldRunDirectory));
  }

  // Rename commits the run placement. Diary assignment above is an idempotent
  // Sitian append, not part of an atomic transaction with this directory move.
  // Persisted paths are resolved from typed run identity on read.
  await rename(oldRunDirectory, target.runDirectory);

  // rename moved the open lock inode with the directory. Transfer cleanup
  // ownership immediately after the commit.
  heldLease?.relocate(target.runDirectory);

  const admittedRecord = admitted as unknown as Record<string, unknown>;
  rewriteRunDirectoryPathFields(
    admittedRecord,
    [
      "runDirectory",
      "admittedRequestPath",
      "taskPath",
      "packetPath",
      "prerequisitesPath",
      "requestManifestPath",
      "mergerInputPath",
    ],
    oldRunDirectory,
    target.runDirectory,
  );
  for (const attachment of admitted.attachments) {
    (attachment as { frozenPath: string }).frozenPath = rewriteRunDirectoryPathValue(
      attachment.frozenPath,
      oldRunDirectory,
      target.runDirectory,
    ) as string;
  }
  (admitted as { principal: DurablePrincipal }).principal = principal;

  return { oldRunDirectory, newRunDirectory: target.runDirectory };
}

/** Persist the exact child identity; later parent binding never inspects siblings. */
export async function recordChildDiaristRun(
  parent: AdmittedRoleInvocation,
  childRunId: string,
): Promise<void> {
  const page = JSON.parse(await readFile(parent.admittedRequestPath, "utf8")) as Record<string, unknown>;
  const existing = Array.isArray(page.childDiaristRunIds)
    ? page.childDiaristRunIds.filter((runId): runId is string => typeof runId === "string")
    : [];
  const childDiaristRunIds = existing.includes(childRunId) ? existing : [...existing, childRunId];
  await writeFile(parent.admittedRequestPath, `${JSON.stringify({ ...page, childDiaristRunIds }, null, 2)}\n`, "utf8");
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
  const admittedPath = join(runDirectory, "admitted-request.json");
  const invocationPath = join(runDirectory, "invocation.json");
  const admitted = JSON.parse(await readFile(admittedPath, "utf8")) as Record<
    string,
    unknown
  >;
  const existing = admitted.ticketNumber;
  if (typeof existing === "number") {
    if (existing === ticketNumber) return;
    throw new Error(
      `bindTicketNumberOnRunDirectory refuses to replace existing ticket #${existing} with #${ticketNumber}`,
    );
  }
  // Conflict guard before any write: crash window of bindAdmittedTicketNumber
  // can leave invocation bound while admitted-request is still unbound — refuse
  // silent rebind. Read-before-merge; never check the page just overwritten.
  if (existsSync(invocationPath)) {
    const invocation = JSON.parse(
      await readFile(invocationPath, "utf8"),
    ) as Record<string, unknown>;
    if (
      typeof invocation.ticketNumber === "number" &&
      invocation.ticketNumber !== ticketNumber
    ) {
      throw new Error(
        `bindTicketNumberOnRunDirectory refuses to replace invocation ticket #${invocation.ticketNumber} with #${ticketNumber}`,
      );
    }
  }
  await writeFile(
    admittedPath,
    `${JSON.stringify({ ...admitted, ticketNumber }, null, 2)}\n`,
    "utf8",
  );
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

/** Positive ticket number for analyst query-scope face (and shared integer parse). */
export function parsePositiveTicketNumber(
  raw: string,
  flag: string,
): number {
  const trimmed = raw.trim();
  if (!ANALYST_TICKET_NUMBER_PATTERN.test(trimmed)) {
    throw new CliUsageError(`${flag} must be a positive integer, got ${raw}`);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CliUsageError(`${flag} must be a positive integer, got ${raw}`);
  }
  return value;
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
  waitWindowMs?: number;
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
      fields.attachmentPaths.push(requireOptionPath(taken.def.canonical, value));
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
      fields.prerequisitesPath = requireOptionPath(taken.def.canonical, value);
      return;
    case "pr":
      fields.prNumber = parsePositivePrOption(value);
      return;
    case "repo":
      fields.repo = parseRepoOption(value);
      return;
    case "request-manifest":
      fields.requestManifestPath = requireOptionPath(taken.def.canonical, value);
      return;
    case "wait-ms": {
      if (value === undefined || !/^[1-9]\d*$/.test(value.trim())) {
        throw new CliUsageError("--wait-ms requires a positive safe-integer millisecond value");
      }
      const parsed = Number(value.trim());
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new CliUsageError("--wait-ms requires a positive safe-integer millisecond value");
      }
      fields.waitWindowMs = parsed;
      return;
    }
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
    ...(fields.waitWindowMs === undefined ? {} : { waitWindowMs: fields.waitWindowMs }),
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
 * Shared Skill-arg token rule for caller-controlled values projected into the
 * space-joined Skill invocation line. Rejects blank, whitespace (smuggles the
 * next option), and a leading `-` (read as the next Skill option). Not a
 * general free-text gate — only the projection admission seam.
 */
function requireSkillArgToken(
  value: string | undefined,
  messages: { empty: string; whitespace: string; optionLike: string },
): string {
  if (value === undefined || value.trim() === "") {
    throw new CliUsageError(messages.empty);
  }
  if (/\s/.test(value)) {
    throw new CliUsageError(messages.whitespace);
  }
  if (value.startsWith("-")) {
    throw new CliUsageError(messages.optionLike);
  }
  return value;
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

async function readRegularFileAttachment(
  sourcePath: string,
): Promise<{ absolute: string; bytes: Buffer }> {
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
  try {
    return { absolute, bytes: await readFile(absolute) };
  } catch (error) {
    throw new CliUsageError(
      `attachment is not a readable regular file: ${sourcePath}`,
      { cause: error },
    );
  }
}

export type PreparedAttachment = {
  readonly absolute: string;
  readonly snapshotPath: string;
};

/**
 * Snapshot deferred inputs sequentially before identity side effects. The staging
 * files keep aggregate attachment bytes off heap until their final run is known.
 */
async function removePreparedAttachmentDirectory(stagingDirectory: string): Promise<void> {
  await rm(stagingDirectory, { recursive: true, force: true });
}

/** Own the complete deferred-snapshot lifetime without masking either failure. */
export async function withPreparedAttachments<T>(
  attachmentPaths: readonly string[],
  use: (prepared: readonly PreparedAttachment[]) => Promise<T>,
): Promise<T> {
  if (attachmentPaths.length === 0) return await use([]);
  const stagingDirectory = await mkdtemp(join(tmpdir(), "ak-role-attachments-"));
  const prepared: PreparedAttachment[] = [];
  let result: T;
  try {
    for (let index = 0; index < attachmentPaths.length; index += 1) {
      const { absolute, bytes } = await readRegularFileAttachment(attachmentPaths[index]!);
      const snapshotPath = join(stagingDirectory, String(index).padStart(6, "0"));
      await writeFile(snapshotPath, bytes);
      prepared.push({ absolute, snapshotPath });
    }
    result = await use(prepared);
  } catch (primary) {
    try {
      await removePreparedAttachmentDirectory(stagingDirectory);
    } catch (cleanup) {
      throw new AggregateError(
        [primary, cleanup],
        "attachment snapshot operation failed and cleanup also failed",
        { cause: primary },
      );
    }
    throw primary;
  }
  await removePreparedAttachmentDirectory(stagingDirectory);
  return result;
}

async function freezeAttachmentBytes(
  provenancePath: string,
  bytes: Buffer,
  destinationDir: string,
  index: number,
): Promise<FrozenAttachment> {
  const frozenPath = join(
    destinationDir,
    `${String(index).padStart(2, "0")}-${basename(provenancePath)}`,
  );
  await writeFile(frozenPath, bytes);
  return {
    provenancePath,
    frozenPath,
    byteLength: bytes.byteLength,
    sha256: sha256Hex(bytes),
    mediaKind: "regular-file",
  };
}

async function freezePreparedAttachment(
  prepared: PreparedAttachment,
  destinationDir: string,
  index: number,
): Promise<FrozenAttachment> {
  return freezeAttachmentBytes(
    prepared.absolute,
    await readFile(prepared.snapshotPath),
    destinationDir,
    index,
  );
}

async function freezeRegularFileAttachment(
  sourcePath: string,
  destinationDir: string,
  index: number,
): Promise<{ attachment: FrozenAttachment; body: Buffer }> {
  const { absolute, bytes } = await readRegularFileAttachment(sourcePath);
  return {
    attachment: await freezeAttachmentBytes(absolute, bytes, destinationDir, index),
    body: bytes,
  };
}

/** Freeze attachments only — ticket binding is the shared LLM seat path (#635). */
async function freezeAttachments(
  attachmentPaths: readonly string[],
  attachmentsDirectory: string,
): Promise<readonly FrozenAttachment[]> {
  const attachments: FrozenAttachment[] = [];
  for (let i = 0; i < attachmentPaths.length; i += 1) {
    const frozen = await freezeRegularFileAttachment(
      attachmentPaths[i]!,
      attachmentsDirectory,
      i,
    );
    attachments.push(frozen.attachment);
  }
  return attachments;
}

/**
 * Freeze summons attachments into an already-retained run (#637 same-ticket resume).
 * Writes under attachments/summons-<key>/ so prior freeze names stay intact.
 * Manual resume never calls this — birth attachments keep their original semantics.
 */
export async function freezeAttachmentsIntoRun(
  attachmentPaths: readonly string[],
  runDirectory: string,
  summonsKey: string = `s-${Date.now().toString(36)}`,
): Promise<readonly FrozenAttachment[]> {
  if (attachmentPaths.length === 0) return [];
  const ledgerHome = resolveActivationLedgerHome(homeFromRunDirectory(runDirectory));
  const attachmentsDirectory = join(runDirectory, "attachments", summonsKey);
  ensureRealDirectoryTree(ledgerHome, attachmentsDirectory);
  return freezeAttachments(attachmentPaths, attachmentsDirectory);
}

/** Freeze prepared bytes and metadata through one path for birth or retained runs. */
export async function freezePreparedAttachmentsIntoRun(
  prepared: readonly PreparedAttachment[],
  runDirectory: string,
  summonsKey?: string,
): Promise<readonly FrozenAttachment[]> {
  if (prepared.length === 0) return [];
  const ledgerHome = resolveActivationLedgerHome(homeFromRunDirectory(runDirectory));
  const attachmentsDirectory = summonsKey === undefined
    ? join(runDirectory, "attachments")
    : join(runDirectory, "attachments", summonsKey);
  ensureRealDirectoryTree(ledgerHome, attachmentsDirectory);
  const attachments: FrozenAttachment[] = [];
  for (let index = 0; index < prepared.length; index += 1) {
    attachments.push(await freezePreparedAttachment(prepared[index]!, attachmentsDirectory, index));
  }
  return attachments;
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
  readonly waitWindowMs?: number;
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
export function admitPublicRole<R extends PackagedRole>(
  role: R,
  parsed: PublicSeatParse,
  env: Parameters<typeof admissionCallerOptions>[0],
  override?: {
    readonly assertedTicketNumber?: number;
    readonly deferPersistence?: boolean;
  },
): Promise<Extract<AdmittedRoleInvocation, { readonly role: R }>>;
export async function admitPublicRole(
  role: PackagedRole,
  parsed: PublicSeatParse,
  env: Parameters<typeof admissionCallerOptions>[0],
  override?: {
    readonly assertedTicketNumber?: number;
    readonly deferPersistence?: boolean;
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
        role as "judge" | "inspector" | "gatekeeper" | "navigator" | "auditor" | "diarist" | "secretariat",
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
      return admitStandardMaterialInvocation("coder", {
        ...shared,
        instruction,
        attachmentPaths,
        ...project,
        placedFields: async (placed) => {
          const taskPath = join(placed.runDirectory, "task.md");
          await writeFile(taskPath, instruction, "utf8");
          return { phase, taskPath };
        },
      });
    }
    case "worker-packet": {
      if (parsed.project !== undefined) {
        requireOptionPath("--project", parsed.project);
      }
      if (instruction.trim() === "") {
        throw new CliUsageError("fixer requires a nonblank repair instruction");
      }
      const phase = parsed.phase ?? "apply";
      if (!record.phases.some((item) => item === phase)) {
        throw new CliUsageError("fixer phase must be plan or apply");
      }
      let prerequisites: readonly FixerPrerequisite[] = Object.freeze([]);
      let prerequisitesSource: string | undefined;
      if (parsed.prerequisitesPath !== undefined) {
        const absolutePrereq = isAbsolute(parsed.prerequisitesPath)
          ? parsed.prerequisitesPath
          : resolve(parsed.prerequisitesPath);
        try {
          prerequisitesSource = await readFile(absolutePrereq, "utf8");
        } catch (error) {
          throw new CliUsageError(
            `fixer prerequisites path is unreadable: ${parsed.prerequisitesPath}`,
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
      return admitStandardMaterialInvocation("fixer", {
        ...shared,
        instruction,
        attachmentPaths,
        ...project,
        placedFields: async (placed) => {
          let prerequisitesPath: string | undefined;
          if (prerequisitesSource !== undefined) {
            prerequisitesPath = join(placed.runDirectory, "prerequisites.json");
            await writeFile(
              prerequisitesPath,
              `${JSON.stringify(prerequisites, null, 2)}\n`,
              "utf8",
            );
          }
          const packetPath = join(placed.runDirectory, "fix-packet.md");
          await writeFile(packetPath, instruction, "utf8");
          return {
            phase,
            packetPath,
            prerequisites,
            ...(prerequisitesPath === undefined ? {} : { prerequisitesPath }),
          };
        },
      });
    }
    case "collect-target": {
      if (parsed.project !== undefined) {
        requireOptionPath("--project", parsed.project);
      }
      let explicitPrNumber: number | undefined;
      if (parsed.prNumber !== undefined) {
        try {
          explicitPrNumber = parseCollectorPrNumber(parsed.prNumber);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new CliUsageError(detail, { cause: error });
        }
      }
      const projectRoot = resolve(parsed.project ?? shared.cwd);
      let repository: CollectorRepository;
      if (parsed.repo !== undefined) {
        try {
          repository = parseCollectorRepository(parsed.repo);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new CliUsageError(detail, { cause: error });
        }
      } else {
        repository = resolveGitHubRemoteRepository(projectRoot);
      }
      let manifest = emptyCollectorManifest();
      let manifestCanonicalJson: string | undefined;
      if (parsed.requestManifestPath !== undefined) {
        try {
          manifest = await loadCollectorManifest(parsed.requestManifestPath);
          manifestCanonicalJson = manifest.canonicalJson;
        } catch (error) {
          throw new CliUsageError(
            error instanceof Error ? error.message : String(error),
            { cause: error },
          );
        }
      }
      const manifestDigest = manifest.digest;
      const admittedCollector = await admitStandardMaterialInvocation("collector", {
        ...shared,
        instruction,
        attachmentPaths,
        ...project,
        placedFields: async (placed) => {
          // Task materials are frozen before target resolution (#676 A).
          const target = await resolveCollectorTarget({
            projectRoot,
            repository,
            ...(explicitPrNumber === undefined ? {} : { explicitPrNumber }),
          });
          const prNumber = target.kind === "bound" ? target.prNumber : undefined;
          let requestManifestPath: string | undefined;
          if (manifestCanonicalJson !== undefined) {
            requestManifestPath = join(placed.runDirectory, "request-manifest.json");
            await writeFile(requestManifestPath, manifestCanonicalJson, "utf8");
          }
          return {
            ...(prNumber === undefined ? {} : { prNumber }),
            repository: repository.canonical,
            repositoryDisplay: repository.display,
            ...(requestManifestPath === undefined ? {} : { requestManifestPath }),
            ...(parsed.waitWindowMs === undefined ? {} : { waitWindowMs: parsed.waitWindowMs }),
            manifestDigest,
          };
        },
      });
      return { ...admittedCollector, repository };
    }
    case "case-identity": {
      if (parsed.project !== undefined) {
        requireOptionPath("--project", parsed.project);
      }
      const issueNumber = parsed.issueNumber ?? Number.NaN;
      if (
        !Number.isInteger(issueNumber) ||
        issueNumber < 1 ||
        !DOCTOR_ISSUE_NUMBER_PATTERN.test(String(issueNumber))
      ) {
        throw new CliUsageError(
          `doctor --issue must be a positive integer, got ${issueNumber}`,
        );
      }
      let frozenAttachments: readonly FrozenAttachment[] = [];
      const admittedDoctor = await admitStandardMaterialInvocation("doctor", {
        ...shared,
        instruction,
        attachmentPaths: [],
        freezeAttachments: false,
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
            const detail = error instanceof Error ? error.message : String(error);
            throw new CliUsageError(detail, { cause: error });
          }
          if (parsed.runs === undefined) {
            ensureRealDirectoryTree(placed.ledgerHome, caseRunsPath);
          }
          let caseIdentity: DoctorCaseIdentity;
          try {
            const patient = await loadDoctorCase(caseRunsPath);
            if (patient.identity.issueNumber !== issueNumber) {
              throw new CliUsageError(
                `doctor case issue ${patient.identity.issueNumber} does not match --issue ${issueNumber}`,
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
          frozenAttachments = await freezeAttachments(attachmentPaths, placed.attachmentsDirectory);
          return {
            issueNumber,
            caseRunsPath,
            caseIdentity,
            attachments: persistedAttachmentRefs(frozenAttachments),
          };
        },
      });
      return { ...admittedDoctor, attachments: frozenAttachments };
    }
    case "source-locator": {
      if (parsed.project !== undefined) {
        requireOptionPath("--project", parsed.project);
      }
      const projectRoot = resolve(parsed.project ?? shared.cwd);
      let sourceRun: NotarySourceRunLocator;
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
        freezeAttachments: false,
        admittedFields: {
          sourceRunPath: sourceRun.runDirectory,
          sourceRun,
        },
      });
    }
    case "gleaner": {
      if (parsed.project !== undefined) {
        requireOptionPath("--project", parsed.project);
      }
      const baseRevision = parsed.baseRevision ?? "";
      if (baseRevision.trim() === "") {
        throw new CliUsageError("--base requires a nonempty revision");
      }
      return admitStandardMaterialInvocation("gleaner-left", {
        ...shared,
        instruction,
        attachmentPaths: [],
        ...project,
        freezeAttachments: false,
        admittedFields: { baseRevision },
      });
    }
    case "review-basis": {
      const lens = requireReviewerLens(parsed.lens);
      if (parsed.project !== undefined) {
        requireOptionPath("--project", parsed.project);
      }
      const baseRevision = requireReviewerBaseRevision(parsed.baseRevision);
      const rawRefs = parsed.authorityRefs ?? [];
      if (rawRefs.length === 0) {
        throw new CliUsageError("reviewer requires --authority-ref <ref>");
      }
      const authorityRefs = Object.freeze(rawRefs.map((ref) => requireAuthorityRef(ref)));
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
      if (parsed.project !== undefined) {
        requireOptionPath("--project", parsed.project);
      }
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
          const mergerInput = validateMergerInput({
            attemptId: placed.runId,
            targetObjectId: derived.targetObjectId,
            sourceObjectId: derived.sourceObjectId,
            materials: {
              task: mergerMaterialFromUtf8(instruction),
              authority: mergerMaterialFromUtf8(instruction),
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
  /** Effective model for this invocation — written onto invocation.json. */
  model?: InvocationEffectiveModel;
  /** Typed ticket already on this summons (起居录 / parent board). Never parsed from prose. */
  assertedTicketNumber?: number;
};

export type AdmitInspectorInvocationOptions = AdmitJudgeInvocationOptions & {
  correlationId?: string;
  /** Typed identity handed off by 起居郎 or inherited from an already-bound run. */
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
  /** Gleaner-left admits no caller attachments. */
  readonly freezeAttachments?: boolean;
  /** Countersign reserves coordinates, then materializes after identity lookup. */
  readonly materialize?: boolean;
}): Promise<PlacedRoleAdmission> {
  if (options.project !== undefined) {
    requireOptionPath("--project", options.project);
  }
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
  const attachments = options.freezeAttachments === false
    ? []
    : await freezeAttachments(options.attachmentPaths, attachmentsDirectory);
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
): ReadonlyArray<{
  provenancePath: string;
  frozenPath: string;
  byteLength: number;
  sha256: string;
  mediaKind: FrozenAttachment["mediaKind"];
}> {
  return attachments.map((attachment) => ({
    provenancePath: attachment.provenancePath,
    frozenPath: attachment.frozenPath,
    byteLength: attachment.byteLength,
    sha256: attachment.sha256,
    mediaKind: attachment.mediaKind,
  }));
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
): Promise<string> {
  const admittedRequestPath = join(placed.runDirectory, "admitted-request.json");
  await writeAdmittedRequestPersistence(admittedRequestPath, admitted, {
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
  return admittedRequestPath;
}

/**
 * Shared admission: project check, placement, attachment freeze,
 * admitted-request and invocation ledger write.
 * Countersign passes deferPersistence so same-ticket lookup can reserve coordinates
 * before materializeCountersignInvocation writes the page.
 * Seats whose extra facts are known before placement pass them as admittedFields.
 * Seats whose extra facts depend on the placed run pass placedFields
 * (coder writes task.md; fixer writes fix-packet.md; collector writes request-manifest.json;
 * doctor resolves the case, then freezes attachments; merger writes merger-input.json).
 */
async function admitStandardMaterialInvocation<
  R extends "judge" | "inspector" | "gatekeeper" | "navigator" | "auditor" | "diarist" | "secretariat" | "countersign" | "gleaner-left" | "reviewer" | "notary" | "coder" | "fixer" | "collector" | "doctor" | "merger",
  Extra extends object = {},
>(
  role: R,
  options: AdmitInspectorInvocationOptions & {
    /** Reserve coordinates; skip freeze, placement disk, and admitted-request write. */
    readonly deferPersistence?: boolean;
    /** Skip attachment freeze. Gleaner-left admits no caller attachments. */
    readonly freezeAttachments?: boolean;
    /** Seat facts already validated by admitPublicRole. */
    readonly admittedFields?: Extra;
    /** Seat facts that exist only after placement. Written before the admitted page. */
    readonly placedFields?: (placed: PlacedRoleAdmission) => Extra | Promise<Extra>;
  },
): Promise<AdmittedRoleInvocationBase & { readonly role: R } & Extra> {
  const defer = options.deferPersistence === true;
  const skipFreeze = defer || options.freezeAttachments === false;
  const placed = await placeRoleAdmission({
    role,
    home: options.home,
    principalAuthority: options.principalAuthority,
    cwd: options.cwd,
    attachmentPaths: options.attachmentPaths,
    ...(skipFreeze ? { freezeAttachments: false } : {}),
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
  const instructionEmpty = instruction.trim() === "";
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
  const admittedRequestPath = defer
    ? join(placed.runDirectory, "admitted-request.json")
    : await persistPlacedAdmission(admitted, placed, options.model);
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
    admittedRequestPath,
    ...correlationFields,
    ...placed.ticketFields,
    ...admittedFields,
  };
}

export type AdmitAuditorInvocationOptions = AdmitInspectorInvocationOptions;

type InstructionTransportSource = {
  readonly role?: string;
  readonly instruction: string;
  readonly instructionEmpty: boolean;
  readonly attachments: readonly { readonly frozenPath: string }[];
  readonly baseRevision?: string;
  readonly lens?: ReviewerLens;
  readonly authorityRefs?: readonly string[];
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
 * caller instruction plus frozen attachment paths.
 */
export function buildInstructionTransportPrompt(
  admitted: InstructionTransportSource,
  engineMaterial?: EngineSessionMaterial,
): string {
  const kind = admittedTransportPromptKind(admitted);
  if (kind === "fixed-kickoff") {
    return appendEngineSessionMaterial([NOTARY_FIXED_KICKOFF], engineMaterial).join("\n");
  }
  if (kind === "baseline") {
    if (admitted.baseRevision === undefined) {
      throw new Error("baseline transport prompt is missing the bound revision");
    }
    const lines = [`左拾遗案已受理。比较基线：${admitted.baseRevision}`];
    if (!admitted.instructionEmpty) {
      lines.push("", admitted.instruction);
    }
    return appendEngineSessionMaterial(lines, engineMaterial).join("\n");
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
    if (!admitted.instructionEmpty && admitted.instruction.trim() !== "") {
      lines.push("", admitted.instruction);
    }
    return appendEngineSessionMaterial(lines, engineMaterial).join("\n");
  }
  const lines: string[] = [admitted.instructionEmpty ? "" : admitted.instruction];
  if (admitted.attachments.length > 0) {
    lines.push("");
    lines.push("已受理附件（冻结快照路径）：");
    for (const attachment of admitted.attachments) {
      lines.push(`- ${attachment.frozenPath}`);
    }
  }
  return appendEngineSessionMaterial(lines, engineMaterial).join("\n");
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
  /** Effective model for this invocation — written onto invocation.json. */
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
    preparedAttachments: readonly PreparedAttachment[];
    /** Typed ticket known before the deferred run is written. */
    ticketNumber?: number;
  },
): Promise<void> {
  const placed = await placeRoleAdmission({
    role: "countersign",
    home: options.home,
    principalAuthority: options.principalAuthority,
    cwd: admitted.projectRoot,
    attachmentPaths: [],
    freezeAttachments: false,
    runId: admitted.runId,
    ...(options.ticketNumber === undefined ? {} : { assertedTicketNumber: options.ticketNumber }),
  });
  const placement = placed;
  (admitted as { runDirectory: string }).runDirectory = placement.runDirectory;
  (admitted as { admittedRequestPath: string }).admittedRequestPath = join(
    placement.runDirectory,
    "admitted-request.json",
  );
  (admitted as { principal: DurablePrincipal }).principal = placement.principal;
  const ticketFields = ticketAdmissionFields(options.ticketNumber);
  if (ticketFields.ticketNumber !== undefined) {
    (admitted as { ticketNumber?: number }).ticketNumber = ticketFields.ticketNumber;
  }
  const attachments = await freezePreparedAttachmentsIntoRun(
    options.preparedAttachments,
    admitted.runDirectory,
  );
  (admitted as { attachments: readonly FrozenAttachment[] }).attachments = attachments;
  await writeAdmittedRequestPersistence(admitted.admittedRequestPath, admitted, {
    sessionDirectory: placement.sessionDirectory,
    sessionFile: placement.sessionFile,
  });
  await writeRoleInvocationLedger(
    { ...admitted, sessionDirectory: placement.sessionDirectory, sessionFile: placement.sessionFile },
    admitted.role,
    options.model,
  );
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
    if (!packagedPublicInstructionSubject(record.role)) return undefined;
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
  const directory = roleRunArtifactsDirectory(runDirectory);
  return ensureRoleRunDirectory(
    resolveActivationLedgerHome(homeFromRunDirectory(runDirectory)),
    directory,
  );
}

export type AdmitFixerInvocationOptions = {
  home: string;
  principalAuthority: DurablePrincipalAuthority;
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
  /** Typed ticket already on this summons. Placement uses it; code does not infer one. */
  assertedTicketNumber?: number;
};

function parsePositivePrOption(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") throw new CliUsageError("--pr requires a positive pull request number");
  try { return parseCollectorPrNumber(raw); } catch (error) { throw new CliUsageError(error instanceof Error ? error.message : String(error), { cause: error }); }
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
    const detail = error instanceof Error ? error.message : String(error);
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

/** Positive Issue number grammar shared with Doctor case path identity. */
const DOCTOR_ISSUE_NUMBER_PATTERN = /^[1-9]\d*$/;

/** Match retained Doctor case runs roots (ADR 0017 / loadDoctorCase). */
/** Canonical Doctor case: `<book>/<ticket>/runs`. Legacy `issues/<n>/runs` is read-only compat. */
const DOCTOR_CASE_RUNS_PATH_PATTERN =
  /\/\.ak-roles\/books\/[^/]+\/(?:issues\/)?([1-9]\d*)\/runs$/;

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
      "doctor --runs must be an .ak-roles/books/<book>/<n>/runs directory",
    );
  }
  if (Number(match[1]) !== options.issueNumber) {
    throw new CliUsageError(
      `doctor --runs issue ${match[1]} does not match --issue ${options.issueNumber}`,
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
  /** Effective model for this invocation — written onto invocation.json. */
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

function mergerMaterialFromUtf8(text: string): MergerInput["materials"]["task"] {
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
  /** Effective model for this invocation — written onto invocation.json. */
  model?: InvocationEffectiveModel;
  /** Typed ticket already on this summons. Placement uses it; code does not infer one. */
  assertedTicketNumber?: number;
};

const ANALYST_TICKET_NUMBER_PATTERN = /^[1-9]\d*$/;

/**
 * Parse a positive ticket / issue number for public analyst admission.
 * Leading zeros and non-integers are structural rejects (same face as #176).
 * `flag` names the actual argv face in diagnostics (cohort group lists reuse this).
 */
export function parseAnalystTicketNumber(
  raw: string,
  flag: string = "--ticket",
): number {
  const trimmed = raw.trim();
  if (!ANALYST_TICKET_NUMBER_PATTERN.test(trimmed)) {
    throw new CliUsageError(
      `analyst ${flag} must be a positive integer, got ${raw}`,
    );
  }
  const value = Number(trimmed);
  // Digit-only strings beyond MAX_SAFE_INTEGER round or become Infinity — reject.
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CliUsageError(
      `analyst ${flag} must be a positive integer, got ${raw}`,
    );
  }
  return value;
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
    if (ANALYST_TICKET_NUMBER_PATTERN.test(rhs)) {
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
          requireOptionPath(taken.def.canonical, taken.value),
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
