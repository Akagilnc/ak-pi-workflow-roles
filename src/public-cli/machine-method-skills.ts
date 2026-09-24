import { accessSync, constants, statSync } from "node:fs";
import { lstat, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { HEADLESS_HOST_DESCRIPTIONS, HOST_DESCRIPTIONS } from "../host-descriptions.ts";

const MATT_SKILLS = ["tdd", "diagnosing-bugs", "resolving-merge-conflicts"] as const;
const AK_SKILLS = ["ak-cross-m-review"] as const;

function skillRoots(home: string, host: string): string[] {
  if (host === "grok-build") return [join(home, ".agents/skills")];
  if (host === "hermes") return [join(home, ".hermes/skills")];
  if (host !== "claude-code" && host !== "pi" && host !== "codex") return [];
  const native = host === "claude-code"
    ? join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude"), "skills")
    : host === "pi"
      ? join(home, ".pi/agent/skills")
      : join(process.env.CODEX_HOME?.trim() || join(home, ".codex"), "skills");
  return [native, ...(host === "pi" || host === "codex" ? [join(home, ".agents/skills")] : [])];
}

export function installedMethodSkillPath(home: string, host: string, name: string): string | undefined {
  for (const root of skillRoots(home, host)) {
    const path = join(root, name, "SKILL.md");
    try {
      if (statSync(path).isFile()) return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
    }
  }
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

export async function warnMissingMethodSkills(
  home: string,
  host: string | undefined,
  role: string,
  skills: readonly string[],
  stdout: (text: string) => void,
): Promise<void> {
  const nativeHost = host === undefined ? "pi" : host === "claude" ? "claude-code" : host;
  if (skillRoots(home, nativeHost).length === 0) return;
  const missing: string[] = [];
  for (const skill of skills) {
    if (installedMethodSkillPath(home, nativeHost, skill) === undefined) missing.push(skill);
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
  const canonical = join(home, ".agents/skills");
  const missingMatt: string[] = [];
  for (const name of MATT_SKILLS) if (!(await occupied(join(canonical, name)))) missingMatt.push(name);
  const missingAk: string[] = [];
  for (const name of AK_SKILLS) if (!(await occupied(join(canonical, name)))) missingAk.push(name);
  if (!addSkills("mattpocock/skills", missingMatt, home)) return 1;
  if (!addSkills("Akagilnc/ak-cross-m-review", missingAk, home)) return 1;

  for (const host of ["claude-code", "hermes"] as const) {
    const root = skillRoots(home, host)[0]!;
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
      if (installedMethodSkillPath(home, "grok-build", name) === undefined) continue;
      const link = join(root, name);
      if (await occupied(link)) continue;
      await mkdir(root, { recursive: true });
      await symlink(target, link, "dir");
    }
  }
  stdout("Machine method Skills setup finished. Existing same-name Skills were left untouched.\n");
  return 0;
}
