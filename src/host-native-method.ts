/**
 * Host-native forced-method delivery (#922 / method-skill-delivery=host-native-loader).
 * Package never reads method bodies into systemPrompt; adapters point each host
 * loader at packaged method dirs and invoke via that host's native form.
 */
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { MethodBinding } from "./host-contracts.ts";

export type HostMethodSkill = Readonly<{
  name: string;
  dir: string;
  path: string;
}>;

export const HOST_METHOD_PLUGIN_NAME = "ak-methods" as const;

export function hostMethodSkills(methods: readonly MethodBinding[]): readonly HostMethodSkill[] {
  return Object.freeze(
    methods.flatMap((method) => {
      if (method.kind !== "skill") return [];
      const dir = dirname(method.path);
      const name = basename(dir);
      return name.length === 0 ? [] : [Object.freeze({ name, dir, path: method.path })];
    }),
  );
}

export function pluginSkillToken(pluginName: string, skillName: string): string {
  return `${pluginName}:${skillName}`;
}

/** Prefix prompt with one slash token when forced; idempotent. */
export function applyHostSlashSkillInvocation(token: string, prompt: string): string {
  if (token.length === 0) return prompt;
  const slash = token.startsWith("/") ? token : `/${token}`;
  const trimmed = prompt.trimStart();
  if (trimmed === slash || trimmed.startsWith(`${slash} `) || trimmed.startsWith(`${slash}\n`)) {
    return prompt;
  }
  return prompt.length === 0 ? slash : `${slash} ${prompt}`;
}

/**
 * Codex explicit skill mention: linked `[$name](/abs/SKILL.md)` selects by path
 * in the host catalog (official mentions). Bare `$name` already present is kept.
 */
export function applyCodexSkillInvocation(
  skills: readonly HostMethodSkill[],
  prompt: string,
): string {
  if (skills.length !== 1) return prompt;
  const skill = skills[0]!;
  const linked = `[$${skill.name}](${skill.path})`;
  const bare = `$${skill.name}`;
  const trimmed = prompt.trimStart();
  for (const token of [linked, bare]) {
    if (trimmed === token || trimmed.startsWith(`${token} `) || trimmed.startsWith(`${token}\n`)) {
      return prompt;
    }
  }
  return prompt.length === 0 ? linked : `${linked} ${prompt}`;
}

async function linkSkillDirs(skillsRoot: string, skills: readonly HostMethodSkill[]): Promise<void> {
  await mkdir(skillsRoot, { recursive: true });
  for (const skill of skills) {
    try {
      await symlink(skill.dir, join(skillsRoot, skill.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/** Claude/Grok `--plugin-dir` shape: plugin root with `skills/<name>` → method dir. */
export async function stageHostMethodPlugin(
  runDirectory: string,
  methods: readonly MethodBinding[],
): Promise<Readonly<{ pluginDir: string; skills: readonly HostMethodSkill[]; slashToken?: string }> | undefined> {
  const skills = hostMethodSkills(methods);
  if (skills.length === 0) return undefined;
  const pluginDir = join(runDirectory, "host-method-plugin");
  await mkdir(join(pluginDir, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(pluginDir, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({
      name: HOST_METHOD_PLUGIN_NAME,
      version: "0.0.0",
      description: "ak-roles packaged role method skills",
    })}\n`,
  );
  await linkSkillDirs(join(pluginDir, "skills"), skills);
  return Object.freeze({
    pluginDir,
    skills,
    ...(skills.length === 1
      ? { slashToken: pluginSkillToken(HOST_METHOD_PLUGIN_NAME, skills[0]!.name) }
      : {}),
  });
}

/**
 * Codex discovery overlay: run-scoped HOME with `.agents/skills/<name>` → method dir.
 * Mirrors operator `~/.agents/skills` so the overlay does not close that surface.
 * Child keeps real CODEX_HOME for auth.
 */
export async function stageCodexSkillHome(options: {
  readonly runDirectory: string;
  readonly operatorHome: string;
  readonly methods: readonly MethodBinding[];
}): Promise<Readonly<{ home: string; skills: readonly HostMethodSkill[] }> | undefined> {
  const skills = hostMethodSkills(options.methods);
  if (skills.length === 0) return undefined;
  const home = join(options.runDirectory, "codex-skill-home");
  const skillsRoot = join(home, ".agents", "skills");
  await mkdir(skillsRoot, { recursive: true });
  const operatorSkills = join(options.operatorHome, ".agents", "skills");
  try {
    for (const entry of await readdir(operatorSkills, { withFileTypes: true })) {
      if ((!entry.isDirectory() && !entry.isSymbolicLink()) || entry.name.startsWith(".")) continue;
      if (skills.some((skill) => skill.name === entry.name)) continue;
      try {
        await symlink(join(operatorSkills, entry.name), join(skillsRoot, entry.name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await linkSkillDirs(skillsRoot, skills);
  return Object.freeze({ home, skills });
}

export function hermesSkillsArgs(skills: readonly HostMethodSkill[]): string[] {
  return skills.flatMap((skill) => ["--skills", skill.name]);
}
