import { accessSync, constants, statSync } from "node:fs";
import { lstat, mkdir, symlink } from "node:fs/promises";
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

async function occupied(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

function warnOccupied(path: string, stdout: (text: string) => void): void {
  stdout(`Warning: ${path} is already occupied; left untouched.\n`);
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

function runSkillsCli(args: readonly string[], home: string): boolean {
  const result = spawnSync("npx", ["--yes", "skills", ...args], {
    stdio: "inherit",
    env: { ...process.env, HOME: home },
  });
  if (result.error !== undefined) throw result.error;
  return result.status === 0;
}

function addSkills(source: string, skills: readonly string[], home: string): boolean {
  if (skills.length === 0) return true;
  return runSkillsCli([
    "add", source,
    ...skills.flatMap((skill) => ["--skill", skill]),
    "--agent", "codex", "--global", "--yes",
  ], home);
}

function updateRequiredSkills(home: string): boolean {
  return runSkillsCli(["update", "-g", "-y", ...MATT_SKILLS, ...AK_SKILLS], home);
}

/** Explicit user-run setup; delegates acquisition/install to the ecosystem Skills CLI. */
export async function runMachineSkillSetup(home: string, stdout: (text: string) => void): Promise<number> {
  const canonical = skillRoot(home);
  const missingMatt: string[] = [];
  const missingAk: string[] = [];
  const queue = async (name: string, missing: string[]): Promise<void> => {
    const path = join(canonical, name);
    if (await occupied(path)) {
      warnOccupied(path, stdout);
      return;
    }
    missing.push(name);
  };
  for (const name of MATT_SKILLS) await queue(name, missingMatt);
  for (const name of AK_SKILLS) await queue(name, missingAk);
  if (!addSkills("mattpocock/skills", missingMatt, home)) return 1;
  if (!addSkills("Akagilnc/ak-cross-m-review", missingAk, home)) return 1;
  if (!updateRequiredSkills(home)) return 1;

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
      if (await occupied(link)) {
        warnOccupied(link, stdout);
        continue;
      }
      await mkdir(root, { recursive: true });
      await symlink(target, link, "dir");
    }
  }
  stdout("Machine method Skills setup finished. Existing same-name Skills were left untouched.\n");
  return 0;
}
