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

/**
 * Single authority for resume model precedence: an explicit CLI/env model wins;
 * otherwise the admitted (originally recorded) model is restored, including its
 * thinking level. `undefined` when neither source carries a model.
 */
export function resolveResumeModel(
  explicitModel: ResumeModelConfig | undefined,
  admittedModel: ResumeModelConfig | undefined,
): ResumeModelConfig | undefined {
  return explicitModel ?? admittedModel;
}

/** Structural model shape shared by the seam so both config sources fit. */
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
  /** Effective model restored on resume; fallback when no CLI/env model is given. */
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
  // Explicit CLI/env model wins on resume; admitted model is the fallback so a
  // model-less resume restores the originally recorded effective model instead of
  // silently dropping to the current env default.
  const effectiveModel = resolveResumeModel(options.model, admitted.model);
  return {
    principal: admitted.principal,
    activation: roleDetails.activation,
    methods: roleDetails.methods ?? [],
    continuation: options.continuation,
    ...(effectiveModel === undefined ? {} : { model: effectiveModel }),
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
