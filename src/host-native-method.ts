/**
 * #922 host-native forced-method delivery.
 * claude/grok → --plugin-dir (dist/method-host-plugin, build-only);
 * codex/hermes → cwd `.agents/skills` → resources/methods (envelope-owned).
 *
 * Catalog ownership: durable holder tokens on disk (pid:uuid) + mkdir lock
 * (wait if live owner; dead lock fails loud — no pathname steal/ABA).
 * Release is per-handle idempotent. Foreign catalogs are never modified.
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access, lstat, mkdir, readFile, readlink, realpath, readdir, rename, rm, rmdir, symlink, unlink, writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { MethodBinding } from "./host-contracts.ts";

export type HostMethodSkill = Readonly<{ name: string; dir: string; path: string }>;
export const HOST_METHOD_PLUGIN_NAME = "ak-methods" as const;
export const WORKSPACE_AGENTS_SKILLS_REF = ".ak-roles-method-skills-ref";
const WORKSPACE_AGENTS_SKILLS_LOCK = ".ak-roles-method-skills-lock";

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
const pidAlive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
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
  held: boolean;
  release(): Promise<void>;
}>;

const conflict = (path: string, detail: string) => new Error(
  `workspace method catalog conflict at ${path}: ${detail}. ` +
  "ak-role only creates `.agents/skills` when absent; never overwrites an existing catalog (#922).",
);

type SkillsRef = { readonly target: string; readonly holders: readonly string[] };

async function readRef(refPath: string): Promise<SkillsRef | undefined> {
  try {
    const raw = JSON.parse(await readFile(refPath, "utf8")) as { target?: unknown; holders?: unknown };
    if (typeof raw.target !== "string" || !Array.isArray(raw.holders)) return undefined;
    const holders = raw.holders.filter((h): h is string => typeof h === "string" && h.includes(":"));
    return { target: raw.target, holders };
  } catch {
    return undefined;
  }
}

async function writeRef(refPath: string, value: SkillsRef): Promise<void> {
  const tmp = `${refPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ target: value.target, holders: value.holders })}\n`, "utf8");
  await rename(tmp, refPath);
}

function holderPid(holder: string): number {
  return Number(holder.slice(0, holder.indexOf(":")));
}

function pruneHolders(holders: readonly string[]): string[] {
  return holders.filter((h) => pidAlive(holderPid(h)));
}

/** In-process serialization per lock path. */
const processChains = new Map<string, Promise<unknown>>();

async function withProcessChain<T>(key: string, body: () => Promise<T>): Promise<T> {
  const prev = processChains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  processChains.set(key, prev.then(() => gate, () => gate));
  await prev.catch(() => undefined);
  try {
    return await body();
  } finally {
    release();
  }
}

/**
 * mkdir exclusive lock. The successful mkdir *is* ownership — competitors never
 * rmdir a lock dir they did not create (avoids mkdir→owner write race).
 * Live/unknown owner → wait. Dead owner file → loud fail (no steal/ABA).
 */
async function withDirLock<T>(lockDir: string, body: () => Promise<T>): Promise<T> {
  return withProcessChain(lockDir, async () => {
    const ownerPath = join(lockDir, "owner");
    const token = randomUUID();
    const payload = `${process.pid}\n${token}\n`;
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        await mkdir(lockDir);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        // Competitor holds or is initializing — wait; never rmdir their dir.
        try {
          const ownerText = await readFile(ownerPath, "utf8");
          const ownerPid = Number(ownerText.split(/\r?\n/)[0]);
          if (Number.isInteger(ownerPid) && ownerPid > 0 && !pidAlive(ownerPid)) {
            throw new Error(
              `stale workspace agents skills lock at ${lockDir} (dead pid ${ownerPid}); ` +
                "remove that directory and retry — ak-role does not auto-steal locks (#922).",
            );
          }
        } catch (inner) {
          if (inner instanceof Error && /stale workspace agents skills lock/.test(inner.message)) throw inner;
          // owner file not yet written (init window) or unreadable — wait
        }
        if (Date.now() > deadline) throw new Error(`workspace agents skills lock busy: ${lockDir}`);
        await new Promise((r) => setTimeout(r, 10));
        continue;
      }
      // We alone created lockDir.
      try {
        await writeFile(ownerPath, payload, "utf8");
        return await body();
      } finally {
        try {
          if ((await readFile(ownerPath, "utf8")) === payload) await unlink(ownerPath);
        } catch { /* owner missing */ }
        try {
          await rmdir(lockDir);
        } catch { /* not empty or already gone */ }
      }
    }
  });
}

async function linkIsOurTarget(linkPath: string, target: string): Promise<boolean> {
  try {
    return (await lstat(linkPath)).isSymbolicLink() && (await sameReal(linkPath, target));
  } catch {
    return false;
  }
}

export async function installWorkspaceAgentsSkillsLink(options: {
  readonly cwd: string; readonly packageRoot: string;
}): Promise<WorkspaceAgentsSkillsLink> {
  const target = await realpath(packagedMethodsDir(options.packageRoot));
  const linkPath = join(options.cwd, ".agents", "skills");
  const agentsDir = dirname(linkPath);
  const refPath = join(agentsDir, WORKSPACE_AGENTS_SKILLS_REF);
  const lockDir = join(agentsDir, WORKSPACE_AGENTS_SKILLS_LOCK);
  const holderId = `${process.pid}:${randomUUID()}`;
  let held = false;
  let released = false;

  const release = async (): Promise<void> => {
    if (!held || released) return;
    released = true;
    held = false;
    if (!(await exists(agentsDir))) return;
    await withDirLock(lockDir, async () => {
      const cur = await readRef(refPath);
      if (cur === undefined || cur.target !== target) return;
      const left = pruneHolders(cur.holders).filter((h) => h !== holderId);
      if (left.length > 0) {
        await writeRef(refPath, { target, holders: left });
        return;
      }
      if (await linkIsOurTarget(linkPath, target)) await unlink(linkPath);
      await unlink(refPath).catch(() => undefined);
    });
    try {
      if ((await readdir(agentsDir)).length === 0) await rm(agentsDir, { force: true });
    } catch { /* best-effort */ }
  };

  if (!(await exists(agentsDir))) await mkdir(agentsDir, { recursive: true });

  await withDirLock(lockDir, async () => {
    try {
      const st = await lstat(linkPath);
      if (!st.isSymbolicLink()) {
        throw conflict(linkPath, st.isDirectory() ? "pre-existing directory" : "pre-existing non-symlink");
      }
      if (!(await sameReal(linkPath, target))) {
        throw conflict(linkPath, `pre-existing symlink → ${await readlink(linkPath).catch(() => "?")}`);
      }
      const cur = await readRef(refPath);
      const live = cur?.target === target ? pruneHolders(cur.holders) : [];
      if (live.length === 0 && (cur === undefined || cur.target !== target)) {
        // Foreign same-target — never own.
        held = false;
        return;
      }
      await writeRef(refPath, { target, holders: [...live, holderId] });
      if (!(await linkIsOurTarget(linkPath, target))) {
        await writeRef(refPath, { target, holders: live }).catch(() => undefined);
        throw new Error(`workspace method catalog disappeared under lock at ${linkPath}`);
      }
      held = true;
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }

    await symlink(target, linkPath);
    try {
      await writeRef(refPath, { target, holders: [holderId] });
    } catch (e) {
      await unlink(linkPath).catch(() => undefined);
      throw e;
    }
    if (!(await linkIsOurTarget(linkPath, target))) {
      await unlink(linkPath).catch(() => undefined);
      await unlink(refPath).catch(() => undefined);
      throw new Error(`workspace method catalog missing after create at ${linkPath}`);
    }
    held = true;
  });

  if (held) return Object.freeze({ path: linkPath, held: true, release });
  if (!(await linkIsOurTarget(linkPath, target))) {
    throw new Error(`workspace method catalog unavailable at ${linkPath}`);
  }
  return Object.freeze({ path: linkPath, held: false, release: async () => undefined });
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

/** Structured extract of skills.trusted_project_dirs (exact path compare after expand). */
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
    // strip inline comments
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
