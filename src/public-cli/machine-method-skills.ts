import { accessSync, constants, statSync } from "node:fs";
import { lstat, mkdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { HEADLESS_HOST_DESCRIPTIONS, HOST_DESCRIPTIONS } from "../host-descriptions.ts";

const MATT_SKILLS = ["tdd", "diagnosing-bugs", "resolving-merge-conflicts"] as const;
const AK_SKILLS = ["ak-cross-m-review"] as const;

function skillRoot(home: string): string {
  return join(home, ".agents/skills");
}

export function installedMethodSkillPath(home: string, name: string): string | undefined {
  return installedSkillPath(skillRoot(home), name);
}

function installedSkillPath(root: string, name: string): string | undefined {
  const path = join(root, name, "SKILL.md");
  try {
    if (!statSync(path).isFile()) return undefined;
    accessSync(path, constants.R_OK);
    return path;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM") return undefined;
    throw error;
  }
}

function linkedSkillRoot(home: string, host: string | undefined): string | undefined {
  if (host === "claude" || host === "claude-code") {
    return join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude"), "skills");
  }
  if (host === "hermes") return join(home, ".hermes/skills");
  return undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

/** Same directory after resolution. A broken link or a different copy is not connected. */
async function resolvesTo(path: string, canonical: string): Promise<boolean> {
  try {
    return await realpath(path) === await realpath(canonical);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return false;
    throw error;
  }
}

export async function warnMissingMethodSkills(
  home: string,
  host: string | undefined,
  role: string,
  skills: readonly string[],
  stdout: (text: string) => void,
): Promise<void> {
  const missing: string[] = [];
  const linkedRoot = linkedSkillRoot(home, host);
  for (const skill of skills) {
    if (installedMethodSkillPath(home, skill) === undefined ||
      (linkedRoot !== undefined && installedSkillPath(linkedRoot, skill) === undefined)) missing.push(skill);
  }
  for (const skill of missing) {
    stdout(`Warning: required machine Skill "${skill}" is missing for ${role}; its method guidance may be unavailable and reduce work quality. Run \`ak-role setup\` to install required Skills.\n`);
  }
}

function addSkills(source: string, skills: readonly string[], home: string): boolean {
  if (skills.length === 0) return true;
  const result = spawnSync("npx", [
    "--yes", "skills", "add", source,
    ...skills.flatMap((skill) => ["--skill", skill]),
    "--agent", "codex", "--global", "--yes",
  ], { stdio: "inherit", env: { ...process.env, HOME: home } });
  if (result.error !== undefined) throw result.error;
  return result.status === 0;
}

/** Explicit user-run setup; delegates acquisition/install to the ecosystem Skills CLI. */
export async function runMachineSkillSetup(home: string, stdout: (text: string) => void): Promise<number> {
  const canonical = skillRoot(home);
  const missingMatt: string[] = [];
  const missingAk: string[] = [];
  let blocked = false;
  const classify = async (name: string, missing: string[]): Promise<void> => {
    const path = join(canonical, name);
    if (installedSkillPath(canonical, name) !== undefined) return;
    if (await pathExists(path)) {
      blocked = true;
      stdout(`Setup left "${name}" untouched at ${path}; the path is occupied but has no usable Skill, so it was not installed.\n`);
      return;
    }
    missing.push(name);
  };
  for (const name of MATT_SKILLS) await classify(name, missingMatt);
  for (const name of AK_SKILLS) await classify(name, missingAk);
  if (!addSkills("mattpocock/skills", missingMatt, home)) return 1;
  if (!addSkills("Akagilnc/ak-cross-m-review", missingAk, home)) return 1;

  for (const host of ["claude-code", "hermes"] as const) {
    const root = linkedSkillRoot(home, host)!;
    const binaryFromHome = host === "claude-code"
      ? HEADLESS_HOST_DESCRIPTIONS.claude!.binaryFromHome
      : HOST_DESCRIPTIONS.hermes!.binaryFromHome;
    try {
      accessSync(join(home, ...binaryFromHome), constants.X_OK);
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error;
    }
    for (const name of [...MATT_SKILLS, ...AK_SKILLS]) {
      const target = join(canonical, name);
      if (installedMethodSkillPath(home, name) === undefined) continue;
      const link = join(root, name);
      if (!(await pathExists(link))) {
        await mkdir(root, { recursive: true });
        await symlink(target, link, "dir");
        continue;
      }
      if (await resolvesTo(link, target)) continue;
      blocked = true;
      stdout(`Setup left "${name}" untouched at ${link}; it does not point at the machine Skill ${target}, so the host is not connected.\n`);
    }
  }
  if (blocked) return 1;
  stdout("Machine method Skills setup finished. Existing same-name Skills were left untouched.\n");
  return 0;
}
