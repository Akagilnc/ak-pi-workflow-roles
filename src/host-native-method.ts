/**
 * #922 host-native forced-method delivery.
 * claude/grok → --plugin-dir (dist/method-host-plugin, build-only materialize);
 * codex/hermes → cwd `.agents/skills` → resources/methods (envelope-owned).
 */
import { constants } from "node:fs";
import {
  access, lstat, mkdir, open, readFile, readlink, realpath, readdir, rename, rm, symlink, unlink, writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { MethodBinding } from "./host-contracts.ts";

export type HostMethodSkill = Readonly<{ name: string; dir: string; path: string }>;
export const HOST_METHOD_PLUGIN_NAME = "ak-methods" as const;
/** Refcount next to workspace catalog; only when this package created the link. */
export const WORKSPACE_AGENTS_SKILLS_REF = ".ak-roles-method-skills-ref";
const WORKSPACE_AGENTS_SKILLS_LOCK = ".ak-roles-method-skills-lock";

export const packagedMethodsDir = (packageRoot: string) => join(packageRoot, "resources", "methods");
export const packagedMethodPluginDir = (packageRoot: string) => join(packageRoot, "dist", "method-host-plugin");

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

/** Build/prepack is the sole writer of dist/method-host-plugin — runtime never rewrites it. */
export async function ensurePackagedMethodPlugin(packageRoot: string): Promise<string> {
  const outDir = packagedMethodPluginDir(packageRoot);
  const probe = join(outDir, "skills", "tdd", "SKILL.md");
  try {
    if ((await lstat(probe)).isFile()) return outDir;
  } catch {
    // missing
  }
  throw new Error(
    `method-host-plugin missing at ${probe}; package build must materialize it (npm run build / prepack).`,
  );
}

export type WorkspaceAgentsSkillsLink = Readonly<{
  path: string;
  /** True when this call holds a ref on a catalog this package created. */
  held: boolean;
  release(): Promise<void>;
}>;

const conflict = (path: string, detail: string) => new Error(
  `workspace method catalog conflict at ${path}: ${detail}. ` +
  "ak-role only creates `.agents/skills` when absent; never overwrites an existing catalog (#922).",
);

type SkillsRef = { readonly target: string; readonly count: number };

async function readRef(refPath: string): Promise<SkillsRef | undefined> {
  try {
    const raw = JSON.parse(await readFile(refPath, "utf8")) as { target?: unknown; count?: unknown };
    if (typeof raw.target !== "string" || typeof raw.count !== "number" || !Number.isInteger(raw.count) || raw.count < 1) {
      return undefined;
    }
    return { target: raw.target, count: raw.count };
  } catch {
    return undefined;
  }
}

async function writeRef(refPath: string, value: SkillsRef): Promise<void> {
  const tmp = `${refPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value)}\n`, "utf8");
  await rename(tmp, refPath);
}

/** Exclusive create lock file; short spin. No FileHandle.lock (not on this Node). */
async function withAgentsSkillsLock<T>(lockPath: string, body: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const fh = await open(lockPath, "wx");
      try {
        return await body();
      } finally {
        await fh.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (Date.now() > deadline) throw new Error(`workspace agents skills lock timeout: ${lockPath}`);
      await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 15)));
    }
  }
}

/**
 * Envelope-owned cwd `.agents/skills` → packaged methods.
 * Pre-existing catalogs (dir / foreign link / same-target without our ref) are never owned or removed.
 * Overlapping same-cwd calls share a refcount; only the last held release removes the link.
 */
export async function installWorkspaceAgentsSkillsLink(options: {
  readonly cwd: string; readonly packageRoot: string;
}): Promise<WorkspaceAgentsSkillsLink> {
  const target = await realpath(packagedMethodsDir(options.packageRoot));
  const linkPath = join(options.cwd, ".agents", "skills");
  const agentsDir = dirname(linkPath);
  const refPath = join(agentsDir, WORKSPACE_AGENTS_SKILLS_REF);
  const lockPath = join(agentsDir, WORKSPACE_AGENTS_SKILLS_LOCK);
  let held = false;

  const release = async (): Promise<void> => {
    if (!held) return;
    held = false;
    if (!(await exists(agentsDir))) return;
    await withAgentsSkillsLock(lockPath, async () => {
      const cur = await readRef(refPath);
      if (cur === undefined || cur.target !== target) return;
      if (cur.count > 1) {
        await writeRef(refPath, { target, count: cur.count - 1 });
        return;
      }
      try {
        if ((await lstat(linkPath)).isSymbolicLink() && (await sameReal(linkPath, target))) {
          await unlink(linkPath);
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      await unlink(refPath).catch(() => undefined);
    });
    // After lock file is gone, drop empty .agents we may have created.
    try {
      if ((await readdir(agentsDir)).length === 0) await rm(agentsDir, { force: true });
    } catch { /* best-effort */ }
  };

  // Ensure agentsDir exists so the lock file has a parent (only when we will create).
  const ensureAgentsDir = async (): Promise<void> => {
    if (!(await exists(agentsDir))) await mkdir(agentsDir, { recursive: true });
  };

  // Fast path: link already present.
  try {
    const st = await lstat(linkPath);
    if (!st.isSymbolicLink()) {
      throw conflict(linkPath, st.isDirectory() ? "pre-existing directory" : "pre-existing non-symlink");
    }
    if (!(await sameReal(linkPath, target))) {
      throw conflict(linkPath, `pre-existing symlink → ${await readlink(linkPath).catch(() => "?")}`);
    }
    const existingRef = await readRef(refPath);
    if (existingRef === undefined || existingRef.target !== target) {
      // Operator/foreign same-target link — never take ownership or delete.
      return Object.freeze({ path: linkPath, held: false, release: async () => undefined });
    }
    await withAgentsSkillsLock(lockPath, async () => {
      const cur = await readRef(refPath);
      if (cur === undefined || cur.target !== target) {
        // Ref vanished under us — treat as foreign.
        return;
      }
      await writeRef(refPath, { target, count: cur.count + 1 });
      held = true;
    });
    if (!held) {
      return Object.freeze({ path: linkPath, held: false, release: async () => undefined });
    }
    return Object.freeze({ path: linkPath, held, release });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  await ensureAgentsDir();
  await withAgentsSkillsLock(lockPath, async () => {
    // Re-check after lock.
    try {
      const st = await lstat(linkPath);
      if (st.isSymbolicLink() && (await sameReal(linkPath, target))) {
        const cur = await readRef(refPath);
        if (cur !== undefined && cur.target === target) {
          await writeRef(refPath, { target, count: cur.count + 1 });
          held = true;
          return;
        }
        // Same-target link without our ref — foreign; leave it.
        return;
      }
      throw conflict(linkPath, "appeared during create");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    await symlink(target, linkPath);
    await writeRef(refPath, { target, count: 1 });
    held = true;
  });

  if (!held) {
    // Foreign same-target won the race without our ref.
    return Object.freeze({ path: linkPath, held: false, release: async () => undefined });
  }
  return Object.freeze({ path: linkPath, held, release });
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

/** Fail-closed extract of skills.trusted_project_dirs from Hermes config.yaml. */
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
      inTrusted = true; trustedIndent = indent;
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
    if (v) out.push(v);
  }
  return Object.freeze(out);
}

export async function readHermesTrustedProjectDirs(hermesHome: string): Promise<readonly string[]> {
  try { return parseHermesTrustedProjectDirs(await readFile(join(hermesHome, "config.yaml"), "utf8")); }
  catch { return Object.freeze([]); }
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
    ...await readHermesTrustedProjectDirs(join(options.home, ".hermes/profiles", options.profileName)),
    ...await readHermesTrustedProjectDirs(join(options.home, ".hermes")),
  ];
  for (const entry of dirs) {
    const expanded = entry.startsWith("~") ? join(options.home, entry.slice(1).replace(/^\//, "")) : entry;
    try { if ((await realpath(expanded)) === projectReal) return; }
    catch { if (resolve(expanded) === projectReal) return; }
  }
  throw new Error(
    `hermes project skills are not trusted for ${projectReal}. ` +
    `Operator must run \`hermes skills trust\` (same \`-p ${options.profileName}\` if used); ` +
    "ak-role does not write host trust config (#922).",
  );
}
