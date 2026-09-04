/**
 * Single-owner host-neutral TurnRequest projection (#526 / standards-3).
 * Collapses common principal, cwd, runDirectory, model, engine, continuation,
 * and correlationId assembly across all public roles.
 */
import type {
  DurablePrincipal,
  MethodBinding,
  RoleTurnActivation,
  RoleTurnModelConfig,
  RoleTurnRequest,
} from "../host-contracts.ts";
import type { SeatModelConfig } from "./config.ts";
import type { PublicThinkingLevel } from "./registry.ts";

/** Structural model shape shared by the seam so seat/env sources fit. */
export type ResumeModelConfig = {
  readonly provider: string;
  readonly model: string;
  readonly thinking?: PublicThinkingLevel;
};

export type RoleTurnRequestProjectionOptions = {
  packageRoot: string;
  home: string;
  agentDir: string;
  model?: SeatModelConfig;
  engine?: string;
  timeoutMs?: number;
  correlationId?: string;
  continuation: RoleTurnRequest["continuation"];
};

export type AdmittedTurnInvocation = {
  principal?: DurablePrincipal;
  projectRoot?: string;
  repoRoot?: string;
  cwd?: string;
  runDirectory: string;
  /** Recorded model at admission (provenance); turn model comes from options.model. */
  model?: ResumeModelConfig;
};

export function projectRoleTurnRequest(
  admitted: AdmittedTurnInvocation,
  roleDetails: {
    activation: RoleTurnActivation;
    methods?: readonly MethodBinding[];
  },
  options: RoleTurnRequestProjectionOptions,
): RoleTurnRequest {
  const cwd = admitted.projectRoot ?? admitted.repoRoot ?? admitted.cwd;
  if (cwd === undefined) throw new Error("admitted invocation missing working directory");
  if (admitted.principal === undefined) throw new Error("admitted invocation missing principal");
  // #617 DK-3: turn model is the live seat/env model only — never the admitted
  // birth model. Resume and new legs share this projection.
  return {
    principal: admitted.principal,
    activation: roleDetails.activation,
    methods: roleDetails.methods ?? [],
    continuation: options.continuation,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.engine === undefined ? {} : { engine: options.engine }),
    cwd,
    home: options.home,
    agentDir: options.agentDir,
    runDirectory: admitted.runDirectory,
    ...(options.correlationId === undefined || options.correlationId.trim() === ""
      ? {}
      : { correlationId: options.correlationId }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
}
