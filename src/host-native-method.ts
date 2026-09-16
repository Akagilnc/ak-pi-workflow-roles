/** #922 host-native packaged method delivery. */
import { lstat, mkdir, readlink, realpath, symlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { MethodBinding } from "./host-contracts.ts";

type HostMethodSkill = Readonly<{ name: string; dir: string; path: string }>;
export const HOST_METHOD_PLUGIN_NAME = "ak-methods" as const;
export const packagedMethodsDir = (root: string) => join(root, "resources", "methods");
export const packagedMethodPluginDir = (root: string) => join(root, "dist", "method-host-plugin");

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

function prefixMethodInvocation(token: string, prompt: string): string {
  if (alreadyPrefixed(prompt, token)) return prompt;
  return prompt ? `${token} ${prompt}` : token;
}

/** Claude's documented plugin Skill invocation syntax. */
export function applyClaudeSkillInvocation(methods: readonly MethodBinding[], prompt: string): string {
  return hostMethodSkills(methods).reduceRight(
    (invocation, skill) => prefixMethodInvocation(`/${HOST_METHOD_PLUGIN_NAME}:${skill.name}`, invocation),
    prompt,
  );
}

/** Codex's documented explicit Skill invocation syntax. */
export function applyCodexSkillInvocation(methods: readonly MethodBinding[], prompt: string): string {
  return hostMethodSkills(methods).reduceRight(
    (invocation, skill) => prefixMethodInvocation(`$${skill.name}`, invocation),
    prompt,
  );
}

/** Install the documented project Skill catalog once and leave it in place. */
export async function installWorkspaceMethodSkills(cwd: string, packageRoot: string): Promise<void> {
  const target = await realpath(packagedMethodsDir(packageRoot));
  const link = join(cwd, ".agents", "skills");
  try {
    const stat = await lstat(link);
    if (!stat.isSymbolicLink() || await realpath(link) !== target) {
      const detail = stat.isSymbolicLink() ? `symlink to ${await readlink(link)}` : "non-symlink entry";
      throw new Error(`workspace method catalog conflict at ${link}: ${detail}`);
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(link), { recursive: true });
  try {
    await symlink(target, link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await realpath(link).catch(() => "")) !== target) {
      throw new Error(`workspace method catalog conflict at ${link}`);
    }
  }
}
