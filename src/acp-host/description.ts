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
    thinkingFlag?: string;
  }>;
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

/** Stdio argv: prefix, optional model/thinking flag pairs, suffix. */
export function acpStdioArgs(
  description: AcpHostDescription,
  model?: { readonly model?: string; readonly thinking?: string },
): string[] {
  const { prefix, suffix, modelFlag, thinkingFlag } = description.argv;
  const pair = (flag: string | undefined, value: string | undefined): string[] =>
    flag === undefined || value === undefined ? [] : [flag, value];
  return [
    ...prefix,
    ...pair(modelFlag, model?.model),
    ...pair(thinkingFlag, model?.thinking),
    ...suffix,
  ];
}
