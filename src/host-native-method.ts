/** #922 Claude's native packaged-plugin method delivery. */
import { lstat, mkdir, readlink, realpath, symlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { MethodBinding } from "./host-contracts.ts";

type HostMethodSkill = Readonly<{ name: string }>;
export const HOST_METHOD_PLUGIN_NAME = "ak-methods" as const;
export const packagedMethodsDir = (root: string) => join(root, "resources", "methods");
export const packagedMethodPluginDir = (root: string) => join(root, "dist", "method-host-plugin");
export const pluginSkillToken = (plugin: string, skill: string) => `${plugin}:${skill}`;

export function hostMethodSkills(methods: readonly MethodBinding[]): readonly HostMethodSkill[] {
  return Object.freeze(methods.flatMap((method) => {
    if (method.kind !== "skill") return [];
    const name = basename(dirname(method.path));
    return name ? [Object.freeze({ name })] : [];
  }));
}

function prefixPrompt(token: string, prompt: string): string {
  if (!token) return prompt;
  const text = prompt.trimStart();
  if (text === token || text.startsWith(`${token} `) || text.startsWith(`${token}\n`)) return prompt;
  return prompt ? `${token} ${prompt}` : token;
}

export function applyHostSlashSkillInvocation(token: string, prompt: string): string {
  return prefixPrompt(token.startsWith("/") ? token : `/${token}`, prompt);
}

export function forcedPluginSlashToken(methods: readonly MethodBinding[]): string | undefined {
  const skills = hostMethodSkills(methods);
  return skills.length === 1 ? pluginSkillToken(HOST_METHOD_PLUGIN_NAME, skills[0]!.name) : undefined;
}

/** Codex's documented project-Skill mention syntax. */
export function applyCodexSkillInvocation(methods: readonly MethodBinding[], prompt: string): string {
  const skills = hostMethodSkills(methods);
  if (skills.length !== 1) return prompt;
  return prefixPrompt(`$${skills[0]!.name}`, prompt);
}

export async function ensurePackagedMethodPlugin(packageRoot: string): Promise<string> {
  const outDir = packagedMethodPluginDir(packageRoot);
  const probe = join(outDir, "skills", "tdd", "SKILL.md");
  try {
    if ((await lstat(probe)).isFile()) return outDir;
  } catch { /* missing */ }
  throw new Error(`method-host-plugin missing at ${probe}; package build must materialize it (npm run build / prepack).`);
}

/** Install the documented Codex/Hermes project Skill catalog once and leave it. */
export async function installWorkspaceMethodSkills(cwd: string, packageRoot: string): Promise<void> {
  const target = await realpath(packagedMethodsDir(packageRoot));
  const link = join(cwd, ".agents", "skills");
  let existing: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    existing = await lstat(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing !== undefined) {
    const linkedTarget = existing.isSymbolicLink()
      ? await realpath(link).catch(() => undefined)
      : undefined;
    if (linkedTarget !== target) {
      const detail = existing.isSymbolicLink()
        ? `symlink to ${await readlink(link)}`
        : "non-symlink entry";
      throw new Error(`workspace method catalog conflict at ${link}: ${detail}`);
    }
    return;
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
