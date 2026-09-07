/**
 * Public Countersign Role run: admit ticket materials → court-pipeline prior
 * station (起居郎) → shared post-admission coordinator → settle Terminal result
 * (#572 / ADR 0074 / ADR 0075 / #742 / #771). #599: manual resume continues the
 * exact session. ADR 0079: same-ticket re-summons resume the seat's previous run
 * (`ticket-seat-memory-countersign-principal`); explicit `ak-role new` mints fresh
 * (`explicit-fresh-summons`).
 *
 * Court admission auto-runs 起居郎 first on the caller's summons so the 起居郎
 * LLM asserts the court target; mechanical layer only verifies; countersign
 * reuses that typed identity for bind and same-ticket resume lookup (ADR 0075 /
 * 0081 / 0079). Code never matches instruction text against book-known numbers.
 * Who may call 起居郎 and in what order is not written into law (ADR 0075
 * `no-call-rule`); the present admission effect is what this seat currently does.
 * 起居录 path delivery is owned once by post-admission (#709 / ADR 0081).
 */
import type { DurablePrincipalAuthority, RoleTurnRequest } from "../host-contracts.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitCountersignInvocation,
  bindAdmittedTicketNumber,
  buildCountersignTransportPrompt,
  parseDiaristArgv,
  type AdmittedCountersignInvocation,
  type ParseCountersignArgvResult,
} from "./invocation.ts";
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
import { tryResumeSameTicketSeatRun } from "./seat-ticket-binding.ts";
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
 * Invoke public 起居郎 under the court-pipeline quiet face.
 * Returns the LLM's typed ticket assertion (or undefined for true-unbound).
 * Escalate / non-zero exit throw (失败诚实 — never wash into silent unbound).
 */
async function invokeCourtDiarist(input: {
  readonly instruction: string;
  readonly projectRoot: string;
  readonly failureLabel: string;
}, env: CountersignRunEnv, io: CliIo): Promise<number | undefined> {
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
    ["--project", input.projectRoot, input.instruction],
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

  const roleOutcome = result.terminal?.roleOutcome;
  if (result.exitCode !== 0) {
    if (roleOutcome?.kind === "failure") {
      throw new Error(
        `court diarist station failed for ${input.failureLabel}: ${roleOutcome.diagnostic}`,
      );
    }
    throw new Error(
      `court diarist station failed for ${input.failureLabel}: exit ${result.exitCode}`,
    );
  }
  // Discriminated union: only non-failure arms carry status (failure uses cause).
  if (roleOutcome !== undefined && roleOutcome.kind !== "failure") {
    if (roleOutcome.status === "escalate") {
      const reason =
        typeof roleOutcome.decisiveFacts.reason === "string"
          ? roleOutcome.decisiveFacts.reason
          : "diarist escalated without reason";
      throw new Error(
        `court diarist station escalated (cannot identify court target): ${reason}`,
      );
    }
  }

  const asserted = result.admitted?.ticketNumber;
  if (
    typeof asserted === "number" &&
    Number.isSafeInteger(asserted) &&
    asserted >= 1
  ) {
    return asserted;
  }
  return undefined;
}

/**
 * Court-pipeline prior station: 起居郎 LLM asserts (or refreshes) this ticket's
 * 起居录 before the countersign body turn (ADR 0075 `refresh-every-court` /
 * `diarist-resolves-ticket-llm-layer`; #742 / #771).
 * Caller-invisible — no diarist argv on the countersign command line.
 *
 * Unbound summons: pass the caller's original instruction so 起居郎 names the
 * court target; bind the typed assertion onto this admission. Already-bound
 * (resume): refresh under that identity. 起居郎 escalate (认不出) or failure
 * propagates (失败诚实 — never wash into silent unbound). True-unbound from
 * 起居郎 leaves countersign unbound (无录).
 * Path delivery onto materials is not this station's job — post-admission owns it.
 */
export async function runCountersignCourtDiaristStation(
  admitted: AdmittedCountersignInvocation,
  env: CountersignRunEnv,
  io: CliIo,
): Promise<void> {
  if (env.runCourtDiaristStation !== undefined) {
    await env.runCourtDiaristStation(admitted);
    return;
  }

  // Bound resume: refresh under known identity. Unbound: original summons so
  // the 起居郎 LLM judges the court target (code does not).
  const diaristInstruction =
    admitted.ticketNumber === undefined
      ? admitted.instruction
      : `整理 #${admitted.ticketNumber} 的本案依据。`;
  const failureLabel =
    admitted.ticketNumber === undefined
      ? "unbound summons"
      : `ticket #${admitted.ticketNumber}`;

  const asserted = await invokeCourtDiarist(
    {
      instruction: diaristInstruction,
      projectRoot: admitted.projectRoot,
      failureLabel,
    },
    env,
    io,
  );

  // Reuse 起居郎's typed assertion — the only recognition path (0081).
  if (admitted.ticketNumber === undefined && asserted !== undefined) {
    await bindAdmittedTicketNumber(admitted, asserted);
  }
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

  // #637 / #771 / ADR 0079: ticket identity is the 起居郎 LLM typed assertion
  // (never mechanical matching of summons text). Production resolves that typed
  // key before admit so same-ticket re-summons can resume the prior run; the
  // test seam `runCourtDiaristStation` defers identity to beforeDispatch and
  // therefore skips auto-resume under the seam alone.
  const projectRoot = parsed.project ?? env.cwd;
  let typedTicket: number | undefined;
  let identityDiaristRan = false;

  if (env.runCourtDiaristStation === undefined) {
    typedTicket = await invokeCourtDiarist(
      {
        instruction: parsed.instruction,
        projectRoot,
        failureLabel: "unbound summons",
      },
      env,
      io,
    );
    identityDiaristRan = true;

    if (typedTicket !== undefined) {
      const summons: SameTicketSummonsMaterials = {
        instruction: parsed.instruction,
        instructionEmpty: parsed.instruction.trim() === "",
        attachmentPaths: parsed.attachmentPaths,
      };
      const resumed = await tryResumeSameTicketSeatRun({
        home: env.home,
        projectRoot,
        role: "countersign",
        ticketNumber: typedTicket,
        freshSummons: env.freshSummons,
        summons,
        resume: (runId, materials) =>
          runPublicCountersignResume(
            {
              runId,
              ...(materials === undefined ? {} : { summons: materials }),
            },
            // Identity 起居郎 already refreshed 起居录 for this summons entry
            // (refresh-every-court served once). Manual `ak-role resume` keeps
            // the full env and still runs the station.
            { ...env, runCourtDiaristStation: async () => undefined },
            io,
          ),
      });
      if (resumed !== undefined) return resumed;
    }
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

  return await runPostAdmissionOneShot({
    admitted,
    env,
    io,
    request: turnRequest,
    adapters: countersignAdapters({
      beforeDispatch: async (admittedSeat) => {
        // Dossier pointer delivery rides post-admission after this hook (#709).
        if (!identityDiaristRan) {
          // Test seam (or any deferred identity): station owns assert + bind.
          await runCountersignCourtDiaristStation(admittedSeat, env, io);
        } else if (typedTicket !== undefined) {
          // Production identity already ran; bind the typed key onto this mint.
          await bindAdmittedTicketNumber(admittedSeat, typedTicket);
        }
        Object.assign(
          turnRequest,
          buildCountersignTurnRequest(admittedSeat, turnProjection),
        );
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
 * 起居录 path delivery remains post-admission's single mount (#709).
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
        await runCountersignCourtDiaristStation(admitted, env, io);
      },
    }),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}
