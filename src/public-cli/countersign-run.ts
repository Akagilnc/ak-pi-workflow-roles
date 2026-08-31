/**
 * Public Countersign Role run: admit ticket materials → diarist pipeline step →
 * shared post-admission coordinator → settle Terminal result
 * (#572 / ADR 0074 / ADR 0075). One-shot: 署/封驳/上呈，无 resume.
 * Diarist is a prior station on the court pipeline, not a countersign call.
 */
import { readFile } from "node:fs/promises";

import type { DurablePrincipalAuthority, RoleTurnRequest } from "../host-contracts.ts";
import { runDiarist, type DiaristRunResult } from "../diarist.ts";
import type { DiaristLlmCollector } from "../diarist-llm-collector.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitCountersignInvocation,
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
  /** Test seam: inject diarist collector (null = skip LLM). */
  diaristCollector?: DiaristLlmCollector | null;
  /** Test seam: observe diarist result without changing caller face. */
  onDiaristResult?: (result: DiaristRunResult) => void;
  /** Test seam: override Claude projects root for diarist source enum. */
  projectsRoot?: string;
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

  const turnRequest = buildCountersignTurnRequest(admitted, {
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
  });

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
        await runCountersignDiaristStation(admitted, env);
      },
    },
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}

/**
 * Court-pipeline prior station: refresh ticket-provenance before countersign turn.
 * Caller-invisible — collector failures persist on the volume diagnostic; source-read
 * and watermark honesty failures propagate (失败诚实).
 * Missing ticketNumber skips the station (no subject key).
 */
export async function runCountersignDiaristStation(
  admitted: AdmittedCountersignInvocation,
  env: Pick<
    CountersignRunEnv,
    "diaristCollector" | "onDiaristResult" | "cwd"
  > & { readonly projectsRoot?: string },
): Promise<DiaristRunResult | undefined> {
  if (admitted.ticketNumber === undefined) return undefined;

  let ticketBody: string | undefined;
  let ticketBodyPath: string | undefined;
  for (const attachment of admitted.attachments) {
    let text: string;
    try {
      text = await readFile(attachment.frozenPath, "utf8");
    } catch (error) {
      // Bound frozen ticket material unreadable — do not wash into "no face".
      throw new Error(
        `countersign diarist station: frozen attachment unreadable (${attachment.frozenPath})`,
        { cause: error },
      );
    }
    ticketBody =
      ticketBody === undefined ? text : `${ticketBody}\n${text}`;
    ticketBodyPath =
      ticketBodyPath === undefined
        ? attachment.frozenPath
        : `${ticketBodyPath}+${attachment.frozenPath}`;
  }

  const result = await runDiarist({
    ticketNumber: admitted.ticketNumber,
    cwd: admitted.projectRoot,
    ...(ticketBody === undefined ? {} : { ticketBody }),
    ...(ticketBodyPath === undefined ? {} : { ticketBodyPath }),
    sessionCwds: [admitted.projectRoot, env.cwd],
    ...(env.projectsRoot === undefined ? {} : { projectsRoot: env.projectsRoot }),
    ...(env.diaristCollector === undefined
      ? {}
      : { collector: env.diaristCollector }),
  });
  env.onDiaristResult?.(result);
  return result;
}
