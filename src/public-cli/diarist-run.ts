/**
 * Public Diarist (起居郎) Role run — #708 / ADR 0075 `diarist-is-role`.
 * Same admit → post-admission → settle shape as the other instruction seats.
 * Semantic collection is the role's own turn; this seat only freezes the
 * mechanical source catalog the turn selects from (`diarist-collector-is-own-turn`).
 * Who calls it and in what order is the caller's business (ADR 0010 `no-call-rule`).
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { DurablePrincipalAuthority, RoleTurnRequest } from "../host-contracts.ts";
import {
  loadDiaristIssueFace,
  prepareDiaristSourceCatalog,
  serializeDiaristSourceCatalog,
} from "../diarist.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitDiaristInvocation,
  buildInstructionTransportPrompt,
  type AdmittedDiaristInvocation,
  type ParseDiaristArgvResult,
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
  runPostAdmissionSeatResume,
  resumeTurnRequestProjectionOptions,
  type PostAdmissionAdapters,
  type PostAdmissionEnv,
} from "./post-admission.ts";
import {
  loadResumableDiaristRun,
  markRunAdmitted,
  type PublicResumeRequest,
  type SameTicketSummonsMaterials,
} from "./run-lifecycle.ts";
import {
  presentStructuralRejection,
  trySettleDiaristTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type { TerminalResult } from "./terminal.ts";
import {
  projectRoleTurnRequest,
  type RoleTurnRequestProjectionOptions,
} from "./turn-request.ts";

export type DiaristRunEnv = PostAdmissionEnv & {
  principalAuthority: DurablePrincipalAuthority;
  createRunId?: () => string;
};

/** Frozen catalog filename inside the run dossier (durable material, not argv). */
const DIARIST_SOURCE_CATALOG_FILE = "diarist-sources.json" as const;

/** Neutral path identifier only (ADR 0073) — catalog bytes stay on disk. */
function withDiaristCatalogPath(
  prompt: string,
  sourcesPath: string | undefined,
): string {
  if (sourcesPath === undefined || sourcesPath.trim() === "") return prompt;
  return `${prompt}\n\n已冻结来源目录（路径）：\n- ${sourcesPath}`;
}

/** Project admitted invocation onto the host-neutral turn request. */
export function buildDiaristTurnRequest(
  admitted: AdmittedDiaristInvocation,
  options: RoleTurnRequestProjectionOptions,
  sourcesPath?: string,
): RoleTurnRequest {
  const continuation =
    sourcesPath === undefined
      ? options.continuation
      : {
          ...options.continuation,
          prompt: withDiaristCatalogPath(options.continuation.prompt, sourcesPath),
        };
  return projectRoleTurnRequest(
    admitted,
    {
      activation: {
        role: "diarist" as const,
        ...(sourcesPath === undefined ? {} : { sourcesPath }),
      },
    },
    { ...options, continuation },
  );
}

/**
 * Mechanical source enumeration for a bound summons: establish the per-ticket
 * volume, freeze this turn's candidate catalog into the run dossier.
 * A true-unbound summons has no ticket, so no diary is minted — undefined.
 */
async function freezeDiaristSourceCatalog(
  admitted: AdmittedDiaristInvocation,
  env: Pick<DiaristRunEnv, "cwd" | "home">,
): Promise<string | undefined> {
  if (admitted.ticketNumber === undefined) return undefined;
  const issueFace = await loadDiaristIssueFace({
    ticketNumber: admitted.ticketNumber,
    projectRoot: admitted.projectRoot,
    home: env.home,
  });
  const catalog = await prepareDiaristSourceCatalog({
    ticketNumber: admitted.ticketNumber,
    cwd: admitted.projectRoot,
    home: env.home,
    issueFace,
    sessionCwds: [admitted.projectRoot, env.cwd],
  });
  const path = join(admitted.runDirectory, DIARIST_SOURCE_CATALOG_FILE);
  await writeFile(path, serializeDiaristSourceCatalog(catalog), "utf8");
  return path;
}

function diaristAdapters(options?: {
  beforeDispatch?: (
    admitted: AdmittedDiaristInvocation,
  ) => void | Promise<void>;
}): PostAdmissionAdapters<AdmittedDiaristInvocation> {
  return {
    trySettle: (admitted, authority, scope) =>
      trySettleDiaristTerminalResult(admitted, authority, scope),
    shouldPresentSettled: () => true,
    ...(options?.beforeDispatch === undefined
      ? {}
      : { beforeDispatch: options.beforeDispatch }),
  };
}

export async function runPublicDiarist(
  argv: readonly string[],
  env: DiaristRunEnv,
  io: CliIo,
  parseDiaristArgv: (args: readonly string[]) => ParseDiaristArgvResult,
): Promise<{
  exitCode: number;
  admitted?: AdmittedDiaristInvocation;
  terminal?: TerminalResult;
}> {
  let parsed: ParseDiaristArgvResult;
  try {
    parsed = parseDiaristArgv(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

  // #637: same ticket → resume this seat's prior run with this summons' materials.
  // Probe captures DiaristTicketResolutionError so admit+beforeDispatch can settle
  // controlled failure (bare pre-admit throw skips terminal settlement).
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
      role: "diarist",
      ticketNumber: probedTicketNumber,
      freshSummons: env.freshSummons,
      summons,
      resume: (runId, materials) =>
        runPublicDiaristResume(
          { runId, ...(materials === undefined ? {} : { summons: materials }) },
          env,
          io,
        ),
    });
    if (resumed !== undefined) return resumed;
  }

  let admitted: AdmittedDiaristInvocation;
  try {
    admitted = await admitDiaristInvocation({
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
      prompt: buildInstructionTransportPrompt(
        admitted,
        engineSessionMaterialFromOptions({
          ...(env.engine === undefined ? {} : { engine: env.engine }),
          packageRoot: env.packageRoot,
        }),
      ),
    },
  };
  // Mutable shell: ticket bind + catalog freeze re-project activation before executeTurn.
  const turnRequest = buildDiaristTurnRequest(admitted, turnProjection);

  return await runPostAdmissionOneShot({
    admitted,
    env,
    io,
    request: turnRequest,
    adapters: diaristAdapters({
      beforeDispatch: async (admittedSeat) => {
        await applyInstructionTicketProbe(admittedSeat, ticketProbe);
        const sourcesPath = await freezeDiaristSourceCatalog(admittedSeat, env);
        Object.assign(
          turnRequest,
          buildDiaristTurnRequest(admittedSeat, turnProjection, sourcesPath),
        );
      },
    }),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}

/**
 * Resume a previously admitted Diarist run (#708 / ADR 0079 同票传召 = resume).
 * Each re-entry re-enumerates fresh sources; the offered watermark keeps the
 * pass incremental so already-seen blocks are not re-offered.
 */
export async function runPublicDiaristResume(
  request: PublicResumeRequest,
  env: DiaristRunEnv,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted?: AdmittedDiaristInvocation;
  terminal?: TerminalResult;
}> {
  return await runPostAdmissionSeatResume({
    request,
    env,
    io,
    load: (effective) =>
      loadResumableDiaristRun(env.home, effective.runId, env.principalAuthority),
    buildTurnRequest: async (admitted, effective) => {
      const summonsPrepared = await prepareSummonsResumeMaterials(
        admitted.runDirectory,
        effective.summons,
      );
      const sourcesPath = await freezeDiaristSourceCatalog(admitted, env);
      return buildDiaristTurnRequest(
        admitted,
        resumeTurnRequestProjectionOptions(
          admitted,
          effective,
          env,
          summonsPrepared,
        ),
        sourcesPath,
      );
    },
    adapters: diaristAdapters(),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}
