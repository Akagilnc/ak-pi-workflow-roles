/**
 * #922 host-native forced-method delivery (method-skill-delivery=host-native-loader).
 * Package never pastes method bodies into systemPrompt. Host adapters only point
 * official loaders at packaged method material and invoke via host-native forms.
 *
 * Codex has no CLI/`-c` skill-root key (config schema: enable/disable only). Empty
 * home discovery without rewriting HOME or writing operator/project skill dirs is
 * an official surface gap — report upward; do not invent HOME overlays.
 * Hermes `acp` drops top-level `--skills` (cmd_acp → _ACP_FLAGS only) — gap.
 */
import { basename, dirname, join } from "node:path";

import type { MethodBinding } from "./host-contracts.ts";

export type HostMethodSkill = Readonly<{ name: string; dir: string; path: string }>;
export const HOST_METHOD_PLUGIN_NAME = "ak-methods" as const;

/** Packaged Claude/Grok plugin root (`resources/method-host-plugin`). */
export function packagedMethodPluginDir(packageRoot: string): string {
  return join(packageRoot, "resources", "method-host-plugin");
}

export function hostMethodSkills(methods: readonly MethodBinding[]): readonly HostMethodSkill[] {
  return Object.freeze(methods.flatMap((method) => {
    if (method.kind !== "skill") return [];
    const dir = dirname(method.path);
    const name = basename(dir);
    return name ? [Object.freeze({ name, dir, path: method.path })] : [];
  }));
}

export function pluginSkillToken(pluginName: string, skillName: string): string {
  return `${pluginName}:${skillName}`;
}

export function applyHostSlashSkillInvocation(token: string, prompt: string): string {
  if (!token) return prompt;
  const slash = token.startsWith("/") ? token : `/${token}`;
  const t = prompt.trimStart();
  if (t === slash || t.startsWith(`${slash} `) || t.startsWith(`${slash}\n`)) return prompt;
  return prompt ? `${slash} ${prompt}` : slash;
}

/**
 * Codex explicit skill mention: linked `[$name](/abs/SKILL.md)` selects by path
 * when the skill is already in the host catalog (official mentions).
 */
export function applyCodexSkillInvocation(skills: readonly HostMethodSkill[], prompt: string): string {
  if (skills.length !== 1) return prompt;
  const s = skills[0]!;
  const linked = `[$${s.name}](${s.path})`;
  const bare = `$${s.name}`;
  const t = prompt.trimStart();
  for (const token of [linked, bare]) {
    if (t === token || t.startsWith(`${token} `) || t.startsWith(`${token}\n`)) return prompt;
  }
  return prompt ? `${linked} ${prompt}` : linked;
}

/** Single forced skill slash token for the packaged plugin, if any. */
export function forcedPluginSlashToken(methods: readonly MethodBinding[]): string | undefined {
  const skills = hostMethodSkills(methods);
  return skills.length === 1
    ? pluginSkillToken(HOST_METHOD_PLUGIN_NAME, skills[0]!.name)
    : undefined;
}
