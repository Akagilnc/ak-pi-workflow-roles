/**
 * Single-owner host-neutral TurnRequest projection (#526 / standards-3).
 * Collapses common principal, cwd, runDirectory, model, engine, continuation,
 * and correlationId assembly across all public roles.
 */
import type {
  DurablePrincipal,
  MethodBinding,
  RoleTurnActivation,
  RoleTurnRequest,
} from "../host-contracts.ts";
import type { PackagedMethodSkillName } from "../package-resources/method-skill.ts";
import { pickEngineAxis } from "../package-resources/engine-material.ts";
import {
  packagedRoleActivationFlags,
  packagedRoleMetadata,
} from "../packaged-role-registry.ts";
import type { SeatModelConfig } from "./config.ts";
import type { AdmittedRoleInvocation } from "./invocation.ts";
import { parentRunPathFromGatePointerInstruction } from "./run-lifecycle.ts";
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
  host?: string;
  agentDir: string;
  model?: SeatModelConfig;
  engine?: string;
  /** Labor-engine model id (#883); projected onto the turn when present. */
  engineModel?: string;
  timeoutMs?: number;
  correlationId?: string;
  continuation: RoleTurnRequest["continuation"];
  /** #833 resume-with-message court attempt. */
  courtAttemptId?: string;
  /** #537 public-invocation scope (one ak-role call). */
  invocationScopeId?: string;
  /** Station child role run (#840): omit automatic navigator attendance. */
  stationChild?: boolean;
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
    ...pickEngineAxis(options),
    cwd,
    home: options.home,
    agentDir: options.agentDir,
    runDirectory: admitted.runDirectory,
    ...(options.correlationId === undefined || options.correlationId.trim() === ""
      ? {}
      : { correlationId: options.correlationId }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.courtAttemptId === undefined || options.courtAttemptId.length === 0
      ? {}
      : { courtAttemptId: options.courtAttemptId }),
    ...(options.invocationScopeId === undefined || options.invocationScopeId.length === 0
      ? {}
      : { invocationScopeId: options.invocationScopeId }),
    ...(options.stationChild === undefined ? {} : { stationChild: options.stationChild }),
  };
}

/**
 * Packaged method this admitted run settles with.
 * Coder carries one only on apply. Other seats read `settleMethod`.
 */
export function packagedSettleSkill(
  admitted: AdmittedRoleInvocation,
): PackagedMethodSkillName | undefined {
  const record = packagedRoleMetadata(admitted.role);
  if (record === undefined) return undefined;
  if ("applyMethod" in record && record.applyMethod !== undefined) {
    return "phase" in admitted && admitted.phase === "apply" ? record.applyMethod : undefined;
  }
  if ("settleMethod" in record && record.settleMethod !== undefined) return record.settleMethod;
  return undefined;
}

function readAdmittedPath(admitted: AdmittedRoleInvocation, path: string): unknown {
  let current: unknown = admitted;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Activation object for one admitted run. Field copies come from the composition-root record. */
function activationForAdmitted(admitted: AdmittedRoleInvocation): RoleTurnActivation {
  if (packagedRoleMetadata(admitted.role) === undefined) {
    throw new Error(`no turn projection for ${admitted.role}`);
  }
  const activation: Record<string, unknown> = { role: admitted.role };
  for (const spec of packagedRoleActivationFlags(admitted.role)) {
    let value = readAdmittedPath(admitted, spec.from ?? spec.field);
    if (spec.fallback === "gate-pointer") {
      const trimmed = typeof value === "string" ? value.trim() : "";
      value = trimmed !== ""
        ? trimmed
        : parentRunPathFromGatePointerInstruction(admitted.instruction);
      if (typeof value !== "string" || value === "") continue;
    }
    if (value === undefined) continue;
    if (spec.text === true) {
      if (typeof value !== "number") continue;
      value = String(value);
    }
    activation[spec.field] = value;
  }
  return activation as RoleTurnActivation;
}

/** Skill bindings declared on the composition-root record for this admitted run. */
function methodBindings(
  admitted: AdmittedRoleInvocation,
  home: string,
  host: string | undefined,
): readonly MethodBinding[] {
  const record = packagedRoleMetadata(admitted.role);
  const names: PackagedMethodSkillName[] = [];
  if (record !== undefined && "methodSkills" in record && record.methodSkills !== undefined) {
    names.push(...record.methodSkills);
  }
  const apply = packagedSettleSkill(admitted);
  if (apply !== undefined && !names.includes(apply)) names.push(apply);
  const root = host === "claude" || host === "claude-code"
    ? ".claude/skills"
    : host === "pi" || host === undefined
      ? ".pi/agent/skills"
      : ".agents/skills";
  return names.map((name) => ({
    kind: "skill" as const,
    path: `${home}/${root}/${name}/SKILL.md`,
  }));
}

/** Registry activation and method bindings for one admitted public seat. */
export function admittedSeatTurnDetails(
  admitted: AdmittedRoleInvocation,
  home: string,
  host: string | undefined,
): {
  readonly activation: RoleTurnActivation;
  readonly methods: readonly MethodBinding[];
} {
  return {
    activation: activationForAdmitted(admitted),
    methods: methodBindings(admitted, home, host),
  };
}
