/** #922 / #980 host-native packaged method delivery. */
import { access, lstat, mkdir, readdir, readlink, realpath, symlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { MethodBinding } from "./host-contracts.ts";

type HostMethodSkill = Readonly<{ name: string }>;
export const HOST_METHOD_PLUGIN_NAME = "ak-methods" as const;
export const packagedMethodsDir = (root: string) => join(root, "resources", "methods");
export const packagedMethodPluginDir = (root: string) => join(root, "dist", "method-host-plugin");

export function hostMethodSkills(methods: readonly MethodBinding[]): readonly HostMethodSkill[] {
  return Object.freeze(methods.flatMap((method) => {
    if (method.kind !== "skill") return [];
    const name = basename(dirname(method.path));
    return name ? [Object.freeze({ name })] : [];
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
  const skills = hostMethodSkills(methods);
  if (skills.length !== 1) return prompt;
  return prefixMethodInvocation(`/${HOST_METHOD_PLUGIN_NAME}:${skills[0]!.name}`, prompt);
}

/** Codex's documented explicit Skill invocation syntax. */
export function applyCodexSkillInvocation(methods: readonly MethodBinding[], prompt: string): string {
  return hostMethodSkills(methods).reduceRight(
    (invocation, skill) => prefixMethodInvocation(`$${skill.name}`, invocation),
    prompt,
  );
}

/** Names of method skills published under a catalog directory (each child SKILL.md). */
async function methodSkillNames(catalogDir: string): Promise<ReadonlySet<string>> {
  const names = new Set<string>();
  let entries;
  try {
    entries = await readdir(catalogDir, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    try {
      await access(join(catalogDir, entry.name, "SKILL.md"));
      names.add(entry.name);
    } catch {
      /* not a skill entry */
    }
  }
  return names;
}

/**
 * Existing project catalog is usable when it already publishes every packaged
 * method skill. Path identity is sufficient but not required (#980): a complete
 * catalog at another realpath (e.g. this repo's committed worktree link) must
 * stay put. Incomplete, broken, or non-symlink entries remain true conflicts.
 */
async function isCompatibleMethodCatalog(
  link: string,
  packagedMethodsRealpath: string,
): Promise<boolean> {
  const stat = await lstat(link);
  if (!stat.isSymbolicLink()) return false;
  const resolved = await realpath(link).catch(() => undefined);
  if (resolved === undefined) return false;
  if (resolved === packagedMethodsRealpath) return true;
  const required = await methodSkillNames(packagedMethodsRealpath);
  if (required.size === 0) return false;
  const available = await methodSkillNames(resolved);
  for (const name of required) {
    if (!available.has(name)) return false;
  }
  return true;
}

/** Install the documented project Skill catalog once and leave it in place. */
export async function installWorkspaceMethodSkills(cwd: string, packageRoot: string): Promise<void> {
  const target = await realpath(packagedMethodsDir(packageRoot));
  const link = join(cwd, ".agents", "skills");
  try {
    if (await isCompatibleMethodCatalog(link, target)) return;
    const stat = await lstat(link);
    const detail = stat.isSymbolicLink() ? `symlink to ${await readlink(link)}` : "non-symlink entry";
    throw new Error(`workspace method catalog conflict at ${link}: ${detail}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(link), { recursive: true });
  try {
    await symlink(target, link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!(await isCompatibleMethodCatalog(link, target))) {
      throw new Error(`workspace method catalog conflict at ${link}`);
    }
  }
}
