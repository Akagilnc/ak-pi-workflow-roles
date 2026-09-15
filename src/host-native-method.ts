/**
 * #922 host-native forced-method delivery.
 * claude/grok → --plugin-dir (dist/method-host-plugin, build-only);
 * codex/hermes → cwd `.agents/skills` → resources/methods (envelope-owned).
 *
 * Catalog: create-if-absent; never overwrite foreign; delete only links this
 * process created (in-process hold count). Cross-process concurrent same-cwd
 * ownership needs a design ruling (stable non-delete catalog vs approved lock);
 * not inventing either here after escalate.
 */
import { constants } from "node:fs";
import {
  access, lstat, mkdir, readFile, readlink, realpath, readdir, rm, symlink, unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { MethodBinding } from "./host-contracts.ts";

export type HostMethodSkill = Readonly<{ name: string; dir: string; path: string }>;
export const HOST_METHOD_PLUGIN_NAME = "ak-methods" as const;

export const packagedMethodsDir = (r: string) => join(r, "resources", "methods");
export const packagedMethodPluginDir = (r: string) => join(r, "dist", "method-host-plugin");

export function hostMethodSkills(methods: readonly MethodBinding[]): readonly HostMethodSkill[] {
  return Object.freeze(methods.flatMap((m) => {
    if (m.kind !== "skill") return [];
    const dir = dirname(m.path);
    const name = basename(dir);
    return name ? [Object.freeze({ name, dir, path: m.path })] : [];
  }));
}

export const pluginSkillToken = (plugin: string, skill: string) => `${plugin}:${skill}`;

export function applyHostSlashSkillInvocation(token: string, prompt: string): string {
  if (!token) return prompt;
  const slash = token.startsWith("/") ? token : `/${token}`;
  const t = prompt.trimStart();
  if (t === slash || t.startsWith(`${slash} `) || t.startsWith(`${slash}\n`)) return prompt;
  return prompt ? `${slash} ${prompt}` : slash;
}

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

export function forcedPluginSlashToken(methods: readonly MethodBinding[]): string | undefined {
  const skills = hostMethodSkills(methods);
  return skills.length === 1 ? pluginSkillToken(HOST_METHOD_PLUGIN_NAME, skills[0]!.name) : undefined;
}

export const hostUsesWorkspaceAgentsSkills = (host?: string) => {
  const n = host?.trim();
  return n === "codex" || n === "hermes";
};

const exists = async (p: string) => access(p, constants.F_OK).then(() => true, () => false);
const sameReal = async (a: string, b: string) => {
  try { return (await realpath(a)) === (await realpath(b)); }
  catch { return resolve(a) === resolve(b); }
};

export async function ensurePackagedMethodPlugin(packageRoot: string): Promise<string> {
  const outDir = packagedMethodPluginDir(packageRoot);
  const probe = join(outDir, "skills", "tdd", "SKILL.md");
  try {
    if ((await lstat(probe)).isFile()) return outDir;
  } catch { /* missing */ }
  throw new Error(
    `method-host-plugin missing at ${probe}; package build must materialize it (npm run build / prepack).`,
  );
}

export type WorkspaceAgentsSkillsLink = Readonly<{
  path: string;
  created: boolean;
  release(): Promise<void>;
}>;

const conflict = (path: string, detail: string) => new Error(
  `workspace method catalog conflict at ${path}: ${detail}. ` +
  "ak-role only creates `.agents/skills` when absent; never overwrites an existing catalog (#922).",
);

/** linkPath → hold count for links this process created. */
const createdHolds = new Map<string, number>();
const createdAgentsDirs = new Set<string>();

export async function installWorkspaceAgentsSkillsLink(options: {
  readonly cwd: string; readonly packageRoot: string;
}): Promise<WorkspaceAgentsSkillsLink> {
  const target = await realpath(packagedMethodsDir(options.packageRoot));
  const linkPath = join(options.cwd, ".agents", "skills");
  const agentsDir = dirname(linkPath);
  let released = false;

  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    const n = createdHolds.get(linkPath);
    if (n === undefined) return;
    if (n > 1) {
      createdHolds.set(linkPath, n - 1);
      return;
    }
    createdHolds.delete(linkPath);
    try {
      if ((await lstat(linkPath)).isSymbolicLink() && (await sameReal(linkPath, target))) await unlink(linkPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (!createdAgentsDirs.has(agentsDir)) return;
    createdAgentsDirs.delete(agentsDir);
    try {
      if ((await readdir(agentsDir)).length === 0) await rm(agentsDir, { force: true });
    } catch { /* best-effort */ }
  };

  try {
    const st = await lstat(linkPath);
    if (!st.isSymbolicLink()) {
      throw conflict(linkPath, st.isDirectory() ? "pre-existing directory" : "pre-existing non-symlink");
    }
    if (!(await sameReal(linkPath, target))) {
      throw conflict(linkPath, `pre-existing symlink → ${await readlink(linkPath).catch(() => "?")}`);
    }
    if (!createdHolds.has(linkPath)) {
      return Object.freeze({ path: linkPath, created: false, release: async () => undefined });
    }
    createdHolds.set(linkPath, (createdHolds.get(linkPath) ?? 0) + 1);
    return Object.freeze({ path: linkPath, created: true, release });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  if (!(await exists(agentsDir))) {
    await mkdir(agentsDir, { recursive: true });
    createdAgentsDirs.add(agentsDir);
  }
  try {
    await symlink(target, linkPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return installWorkspaceAgentsSkillsLink(options);
    if (createdAgentsDirs.has(agentsDir)) {
      createdAgentsDirs.delete(agentsDir);
      await rm(agentsDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw e;
  }
  createdHolds.set(linkPath, 1);
  return Object.freeze({ path: linkPath, created: true, release });
}

export async function findGitProjectRoot(start: string): Promise<string | undefined> {
  for (let cur = resolve(start), i = 0; i < 64; i++) {
    if (await exists(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
  return undefined;
}

export function parseHermesTrustedProjectDirs(yaml: string): readonly string[] {
  const out: string[] = [];
  let inSkills = false, inTrusted = false, skillsIndent = -1, trustedIndent = -1;
  for (const raw of yaml.split(/\r?\n/)) {
    if (/^\s*#/.test(raw) || !raw.trim()) continue;
    const indent = raw.match(/^ */)?.[0]?.length ?? 0;
    const t = raw.trim();
    if (!inSkills) {
      if (/^skills:\s*$/.test(t)) { inSkills = true; skillsIndent = indent; }
      continue;
    }
    if (indent <= skillsIndent) break;
    if (!inTrusted) {
      const m = t.match(/^trusted_project_dirs:\s*(.*)$/);
      if (!m) continue;
      inTrusted = true;
      trustedIndent = indent;
      const rest = m[1]!.trim();
      if (rest.startsWith("[") && rest.endsWith("]")) {
        for (const p of rest.slice(1, -1).split(",")) {
          const v = p.trim().replace(/^["']|["']$/g, "");
          if (v) out.push(v);
        }
        break;
      }
      continue;
    }
    if (indent <= trustedIndent) break;
    const item = t.match(/^- \s*(.+)$/);
    if (!item) continue;
    let v = item[1]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    const hash = v.search(/\s+#/);
    if (hash >= 0) v = v.slice(0, hash).trim();
    if (v) out.push(v);
  }
  return Object.freeze(out);
}

export async function readHermesTrustedProjectDirs(hermesHome: string): Promise<readonly string[]> {
  try {
    return parseHermesTrustedProjectDirs(await readFile(join(hermesHome, "config.yaml"), "utf8"));
  } catch {
    return Object.freeze([]);
  }
}

export async function assertHermesProjectSkillsTrusted(options: {
  readonly home: string; readonly cwd: string; readonly profileName: string;
}): Promise<void> {
  const projectRoot = await findGitProjectRoot(options.cwd);
  if (!projectRoot) {
    throw new Error("hermes packaged methods need a git project root under cwd so `.agents/skills` can load.");
  }
  const projectReal = await realpath(projectRoot).catch(() => resolve(projectRoot));
  const dirs = [
    ...await readHermesTrustedProjectDirs(join(options.home, ".hermes", "profiles", options.profileName)),
    ...await readHermesTrustedProjectDirs(join(options.home, ".hermes")),
  ];
  for (const entry of dirs) {
    const expanded = entry.startsWith("~")
      ? join(options.home, entry.slice(1).replace(/^\//, ""))
      : entry;
    try {
      if ((await realpath(expanded)) === projectReal) return;
    } catch {
      if (resolve(expanded) === projectReal) return;
    }
  }
  throw new Error(
    `hermes project skills are not trusted for ${projectReal}. ` +
    `Operator must run \`hermes skills trust\` (same \`-p ${options.profileName}\` if used); ` +
    "ak-role does not write host trust config (#922).",
  );
}
