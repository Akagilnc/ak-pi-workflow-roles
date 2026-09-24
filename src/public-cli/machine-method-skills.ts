import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const MATT_SKILLS = ["tdd", "diagnosing-bugs", "resolving-merge-conflicts"] as const;
const AK_SKILLS = ["ak-cross-m-review"] as const;
const HOSTS = ["claude-code", "pi", "codex"] as const;

function skillRoot(home: string, host: string): string {
  const relative = host === "claude-code"
    ? ".claude/skills"
    : host === "pi"
      ? ".pi/agent/skills"
      : ".agents/skills";
  return join(home, relative);
}

async function installed(home: string, host: string, name: string): Promise<boolean> {
  try {
    await lstat(join(skillRoot(home, host), name, "SKILL.md"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function skillNameOccupied(home: string, host: string, name: string): Promise<boolean> {
  try {
    await lstat(join(skillRoot(home, host), name));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
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
  const nativeHost = host === undefined ? "pi" : host === "claude" ? "claude-code" : host;
  const supportedHost = HOSTS.find((candidate) => candidate === nativeHost);
  const missing: string[] = [];
  for (const skill of skills) {
    if (supportedHost === undefined || !(await installed(home, supportedHost, skill))) missing.push(skill);
  }
  for (const skill of missing) {
    stdout(`Warning: required machine Skill "${skill}" is missing for ${role}; its method guidance may be unavailable and reduce work quality. Run \`ak-role setup\` to install required Skills.\n`);
  }
}

function addSkills(source: string, skills: readonly string[], host: typeof HOSTS[number], home: string): boolean {
  if (skills.length === 0) return true;
  const result = spawnSync("npx", [
    "--yes", "skills", "add", source,
    ...skills.flatMap((skill) => ["--skill", skill]),
    "--agent", host, "--global",
  ], { stdio: "inherit", env: { ...process.env, HOME: home } });
  if (result.error !== undefined) throw result.error;
  return result.status === 0;
}

/** Explicit user-run setup; delegates acquisition/install to the ecosystem Skills CLI. */
export async function runMachineSkillSetup(home: string, stdout: (text: string) => void): Promise<number> {
  for (const host of HOSTS) {
    const missingMatt: string[] = [];
    for (const name of MATT_SKILLS) if (!(await skillNameOccupied(home, host, name))) missingMatt.push(name);
    const missingAk: string[] = [];
    for (const name of AK_SKILLS) if (!(await skillNameOccupied(home, host, name))) missingAk.push(name);
    if (!addSkills("mattpocock/skills", missingMatt, host, home)) return 1;
    if (!addSkills("Akagilnc/ak-cross-m-review", missingAk, host, home)) return 1;
  }
  stdout("Machine method Skills setup finished. Existing same-name Skills were left untouched.\n");
  return 0;
}
