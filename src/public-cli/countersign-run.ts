/**
 * Public Countersign Role run: admit ticket materials → diarist pipeline step →
 * shared post-admission coordinator → settle Terminal result
 * (#572 / ADR 0074 / ADR 0075). #599: manual resume continues the exact session.
 * Diarist is a prior station on the court pipeline, not a countersign call.
 * Unbound admission resolves ticket via shared seat LLM bind (#635) before the diary station.
 */
import type { DurablePrincipalAuthority, RoleTurnRequest } from "../host-contracts.ts";
import {
  createDiaristIssueFaceFetcher,
  DiaristIssueSourceError,
  resolveDiaristGithubOrigin,
  runDiarist,
  type DiaristIssueFace,
  type DiaristRunResult,
} from "../diarist.ts";
import { appendIssueSourceFailureDiagnostic } from "../ticket-provenance.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitCountersignInvocation,
  buildCountersignTransportPrompt,
  type AdmittedCountersignInvocation,
  type ParseCountersignArgvResult,
} from "./invocation.ts";
import {
  applyTicketResolution,
  resolveInstructionTicket,
  tryResumeSameTicketSeatRun,
} from "./seat-ticket-binding.ts";
import { tryHomeFromAkRolesPath } from "../activation-ledger-topology.ts";
import {
  prepareSummonsResumeMaterials,
  runPostAdmissionOneShot,
  type PostAdmissionEnv,
  runPostAdmissionSeatResume,
  resumeTurnRequestProjectionOptions,
} from "./post-admission.ts";
import {
  loadResumableCountersignRun,
  markRunAdmitted,
  type PublicResumeRequest,
  type SameTicketSummonsMaterials,
} from "./run-lifecycle.ts";
import {
  presentStructuralRejection,
  trySettleCountersignTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type { TerminalResult } from "./terminal.ts";
import {
  projectRoleTurnRequest,
  type RoleTurnRequestProjectionOptions,
} from "./turn-request.ts";

export type CountersignRunEnv = PostAdmissionEnv & {
  principalAuthority: DurablePrincipalAuthority;
  createRunId?: () => string;
};

/** Project admitted invocation onto the host-neutral turn request. */
export function buildCountersignTurnRequest(
  admitted: AdmittedCountersignInvocation,
  options: RoleTurnRequestProjectionOptions,
): RoleTurnRequest {
  return projectRoleTurnRequest(
    admitted,
    {
      activation: {
        role: "countersign" as const,
        // Admitted typed binding rides the turn activation seam to the Notary gate.
        ...(admitted.ticketNumber === undefined
          ? {}
          : { ticketNumber: admitted.ticketNumber }),
      },
    },
    options,
  );
}

export async function runPublicCountersign(
  argv: readonly string[],
  env: CountersignRunEnv,
  io: CliIo,
  parseCountersignArgv: (args: readonly string[]) => ParseCountersignArgvResult,
): Promise<{
  exitCode: number;
  admitted?: AdmittedCountersignInvocation;
  terminal?: TerminalResult;
}> {
  let parsed: ParseCountersignArgvResult;
  try {
    parsed = parseCountersignArgv(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

  // #637: same ticket → resume prior countersign run with this summons' materials.
  // No bare catch→fresh: lookup/resume failures surface; only true absence mints new.
  const projectRoot = parsed.project ?? env.cwd;
  const ticketResolution = await resolveInstructionTicket(
    parsed.instruction,
    projectRoot,
    env,
  );
  if (ticketResolution.kind === "ticket") {
    const summons: SameTicketSummonsMaterials = {
      instruction: parsed.instruction,
      instructionEmpty: parsed.instruction.trim() === "",
      attachmentPaths: parsed.attachmentPaths,
    };
    const resumed = await tryResumeSameTicketSeatRun({
      home: env.home,
      projectRoot,
      role: "countersign",
      ticketNumber: ticketResolution.ticketNumber,
      summons,
      resume: (runId, materials) =>
        runPublicCountersignResume(
          { runId, ...(materials === undefined ? {} : { summons: materials }) },
          env,
          io,
        ),
    });
    if (resumed !== undefined) return resumed;
  }

  let admitted: AdmittedCountersignInvocation;
  try {
    admitted = await admitCountersignInvocation({
      home: env.home,
      principalAuthority: env.principalAuthority,
      cwd: env.cwd,
      instruction: parsed.instruction,
      attachmentPaths: parsed.attachmentPaths,
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
      ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
      ...(env.model === undefined ? {} : { model: env.model }),
      ...(env.correlationId === undefined ? {} : { correlationId: env.correlationId }),
    });
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

  await markRunAdmitted(admitted, env.principalAuthority);

  const turnProjection: RoleTurnRequestProjectionOptions = {
    packageRoot: env.packageRoot,
    home: env.home,
    agentDir: env.agentDir,
    ...(env.model === undefined ? {} : { model: env.model }),
    ...(env.engine === undefined ? {} : { engine: env.engine }),
    ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
    ...(env.correlationId === undefined || env.correlationId.trim() === ""
      ? {}
      : { correlationId: env.correlationId }),
    continuation: {
      kind: "initial",
      prompt: buildCountersignTransportPrompt(
        admitted,
        engineSessionMaterialFromOptions({
          ...(env.engine === undefined ? {} : { engine: env.engine }),
          packageRoot: env.packageRoot,
        }),
      ),
    },
  };
  // Mutable shell: ticket bind re-projects activation before executeTurn.
  const turnRequest = buildCountersignTurnRequest(admitted, turnProjection);
  const probedTicket = ticketResolution;

  return await runPostAdmissionOneShot({
    admitted,
    env,
    io,
    request: turnRequest,
    adapters: countersignAdapters({
      beforeDispatch: async (admitted) => {
        // #635: reuse the pre-admit ticket probe via shared seat-ticket-binding seam.
        await applyTicketResolution(admitted, probedTicket);
        Object.assign(
          turnRequest,
          buildCountersignTurnRequest(admitted, turnProjection),
        );
        await runCountersignDiaristStation(admitted, env);
      },
    }),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}

function countersignAdapters(options?: {
  beforeDispatch?: (
    admitted: AdmittedCountersignInvocation,
  ) => void | Promise<void>;
}) {
  return {
    trySettle: (
      admitted: AdmittedCountersignInvocation,
      authority: DurablePrincipalAuthority,
      scope?: { readonly courtAttemptId?: string },
    ) => trySettleCountersignTerminalResult(admitted, authority, scope),
    // Accepted receipts and failure terminals both present via shared path.
    shouldPresentSettled: () => true,
    ...(options?.beforeDispatch === undefined
      ? {}
      : { beforeDispatch: options.beforeDispatch }),
  };
}

/**
 * Resume a previously admitted Countersign run (#599 / DK-3 / #637).
 * Restores role/ticket/session identity. Every court re-entry runs the diarist
 * station first (ADR 0075 refresh-every-court). Same-ticket summons deliver this
 * turn's instruction + frozen attachments on the resume prompt; manual resume
 * keeps package-envelope / caller-message semantics and birth attachments.
 */
export async function runPublicCountersignResume(
  request: PublicResumeRequest,
  env: CountersignRunEnv,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted?: AdmittedCountersignInvocation;
  terminal?: TerminalResult;
}> {
  return await runPostAdmissionSeatResume({
    request,
    env,
    io,
    load: (effective) =>
      loadResumableCountersignRun(
        env.home,
        effective.runId,
        env.principalAuthority,
      ),
    buildTurnRequest: async (admitted, effective) => {
      const summonsPrepared = await prepareSummonsResumeMaterials(
        admitted.runDirectory,
        effective.summons,
      );
      return buildCountersignTurnRequest(
        admitted,
        resumeTurnRequestProjectionOptions(
          admitted,
          effective,
          env,
          summonsPrepared,
        ),
      );
    },
    adapters: countersignAdapters({
      beforeDispatch: async (admitted) => {
        await runCountersignDiaristStation(admitted, env);
      },
    }),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}

/**
 * Court-pipeline prior station: refresh ticket-provenance before countersign turn.
 * Caller-invisible — collector failures append durable volume diagnostics and the
 * station continues; issue-source / ADR source-read / watermark honesty failures
 * leave typed durable diagnostics and propagate (失败诚实).
 * Missing ticketNumber (true-unbound after pre-court resolution) skips the station
 * — no diary is minted for a true-unbound run.
 *
 * Issue body/comments come from the shared GitHub seam only. Attachments stay
 * attachments — never merged and mislabeled as issue-body-comment.
 * Bound ticket never silently degrades to “no issue face”.
 */
export async function runCountersignDiaristStation(
  admitted: AdmittedCountersignInvocation,
  env: Pick<CountersignRunEnv, "cwd" | "packageRoot">,
): Promise<DiaristRunResult | undefined> {
  if (admitted.ticketNumber === undefined) return undefined;

  const issueFace = await loadBoundIssueFace(admitted);
  const home = tryHomeFromAkRolesPath(admitted.runDirectory);

  const result = await runDiarist({
    ticketNumber: admitted.ticketNumber,
    cwd: admitted.projectRoot,
    ...(home === undefined ? {} : { home }),
    issueFace,
    sessionCwds: [admitted.projectRoot, env.cwd],
    ...(env.packageRoot === undefined ? {} : { packageRoot: env.packageRoot }),
  });
  return result;
}

/**
 * Acquire issue face for a bound ticket. Failures are typed + durable on the
 * ticket-provenance volume, then propagated — never washed into empty face.
 */
function persistIssueSourceFailure(
  admitted: AdmittedCountersignInvocation,
  ticketNumber: number,
  error: DiaristIssueSourceError,
): never {
  const home = tryHomeFromAkRolesPath(admitted.runDirectory);
  appendIssueSourceFailureDiagnostic({
    ticketNumber,
    cwd: admitted.projectRoot,
    ...(home === undefined ? {} : { home }),
    cause: error.message,
    reason: error.reason,
  });
  throw error;
}

async function loadBoundIssueFace(
  admitted: AdmittedCountersignInvocation,
): Promise<DiaristIssueFace> {
  const ticketNumber = admitted.ticketNumber;
  if (ticketNumber === undefined) {
    throw new Error("loadBoundIssueFace requires a bound ticketNumber");
  }

  const origin = resolveDiaristGithubOrigin(admitted.projectRoot);
  if (origin === undefined) {
    persistIssueSourceFailure(
      admitted,
      ticketNumber,
      new DiaristIssueSourceError(
        "origin-unresolved",
        `bound ticket #${ticketNumber} issue face requires a resolvable github.com origin remote`,
      ),
    );
  }

  const fetcher = createDiaristIssueFaceFetcher();
  let face: DiaristIssueFace | undefined;
  try {
    face = await fetcher({
      owner: origin.owner,
      repo: origin.repo,
      ticketNumber,
    });
  } catch (error) {
    const typed =
      error instanceof DiaristIssueSourceError
        ? error
        : new DiaristIssueSourceError(
            "issue-unavailable",
            `issue face fetch failed for ${origin.owner}/${origin.repo}#${ticketNumber}`,
            { cause: error },
          );
    persistIssueSourceFailure(admitted, ticketNumber, typed);
  }
  if (face === undefined) {
    persistIssueSourceFailure(
      admitted,
      ticketNumber,
      new DiaristIssueSourceError(
        "issue-unavailable",
        `issue face unavailable for ${origin.owner}/${origin.repo}#${ticketNumber}`,
      ),
    );
  }
  return face;
}
