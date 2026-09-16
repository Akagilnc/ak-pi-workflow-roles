/** #922 Claude's native packaged-plugin method delivery. */
import { lstat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { MethodBinding } from "./host-contracts.ts";

type HostMethodSkill = Readonly<{ name: string; dir: string; path: string }>;
export const HOST_METHOD_PLUGIN_NAME = "ak-methods" as const;
export const packagedMethodsDir = (root: string) => join(root, "resources", "methods");
export const packagedMethodPluginDir = (root: string) => join(root, "dist", "method-host-plugin");
export const pluginSkillToken = (plugin: string, skill: string) => `${plugin}:${skill}`;

export function hostMethodSkills(methods: readonly MethodBinding[]): readonly HostMethodSkill[] {
  return Object.freeze(methods.flatMap((method) => {
    if (method.kind !== "skill") return [];
    const dir = dirname(method.path);
    const name = basename(dir);
    return name ? [Object.freeze({ name, dir, path: method.path })] : [];
  }));
}

const alreadyPrefixed = (prompt: string, token: string) => {
  const text = prompt.trimStart();
  return text === token || text.startsWith(`${token} `) || text.startsWith(`${token}\n`);
};

export function applyHostSlashSkillInvocation(token: string, prompt: string): string {
  if (!token) return prompt;
  const slash = token.startsWith("/") ? token : `/${token}`;
  if (alreadyPrefixed(prompt, slash)) return prompt;
  return prompt ? `${slash} ${prompt}` : slash;
}

export function forcedPluginSlashToken(methods: readonly MethodBinding[]): string | undefined {
  const skills = hostMethodSkills(methods);
  return skills.length === 1 ? pluginSkillToken(HOST_METHOD_PLUGIN_NAME, skills[0]!.name) : undefined;
}

export async function ensurePackagedMethodPlugin(packageRoot: string): Promise<string> {
  const outDir = packagedMethodPluginDir(packageRoot);
  const probe = join(outDir, "skills", "tdd", "SKILL.md");
  try {
    if ((await lstat(probe)).isFile()) return outDir;
  } catch { /* missing */ }
  throw new Error(`method-host-plugin missing at ${probe}; package build must materialize it (npm run build / prepack).`);
}
