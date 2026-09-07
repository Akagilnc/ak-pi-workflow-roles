/**
 * Public Countersign Role run: admit ticket materials → court-pipeline prior
 * station (起居郎) → shared post-admission coordinator → settle Terminal result
 * (#572 / ADR 0074 / ADR 0075 / #742). #599: manual resume continues the exact
 * session. Unbound admission resolves its ticket via the shared seat LLM bind
 * (#635) before the diary station.
 *
 * Court admission auto-runs 起居郎 first, then the countersign body — caller
 * adds no diarist argv (L66672). This is the admission pipeline's prior station,
 * not the countersign role calling 起居郎 (L66958 / L66966). Who may call 起居郎
 * and in what order is not written into law (ADR 0075 `no-call-rule`); the
 * present admission effect is what this seat currently does (L108315 目前是这样用的).
 */
import type { DurablePrincipalAuthority, RoleTurnRequest } from "../host-contracts.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import { deliverCaseDossierPointerToTurn } from "./case-dossier-delivery.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitCountersignInvocation,
  buildCountersignTransportPrompt,
  parseDiaristArgv,
  type AdmittedCountersignInvocation,
  type ParseCountersignArgvResult,
} from "./invocation.ts";
import {
  applyInstructionTicketProbe,
  probeInstructionTicket,
  ticketNumberFromProbe,
  tryResumeSameTicketSeatRun,
} from "./seat-ticket-binding.ts";
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
  /**
   * Test seam: replace the court-pipeline 起居郎 station.
   * Production leaves this unset and runs the public diarist seat.
   */
  runCourtDiaristStation?: (
    admitted: AdmittedCountersignInvocation,
  ) => Promise<void>;
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

/**
 * Court-pipeline prior station: refresh this ticket's 起居录 before the
 * countersign body turn (ADR 0075 `refresh-every-court`; #742 restore).
 * Caller-invisible — no diarist argv on the countersign command line.
 * Missing ticketNumber (true-unbound) skips the station — no diary is minted
 * for a true-unbound run.
 *
 * Invokes the public 起居郎 seat so the book carries an `@diarist` run ahead of
 * the countersign body. Station failure propagates (失败诚实 — no wash).
 */
export async function runCountersignCourtDiaristStation(
  admitted: AdmittedCountersignInvocation,
  env: CountersignRunEnv,
  io: CliIo,
): Promise<void> {
  if (admitted.ticketNumber === undefined) return;
  if (env.runCourtDiaristStation !== undefined) {
    await env.runCourtDiaristStation(admitted);
    return;
  }

  // Quiet face: the countersign caller must not see diarist CLI chatter.
  const quietIo: CliIo = {
    stdout() {},
    stderr(text: string) {
      // Surface nested failures onto the parent stderr only; no success noise.
      if (text.trim() !== "") io.stderr(text);
    },
  };

  const { runPublicDiarist } = await import("./diarist-run.ts");
  const result = await runPublicDiarist(
    [
      "--project",
      admitted.projectRoot,
      `整理 #${admitted.ticketNumber} 的本案依据。`,
    ],
    {
      home: env.home,
      agentDir: env.agentDir,
      packageRoot: env.packageRoot,
      cwd: env.cwd,
      principalAuthority: env.principalAuthority,
      roleTurnHost: env.roleTurnHost,
      sessionAppender: env.sessionAppender,
      ...(env.model === undefined ? {} : { model: env.model }),
      ...(env.engine === undefined ? {} : { engine: env.engine }),
      ...(env.host === undefined ? {} : { host: env.host }),
      ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
      ...(env.credentials === undefined ? {} : { credentials: env.credentials }),
      ...(env.correlationId === undefined ? {} : { correlationId: env.correlationId }),
      ...(env.signal === undefined ? {} : { signal: env.signal }),
    },
    quietIo,
    parseDiaristArgv,
  );

  if (result.exitCode !== 0) {
    const detail =
      result.terminal?.roleOutcome.kind === "failure"
        ? ` (roleOutcome=failure)`
        : "";
    throw new Error(
      `court diarist station failed for ticket #${admitted.ticketNumber}: exit ${result.exitCode}${detail}`,
    );
  }
}

/** Diarist station → 起居录 path onto this turn's materials. */
async function prepareCountersignCourtTurn(
  admitted: AdmittedCountersignInvocation,
  env: CountersignRunEnv,
  io: CliIo,
  turnRequest: RoleTurnRequest,
): Promise<void> {
  await runCountersignCourtDiaristStation(admitted, env, io);
  await deliverCaseDossierPointerToTurn({
    ticketNumber: admitted.ticketNumber,
    projectRoot: admitted.projectRoot,
    home: env.home,
    turnRequest,
  });
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
  // Probe captures DiaristTicketResolutionError so admit+beforeDispatch can settle
  // controlled failure (bare pre-admit throw skips terminal settlement).
  // No bare catch→fresh: lookup/resume failures surface; only true absence mints new.
  const projectRoot = parsed.project ?? env.cwd;
  const ticketProbe = await probeInstructionTicket(
    parsed.instruction,
    projectRoot,
    env,
  );
  const probedTicketNumber = ticketNumberFromProbe(ticketProbe);
  if (probedTicketNumber !== undefined) {
    const summons: SameTicketSummonsMaterials = {
      instruction: parsed.instruction,
      instructionEmpty: parsed.instruction.trim() === "",
      attachmentPaths: parsed.attachmentPaths,
    };
    const resumed = await tryResumeSameTicketSeatRun({
      home: env.home,
      projectRoot,
      role: "countersign",
      ticketNumber: probedTicketNumber,
      freshSummons: env.freshSummons,
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
  // Mutable shell: ticket bind + dossier pointer re-project before executeTurn.
  const turnRequest = buildCountersignTurnRequest(admitted, turnProjection);

  return await runPostAdmissionOneShot({
    admitted,
    env,
    io,
    request: turnRequest,
    adapters: countersignAdapters({
      beforeDispatch: async (admittedSeat) => {
        // #635/#637: apply pre-admit probe inside controlled-failure boundary.
        await applyInstructionTicketProbe(admittedSeat, ticketProbe);
        Object.assign(
          turnRequest,
          buildCountersignTurnRequest(admittedSeat, turnProjection),
        );
        // Court station after bind so the diarist round and pointer see the ticket.
        await prepareCountersignCourtTurn(admittedSeat, env, io, turnRequest);
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
 * station first (ADR 0075 `refresh-every-court`). Same-ticket summons deliver this
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
  // Mutable shell captured so beforeDispatch can append the dossier pointer.
  let turnRequest: RoleTurnRequest | undefined;
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
      turnRequest = buildCountersignTurnRequest(
        admitted,
        resumeTurnRequestProjectionOptions(
          admitted,
          effective,
          env,
          summonsPrepared,
        ),
      );
      return turnRequest;
    },
    adapters: countersignAdapters({
      beforeDispatch: async (admitted) => {
        if (turnRequest === undefined) {
          throw new Error("countersign resume beforeDispatch missing turnRequest shell");
        }
        await prepareCountersignCourtTurn(admitted, env, io, turnRequest);
      },
    }),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}
