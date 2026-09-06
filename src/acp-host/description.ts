/**
 * One ACP host description. Every host-specific value the generic ACP adapter
 * needs — binary location, argv shape, resume verb, binding filename, child env
 * — is data here; the lifecycle in role-turn-host.ts stays one copy (#732).
 */
import { join } from "node:path";

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
}>;

/** Absolute agent binary for one operator home. */
export function resolveAcpBinary(description: AcpHostDescription, operatorHome: string): string {
  return join(operatorHome, ...description.binaryFromHome);
}

/** Stdio argv: optional thinking flag pair (before the subcommand), prefix,
 * optional model flag pair, suffix. */
export function acpStdioArgs(
  description: AcpHostDescription,
  model?: { readonly model?: string; readonly thinking?: string },
): string[] {
  const { prefix, suffix, modelFlag, thinkingFlag } = description.argv;
  const pair = (flag: string | undefined, value: string | undefined): string[] =>
    flag === undefined || value === undefined ? [] : [flag, value];
  return [
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
