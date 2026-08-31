/**
 * Public Countersign Role run: admit ticket materials → diarist pipeline step →
 * shared post-admission coordinator → settle Terminal result
 * (#572 / ADR 0074 / ADR 0075). One-shot: 署/封驳/上呈，无 resume.
 * Diarist is a prior station on the court pipeline, not a countersign call.
 * Unbound admission may resolve a ticket via diarist pre-court LLM assertion
 * (#582 / diarist-resolves-ticket-llm-layer) before the diary station runs.
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
import {
  createGhTicketExistenceChecker,
  createHermesDiaristTicketResolver,
  resolveDiaristTicketFromInstruction,
  type DiaristTicketResolution,
} from "../diarist-ticket-resolution.ts";
import { appendIssueSourceFailureDiagnostic } from "../ticket-provenance.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitCountersignInvocation,
  bindAdmittedTicketNumber,
  buildCountersignTransportPrompt,
  type AdmittedCountersignInvocation,
  type ParseCountersignArgvResult,
} from "./invocation.ts";
import {
  runPostAdmissionOneShot,
  type PostAdmissionEnv,
} from "./post-admission.ts";
import { markRunAdmitted } from "./run-lifecycle.ts";
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
      ...(parsed.ticket === undefined ? {} : { ticket: parsed.ticket }),
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
  // Mutable shell: pre-court ticket resolution may rebind activation before executeTurn.
  const turnRequest = buildCountersignTurnRequest(admitted, turnProjection);

  return await runPostAdmissionOneShot({
    admitted,
    env,
    io,
    request: turnRequest,
    adapters: {
      trySettle: (admitted, authority) => trySettleCountersignTerminalResult(admitted, authority),
      // Accepted receipts and failure terminals both present via shared path.
      shouldPresentSettled: () => true,
      beforeDispatch: async (admitted) => {
        await resolveCountersignTicketBinding(admitted, env);
        // Re-project activation so Notary gate flag carries the post-admission binding.
        Object.assign(
          turnRequest,
          buildCountersignTurnRequest(admitted, turnProjection),
        );
        await runCountersignDiaristStation(admitted, env);
      },
    },
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}

/**
 * Pre-court ticket binding for unbound countersign admissions
 * (decision key `diarist-resolves-ticket-llm-layer`).
 * Explicit admitted ticket ( --ticket / frontmatter) is never re-resolved.
 * LLM true-unbound leaves the run unbound (no diary). Asserted N that fails
 * mechanical verification throws — caller settles controlled failure.
 */
export async function resolveCountersignTicketBinding(
  admitted: AdmittedCountersignInvocation,
  env: Pick<CountersignRunEnv, "packageRoot" | "cwd">,
): Promise<DiaristTicketResolution | undefined> {
  if (admitted.ticketNumber !== undefined) return undefined;

  const resolver = createHermesDiaristTicketResolver({
    ...(env.packageRoot === undefined ? {} : { packageRoot: env.packageRoot }),
    cwd: admitted.projectRoot,
  });
  const checkExistence = createGhTicketExistenceChecker();
  const origin = resolveDiaristGithubOrigin(admitted.projectRoot);
  const resolution = await resolveDiaristTicketFromInstruction({
    instruction: admitted.instruction,
    origin,
    resolver,
    checkExistence,
  });
  if (resolution.kind === "ticket") {
    await bindAdmittedTicketNumber(admitted, resolution.ticketNumber);
  }
  return resolution;
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

  const result = await runDiarist({
    ticketNumber: admitted.ticketNumber,
    cwd: admitted.projectRoot,
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
  appendIssueSourceFailureDiagnostic({
    ticketNumber,
    cwd: admitted.projectRoot,
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
