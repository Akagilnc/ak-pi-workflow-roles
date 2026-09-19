/** #922 / #980 host-native packaged method delivery. */
import { access, lstat, mkdir, readdir, readFile, readlink, realpath, symlink } from "node:fs/promises";
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

const isEnoent = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

/** Packaged method skill directory names (child has SKILL.md). I/O errors propagate. */
async function packagedMethodSkillNames(packagedMethodsRealpath: string): Promise<readonly string[]> {
  const entries = await readdir(packagedMethodsRealpath, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    try {
      await access(join(packagedMethodsRealpath, entry.name, "SKILL.md"));
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
    names.push(entry.name);
  }
  return names;
}

/**
 * Byte map of every regular file under a skill directory (relative path → bytes).
 * Undefined when SKILL.md is missing. Other I/O errors propagate.
 * Integrity only — no free-text parsing of Skill prose.
 */
async function skillFileBytes(skillDir: string): Promise<ReadonlyMap<string, Buffer> | undefined> {
  try {
    await access(join(skillDir, "SKILL.md"));
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
  const files = new Map<string, Buffer>();
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
        continue;
      }
      if (entry.isFile()) {
        files.set(rel, await readFile(full));
      }
    }
  }
  await walk(skillDir, "");
  return files;
}

/** True when catalog skill publishes every packaged skill file with identical bytes. */
function publishesPackagedSkill(
  required: ReadonlyMap<string, Buffer>,
  available: ReadonlyMap<string, Buffer>,
): boolean {
  for (const [rel, bytes] of required) {
    const other = available.get(rel);
    if (other === undefined || !bytes.equals(other)) return false;
  }
  return true;
}

/**
 * Existing project catalog is usable when it already publishes every packaged
 * method skill with identical file bytes. Path identity is sufficient but not
 * required (#980): a worktree catalog at another realpath that still carries
 * the packaged method bytes must stay put. Name-only / foreign / stale content
 * remains a true conflict. Incomplete, broken, or non-symlink entries too.
 */
async function isCompatibleMethodCatalog(
  link: string,
  packagedMethodsRealpath: string,
): Promise<boolean> {
  const stat = await lstat(link);
  if (!stat.isSymbolicLink()) return false;
  let resolved: string;
  try {
    resolved = await realpath(link);
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
  if (resolved === packagedMethodsRealpath) return true;
  const names = await packagedMethodSkillNames(packagedMethodsRealpath);
  if (names.length === 0) return false;
  for (const name of names) {
    const required = await skillFileBytes(join(packagedMethodsRealpath, name));
    if (required === undefined) return false;
    let available: ReadonlyMap<string, Buffer> | undefined;
    try {
      available = await skillFileBytes(join(resolved, name));
    } catch (error) {
      if (isEnoent(error)) return false;
      throw error;
    }
    if (available === undefined || !publishesPackagedSkill(required, available)) return false;
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
    if (!isEnoent(error)) throw error;
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
