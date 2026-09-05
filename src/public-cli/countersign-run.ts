/**
 * Public Countersign Role run: admit ticket materials → seat ticket bind →
 * ticket+seat memory principal (#637) → diarist pipeline step → shared
 * post-admission coordinator → settle Terminal result
 * (#572 / ADR 0074 / ADR 0075 / ADR 0079). #599: manual resume continues the exact session.
 * Diarist is a prior station on the court pipeline, not a countersign call.
 * Unbound admission resolves ticket via shared seat LLM bind (#635) before memory rebind.
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
import { CliUsageError } from "./cli-errors.ts";
import {
  admitCountersignInvocation,
  buildCountersignTransportPrompt,
  type AdmittedCountersignInvocation,
  type ParseCountersignArgvResult,
} from "./invocation.ts";
import { resolveSeatTicketBinding } from "./seat-ticket-binding.ts";
import { tryHomeFromAkRolesPath } from "../activation-ledger-topology.ts";
import {
  type PostAdmissionEnv,
  runPostAdmissionSeatResume,
  runPostAdmissionTicketSeatMemoryOneShot,
  resumeTurnRequestProjectionOptions,
} from "./post-admission.ts";
import {
  loadResumableCountersignRun,
  type PublicResumeRequest,
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
  let admitted: AdmittedCountersignInvocation;
  try {
    const parsed = parseCountersignArgv(argv);
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

  // #635 seat self-ticket then #637 ticket+seat memory principal before post-admission
  // so last-host / host-transition see the bound ticket (ticketSeatMemoryBound gate).
  // Binding/rebind failures settle as controlled failure (same product face as the old
  // beforeDispatch path) — shared seam marks admitted first so the run is not left
  // without a terminal. Diarist stays a court-pipeline prior station after running.
  return await runPostAdmissionTicketSeatMemoryOneShot({
    admitted,
    env,
    io,
    seat: "countersign",
    beforeMemoryRebind: async () => {
      await resolveSeatTicketBinding(admitted, env);
    },
    settleMemoryPrepFailure: true,
    buildPrompt: (bound, engineMaterial) =>
      buildCountersignTransportPrompt(bound, engineMaterial),
    buildTurnRequest: buildCountersignTurnRequest,
    adapters: countersignAdapters({
      beforeDispatch: async (bound) => {
        await runCountersignDiaristStation(bound, env);
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
    trySettle: (admitted: AdmittedCountersignInvocation, authority: DurablePrincipalAuthority) =>
      trySettleCountersignTerminalResult(admitted, authority),
    // Accepted receipts and failure terminals both present via shared path.
    shouldPresentSettled: () => true,
    ...(options?.beforeDispatch === undefined
      ? {}
      : { beforeDispatch: options.beforeDispatch }),
  };
}

/**
 * Resume a previously admitted Countersign run (#599 / DK-3).
 * Restores role/ticket/attachments/session identity; diarist does not re-run.
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
    load: () =>
      loadResumableCountersignRun(
      env.home,
      request.runId,
      env.principalAuthority,
    ),
    buildTurnRequest: (admitted) =>
      buildCountersignTurnRequest(
      admitted,
      resumeTurnRequestProjectionOptions(admitted, request, env),
    ),
    adapters: countersignAdapters(),
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
