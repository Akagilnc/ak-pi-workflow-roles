/**
 * #922 host-native forced-method delivery.
 * claude/grok → --plugin-dir (dist/method-host-plugin, build-only materialize);
 * codex/hermes → cwd `.agents/skills` → resources/methods (envelope-owned).
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access, lstat, mkdir, readFile, readlink, realpath, readdir, rename, rm, symlink, unlink, writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { MethodBinding } from "./host-contracts.ts";

export type HostMethodSkill = Readonly<{ name: string; dir: string; path: string }>;
export const HOST_METHOD_PLUGIN_NAME = "ak-methods" as const;
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

const pidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Build/prepack is the sole writer of dist/method-host-plugin. */
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
  held: boolean;
  release(): Promise<void>;
}>;

const conflict = (path: string, detail: string) => new Error(
  `workspace method catalog conflict at ${path}: ${detail}. ` +
  "ak-role only creates `.agents/skills` when absent; never overwrites an existing catalog (#922).",
);

/** holder id = `${pid}:${uuid}` so same-process overlapping installs stay distinct. */
type SkillsRef = { readonly target: string; readonly holders: readonly string[] };

async function readRef(refPath: string): Promise<SkillsRef | undefined> {
  try {
    const raw = JSON.parse(await readFile(refPath, "utf8")) as { target?: unknown; holders?: unknown; pids?: unknown };
    if (typeof raw.target !== "string") return undefined;
    // Accept legacy `{pids:number[]}` from earlier bounce shape and map to holder ids.
    if (Array.isArray(raw.holders)) {
      const holders = raw.holders.filter((h): h is string => typeof h === "string" && h.includes(":"));
      return { target: raw.target, holders };
    }
    if (Array.isArray(raw.pids)) {
      const holders = raw.pids
        .filter((p): p is number => Number.isInteger(p) && (p as number) > 0)
        .map((p) => `${p}:legacy`);
      return { target: raw.target, holders };
    }
    return undefined;
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

/** Test-only hooks for deterministic mutual-exclusion / busy sequencing. */
export type AgentsSkillsLockHooks = Readonly<{
  onEnter?: () => void;
  onLeave?: () => void;
  /** After seeing a live foreign lock, before backoff sleep. */
  afterBusy?: (content: string) => Promise<void>;
}>;

let agentsSkillsLockHooks: AgentsSkillsLockHooks | undefined;

/** Test-only. Production never sets hooks. */
export function setAgentsSkillsLockHooksForTest(hooks: AgentsSkillsLockHooks | undefined): void {
  agentsSkillsLockHooks = hooks;
}

function parseLockPayload(text: string): { readonly pid: number; readonly token: string } | undefined {
  const [pidLine, tokenLine] = text.split(/\r?\n/);
  const pid = Number(pidLine);
  if (!Number.isInteger(pid) || pid <= 0 || typeof tokenLine !== "string" || tokenLine === "") return undefined;
  return { pid, token: tokenLine };
}

/** Per-path in-process chain — serializes overlapping installs/releases in one process. */
const processLockChains = new Map<string, Promise<unknown>>();

async function withProcessChain<T>(key: string, body: () => Promise<T>): Promise<T> {
  const prev = processLockChains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const hold = new Promise<void>((r) => {
    release = r;
  });
  processLockChains.set(
    key,
    prev.then(
      () => hold,
      () => hold,
    ),
  );
  await prev.catch(() => undefined);
  try {
    return await body();
  } finally {
    release();
  }
}

/**
 * In-process mutex + cross-process advisory file (pid+token).
 * Release deletes the file only when contents still equal this holder's payload (no ABA delete).
 * Dead-owner lock is **not** auto-stolen (pathname steal is ABA-unsafe); fails loud with rm path.
 */
export async function withAgentsSkillsLock<T>(lockPath: string, body: () => Promise<T>): Promise<T> {
  return withProcessChain(lockPath, async () => {
    const deadline = Date.now() + 5_000;
    const token = randomUUID();
    const payload = `${process.pid}\n${token}\n`;
    for (;;) {
      try {
        await writeFile(lockPath, payload, { flag: "wx" });
        agentsSkillsLockHooks?.onEnter?.();
        try {
          return await body();
        } finally {
          agentsSkillsLockHooks?.onLeave?.();
          try {
            if ((await readFile(lockPath, "utf8")) === payload) await unlink(lockPath);
          } catch {
            // not ours or already gone
          }
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        let text = "";
        try {
          text = await readFile(lockPath, "utf8");
        } catch {
          continue; // disappeared — retry create
        }
        const parsed = parseLockPayload(text);
        if (parsed !== undefined && !pidAlive(parsed.pid)) {
          throw new Error(
            `stale workspace agents skills lock at ${lockPath} (dead pid ${parsed.pid}); ` +
              "remove that file and retry — ak-role does not auto-steal pathname locks (#922).",
          );
        }
        await agentsSkillsLockHooks?.afterBusy?.(text);
        if (Date.now() > deadline) {
          throw new Error(`workspace agents skills lock busy: ${lockPath}`);
        }
        await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 15)));
      }
    }
  });
}

async function linkIsOurTarget(linkPath: string, target: string): Promise<boolean> {
  try {
    const st = await lstat(linkPath);
    if (!st.isSymbolicLink()) return false;
    return sameReal(linkPath, target);
  } catch {
    return false;
  }
}

/**
 * Envelope-owned cwd `.agents/skills` → packaged methods.
 * All observe/create/refcount transitions run under one lock. Holders are live pids
 * (dead pids pruned). Foreign same-target links (no live our-ref) are never removed.
 */
export async function installWorkspaceAgentsSkillsLink(options: {
  readonly cwd: string; readonly packageRoot: string;
}): Promise<WorkspaceAgentsSkillsLink> {
  const target = await realpath(packagedMethodsDir(options.packageRoot));
  const linkPath = join(options.cwd, ".agents", "skills");
  const agentsDir = dirname(linkPath);
  const refPath = join(agentsDir, WORKSPACE_AGENTS_SKILLS_REF);
  const lockPath = join(agentsDir, WORKSPACE_AGENTS_SKILLS_LOCK);
  const holderId = `${process.pid}:${randomUUID()}`;
  let held = false;

  const release = async (): Promise<void> => {
    if (!held) return;
    held = false;
    if (!(await exists(agentsDir))) return;
    await withAgentsSkillsLock(lockPath, async () => {
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

  await withAgentsSkillsLock(lockPath, async () => {
    // Single critical section: classify → hold or create. Never return success without a live catalog.
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
        // Same-target link without a live package-owned ref → foreign; leave untouched.
        held = false;
        return;
      }
      await writeRef(refPath, { target, holders: [...live, holderId] });
      if (!(await linkIsOurTarget(linkPath, target))) {
        await writeRef(refPath, { target, holders: live }).catch(() => unlink(refPath).catch(() => undefined));
        throw new Error(`workspace method catalog disappeared under lock at ${linkPath}`);
      }
      held = true;
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }

    // Missing link — create symlink then ref; roll back link if ref write fails.
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
  // Foreign path: verify catalog still there for the caller.
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
