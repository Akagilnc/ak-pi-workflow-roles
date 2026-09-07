/**
 * One ACP host description. Every host-specific value the generic ACP adapter
 * needs — binary location, argv shape, resume verb, binding filename, child env,
 * optional seat-profile soul — is data here; the lifecycle in role-turn-host.ts
 * stays one copy (#732).
 */
import { join } from "node:path";

import type { SeatProfileSoul } from "./seat-profile-soul.ts";

export type AcpHostDescription = Readonly<{
  /** Binary path segments relative to the operator home. */
  binaryFromHome: readonly string[];
  argv: Readonly<{
    prefix: readonly string[];
    suffix: readonly string[];
    modelFlag?: string;
    /** CLI flag whose value is the seat thinking level; placed before `prefix`
     * so it lands ahead of the subcommand (hermes global `--reasoning`). */
    thinkingFlag?: string;
  }>;
  /**
   * How the seat model reaches the agent:
   * - "argv": passed as the CLI `--model` flag (grok);
   * - "set_model": sent as an ACP `session/set_model` RPC with modelId
   *   `provider:model` (hermes).
   */
  modelPassing: "argv" | "set_model";
  /** Which verb a bound resume uses; "session/new" hosts always mint + bind. */
  boundResume: "session/load" | "session/new";
  /** Durable ACP binding filename written beside the session principal. */
  sessionBindingFile: string;
  childEnv: Readonly<Record<string, string>>;
  /**
   * When set, the production factory ensures a seat profile whose SOUL.md is a
   * symlink to the packaged role soul, and prefixes argv with `flag <name>`.
   * Used by hosts that have no per-session systemPrompt channel (hermes).
   */
  seatProfileSoul?: SeatProfileSoul;
}>;

/** Absolute agent binary for one operator home. */
export function resolveAcpBinary(description: AcpHostDescription, operatorHome: string): string {
  return join(operatorHome, ...description.binaryFromHome);
}

/** Stdio argv: optional profile flag, thinking flag (before the subcommand),
 * prefix, optional model flag pair, suffix. */
export function acpStdioArgs(
  description: AcpHostDescription,
  model?: { readonly model?: string; readonly thinking?: string },
  seat?: { readonly profileName?: string },
): string[] {
  const { prefix, suffix, modelFlag, thinkingFlag } = description.argv;
  const pair = (flag: string | undefined, value: string | undefined): string[] =>
    flag === undefined || value === undefined ? [] : [flag, value];
  return [
    ...pair(description.seatProfileSoul?.flag, seat?.profileName),
    ...pair(thinkingFlag, model?.thinking),
    ...prefix,
    ...pair(modelFlag, model?.model),
    ...suffix,
  ];
}

/**
 * The modelId the host addresses the seat model by.
 * "argv" hosts address by bare model name; "set_model" hosts address by the
 * `provider:model` modelId the ACP catalog exposes.
 */
export function acpModelId(
  modelPassing: AcpHostDescription["modelPassing"],
  model?: { readonly model?: string; readonly provider?: string },
): string | undefined {
  if (model?.model === undefined) return undefined;
  return modelPassing === "set_model" ? `${model.provider}:${model.model}` : model.model;
}
