/**
 * #922 host-native forced-method delivery (method-skill-delivery=host-native-loader).
 * Adapters point each host loader at packaged method dirs; package never pastes bodies.
 */
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { MethodBinding } from "./host-contracts.ts";

export type HostMethodSkill = Readonly<{ name: string; dir: string; path: string }>;
export const HOST_METHOD_PLUGIN_NAME = "ak-methods" as const;

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

/** Codex linked mention `[$name](/abs/SKILL.md)` — path selects in host catalog. */
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

async function linkSkills(root: string, skills: readonly HostMethodSkill[]): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const skill of skills) {
    try { await symlink(skill.dir, join(root, skill.name)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  }
}

/** Claude/Grok `--plugin-dir` root with skills/<name> → method dir. */
export async function stageHostMethodPlugin(runDirectory: string, methods: readonly MethodBinding[]) {
  const skills = hostMethodSkills(methods);
  if (!skills.length) return undefined;
  const pluginDir = join(runDirectory, "host-method-plugin");
  await mkdir(join(pluginDir, ".claude-plugin"), { recursive: true });
  await writeFile(join(pluginDir, ".claude-plugin", "plugin.json"), `${JSON.stringify({
    name: HOST_METHOD_PLUGIN_NAME, version: "0.0.0", description: "ak-roles packaged role method skills",
  })}\n`);
  await linkSkills(join(pluginDir, "skills"), skills);
  return Object.freeze({
    pluginDir,
    skills,
    ...(skills.length === 1
      ? { slashToken: pluginSkillToken(HOST_METHOD_PLUGIN_NAME, skills[0]!.name) }
      : {}),
  });
}

/** Codex run-scoped HOME/.agents/skills overlay; mirrors operator skills; CODEX_HOME stays real. */
export async function stageCodexSkillHome(options: {
  runDirectory: string; operatorHome: string; methods: readonly MethodBinding[];
}) {
  const skills = hostMethodSkills(options.methods);
  if (!skills.length) return undefined;
  const home = join(options.runDirectory, "codex-skill-home");
  const skillsRoot = join(home, ".agents", "skills");
  await mkdir(skillsRoot, { recursive: true });
  try {
    for (const entry of await readdir(join(options.operatorHome, ".agents", "skills"), { withFileTypes: true })) {
      if ((!entry.isDirectory() && !entry.isSymbolicLink()) || entry.name.startsWith(".")) continue;
      if (skills.some((s) => s.name === entry.name)) continue;
      try { await symlink(join(options.operatorHome, ".agents", "skills", entry.name), join(skillsRoot, entry.name)); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    }
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  await linkSkills(skillsRoot, skills);
  return Object.freeze({ home, skills });
}

export function hermesSkillsArgs(skills: readonly HostMethodSkill[]): string[] {
  return skills.flatMap((s) => ["--skills", s.name]);
}
