/**
 * One ACP host description. Every host-specific value the generic ACP adapter
 * needs — binary location, argv shape, resume verb, binding filename,
 * optional seat-profile soul — is data here; the lifecycle in role-turn-host.ts
 * stays one copy (#732).
 */
import type { HostIdentityDescription } from "../host-descriptions.ts";
import type { SeatProfileSoul } from "./seat-profile-soul.ts";

export type AcpHostDescription = HostIdentityDescription & Readonly<{
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
   * - "argv": passed as the CLI `--model` flag;
   * - "set_model": sent as an ACP `session/set_model` RPC after session new/load
   *   and before prompt. Catalog modelId shape is `setModelId` (host-native).
   */
  modelPassing: "argv" | "set_model";
  /**
   * Host-native `session/set_model` modelId form when `modelPassing` is
   * `"set_model"`. hermes catalogs are `provider:model`; grok catalogs are bare
   * model ids. Ignored for `"argv"` hosts.
   */
  setModelId?: "bare" | "provider:model";
  /**
   * When set, the production factory ensures a seat profile whose SOUL.md is a
   * symlink to the packaged role soul, and prefixes argv with `flag <name>`.
   * Used by hosts that have no per-session systemPrompt channel (hermes).
   */
  seatProfileSoul?: SeatProfileSoul;
}>;

/** Stdio argv: optional profile flag, thinking flag, prefix, model, suffix. */
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
 * "argv" hosts use the bare model on the CLI flag. "set_model" hosts use the
 * host-native catalog form in `setModelId` (hermes `provider:model` after seat
 * provider / host-alias projection; grok bare model — never a package map).
 */
export function acpModelId(
  description: {
    readonly modelPassing: AcpHostDescription["modelPassing"];
    readonly setModelId?: AcpHostDescription["setModelId"] | undefined;
  },
  model?: { readonly model?: string; readonly provider?: string },
): string | undefined {
  if (model?.model === undefined) return undefined;
  if (description.modelPassing !== "set_model") return model.model;
  const form = description.setModelId ?? "provider:model";
  return form === "bare" ? model.model : `${model.provider}:${model.model}`;
}
