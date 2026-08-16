/**
 * Worker git hook scope (②④ install + #355 migrate).
 * Node/git only — no Pi peer runtime — so the public CLI bundle can call migrate.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

/** Marker: own-package hooks are reloadable across HOOK body changes; foreign hooks refuse. */
const HOOK_MARKER = "ak-roles: worker-submission-gates reference-transaction";
/** Path segment for our private hooksPath dirs (install + known-location migrate). */
const HOOKS_DIR_NAME = "ak-roles-hooks";
const HOOK_FILE_NAME = "reference-transaction";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined },
  }).trim();
}

function gitFile(file: string, args: string[]): string {
  return execFileSync("git", ["config", "--file", file, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined },
  }).trim();
}

function execStatus(error: unknown): unknown {
  return typeof error === "object" && error !== null && "status" in error
    ? (error as { status: unknown }).status
    : undefined;
}

function tryGitFileGet(file: string, key: string): string | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return gitFile(file, ["--get", key]);
  } catch (error) {
    // Only --get exit 1 means unset; other failures stay loud (same shape as install).
    if (execStatus(error) !== 1) throw error;
    return undefined;
  }
}

/** Sole ownership criterion: package HOOK_MARKER inside reference-transaction. */
function isOwnedHookFile(hookPath: string): boolean {
  if (!existsSync(hookPath)) return false;
  try {
    return readFileSync(hookPath, "utf8").includes(HOOK_MARKER);
  } catch {
    return false;
  }
}

function isOwnedHooksDir(dir: string): boolean {
  return isOwnedHookFile(resolve(dir, HOOK_FILE_NAME));
}

/**
 * Unset core.hooksPath only when it points at a package-owned hooks dir.
 * Returns prior value after a successful unset (or verified already-unset).
 * Lock/permission/malformed failures propagate — never wash into success.
 */
function unsetAkRolesHooksPathInFile(file: string): string | undefined {
  const value = tryGitFileGet(file, "core.hooksPath");
  if (value === undefined || !isOwnedHooksDir(value)) return undefined;
  try {
    gitFile(file, ["--unset", "core.hooksPath"]);
  } catch (error) {
    // git config --unset exits 5 when the key is already absent.
    if (execStatus(error) !== 5) throw error;
  }
  return value;
}

/** Remove a private hooks dir only when it carries our marker file. */
function removeOurHookDir(dir: string): void {
  if (!isOwnedHooksDir(dir)) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort residue */
  }
}

/** Legacy default-hooks location: delete only the owned file, never the shared hooks dir. */
function removeOwnedLegacyDefaultHook(commonDir: string): void {
  const hookPath = resolve(commonDir, "hooks", HOOK_FILE_NAME);
  if (!isOwnedHookFile(hookPath)) return;
  try {
    rmSync(hookPath, { force: true });
  } catch {
    /* best-effort residue */
  }
}

function worktreePathsFromPorcelain(porcelain: string): string[] {
  const paths: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length));
  }
  return paths;
}

/** Linked-worktree admin dirs under commonDir/worktrees/* (live and prunable). */
function linkedWorktreeGitDirs(commonDir: string): string[] {
  const root = resolve(commonDir, "worktrees");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const gitDir = resolve(root, name);
    try {
      if (statSync(gitDir).isDirectory()) out.push(gitDir);
    } catch {
      /* vanished between readdir and stat */
    }
  }
  return out;
}

/**
 * Migration path (ticket #355 验收③): strip common-config and stale worktree
 * hooksPath entries that point at package-owned hooks, remove owned hook dirs,
 * and clear the legacy commonDir/hooks/reference-transaction file when marked.
 * Does not arm a worktree — next envelope coder/fixer install re-binds locally.
 *
 * Diagnostic (#355): installer history never wrote common hooksPath in-tree
 * (b10de7ec wrote the hook *file* into the shared default hooks dir; 5194e08d
 * introduced `--worktree` hooksPath). Live common pollution is residual outside
 * that write path; install now purges + asserts so the seam cannot re-leak.
 */
export function migrateWorkerGitHookScope(cwd: string): void {
  let inside: string;
  try {
    inside = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch (error) {
    throw new Error(
      `ak-roles: migrateWorkerGitHookScope requires a git work tree: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (inside !== "true") {
    throw new Error("ak-roles: migrateWorkerGitHookScope requires a git work tree");
  }

  const commonDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const commonConfig = resolve(commonDir, "config");

  const commonHooks = unsetAkRolesHooksPathInFile(commonConfig);
  if (commonHooks !== undefined) removeOurHookDir(commonHooks);

  // Main worktree config lives at commonDir/config.worktree.
  const mainWtConfig = resolve(commonDir, "config.worktree");
  const mainHooks = unsetAkRolesHooksPathInFile(mainWtConfig);
  if (mainHooks !== undefined) removeOurHookDir(mainHooks);
  removeOurHookDir(resolve(commonDir, HOOKS_DIR_NAME));

  // Pre-private-hooksPath installer wrote into the shared default hooks dir.
  removeOwnedLegacyDefaultHook(commonDir);

  // One metadata route for live + prunable linked worktrees (no cwd rev-parse).
  for (const gitDir of linkedWorktreeGitDirs(commonDir)) {
    const wtConfig = resolve(gitDir, "config.worktree");
    const hooks = unsetAkRolesHooksPathInFile(wtConfig);
    if (hooks !== undefined) removeOurHookDir(hooks);
    removeOurHookDir(resolve(gitDir, HOOKS_DIR_NAME));
  }
}

// ② each newly-created commit (incl. empty subject): missing platform prefix → bounce (open set).
// ④ ban non-fast-forward. Merge commits (2+ parents) exempt from ②.
// Scoped by install: worktree-local core.hooksPath → only the armed tree; common must stay clean.
const HOOK = `#!/bin/sh
# ${HOOK_MARKER}
[ "$1" = prepared ] || exit 0
while read -r old new ref; do
  case $ref in refs/heads/*|HEAD) ;; *) continue ;; esac
  [ -n "$new" ] && [ -n "$(printf %s "$new" | tr -d 0)" ] || continue
  if [ -n "$old" ] && [ -n "$(printf %s "$old" | tr -d 0)" ]; then
    git merge-base --is-ancestor "$old" "$new" 2>/dev/null || { echo "ak-roles: rejected non-fast-forward update of $ref (no amend/rebase/reset)" >&2; exit 1; }
  fi
  for commit in $(git rev-list "$new" --not --all 2>/dev/null); do
    # GitHub / ordinary merge commits (2+ parents) exempt from platform-prefix check.
    if git rev-parse --verify -q "\${commit}^2" >/dev/null 2>&1; then continue; fi
    subj=$(git log -1 --format=%s "$commit")
    # Open set: any leading platform ident: (constitution #10); not closed to ak-roles:.
    case $subj in
      [A-Za-z][A-Za-z0-9_-]*:*) ;;
      *) echo "ak-roles: commit subject missing platform prefix (got: $subj)" >&2; exit 1 ;;
    esac
  done
done
`;

function assertHooksScopeClean(cwd: string, commonConfig: string, expectedDir: string): void {
  // tryGitFileGet already distinguishes exit-1-unset from real read failures.
  const commonHooks = tryGitFileGet(commonConfig, "core.hooksPath");
  if (commonHooks !== undefined) {
    throw new Error(
      `ak-roles: hooks install must not leave common core.hooksPath set (got: ${commonHooks})`,
    );
  }
  let wtHooks: string;
  try {
    wtHooks = git(cwd, ["config", "--worktree", "--get", "core.hooksPath"]);
  } catch (error) {
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? (error as { status: unknown }).status
        : undefined;
    if (status !== 1) throw error;
    throw new Error("ak-roles: hooks install failed to bind worktree-local core.hooksPath");
  }
  if (wtHooks !== expectedDir) {
    throw new Error(
      `ak-roles: worktree core.hooksPath mismatch (got: ${wtHooks}, want: ${expectedDir})`,
    );
  }
}

function rollbackHookInstall(cwd: string, hooksDir: string, hookPath: string): void {
  try {
    git(cwd, ["config", "--worktree", "--unset", "core.hooksPath"]);
  } catch {
    /* unset or missing */
  }
  try {
    if (existsSync(hookPath)) {
      const body = readFileSync(hookPath, "utf8");
      if (body.includes(HOOK_MARKER)) {
        rmSync(hooksDir, { recursive: true, force: true });
      }
    }
  } catch {
    /* best-effort residue cleanup */
  }
}

/**
 * Bind ②④ to this worktree only — private hooksPath + worktree config.
 * Envelope coder/fixer arm only (call site). Refuses main worktree of a
 * multi-worktree repo so commander/human trees stay free. Never leaves shared
 * common config with hooksPath; post-write assert fails closed and rolls back.
 */
export function installWorkerGitHooks(cwd: string): void {
  // Fail closed before any shared-config write: bare host / non-work-tree is not armable.
  let inside: string;
  try {
    inside = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch (error) {
    throw new Error(
      `ak-roles: refusing worker hooks install outside a git work tree: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (inside !== "true") {
    throw new Error("ak-roles: refusing worker hooks install outside a git work tree");
  }

  const commonDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const gitDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const commonConfig = resolve(commonDir, "config");
  const mainWorktreeConfig = resolve(commonDir, "config.worktree");

  // Only envelope-linked worker trees, or a dedicated single-worktree clone.
  // Main of a multi-worktree repo is commander/human territory — do not arm.
  if (gitDir === commonDir) {
    let porcelain: string;
    try {
      porcelain = git(cwd, ["worktree", "list", "--porcelain"]);
    } catch (error) {
      throw new Error(
        `ak-roles: refusing worker hooks install; cannot list worktrees: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (worktreePathsFromPorcelain(porcelain).length > 1) {
      throw new Error(
        "ak-roles: refusing worker hooks install on main worktree of a multi-worktree repo (envelope coder/fixer linked worktree only)",
      );
    }
  }

  // Heal any prior common-scope leak before arming (same seam as migrate).
  const leaked = unsetAkRolesHooksPathInFile(commonConfig);
  if (leaked !== undefined) removeOurHookDir(leaked);

  // Snapshot worktree-only keys still sitting in common config (git docs: must move on enable).
  let bareInCommon = false;
  let worktreeInCommon: string | undefined;
  try { bareInCommon = gitFile(commonConfig, ["--get", "core.bare"]) === "true"; } catch { /* unset */ }
  try { worktreeInCommon = gitFile(commonConfig, ["--get", "core.worktree"]); } catch { /* unset */ }

  // Skip shared write when already enabled in *this* repo — concurrent sibling activations
  // otherwise race on .git/config.lock (#267). Scope must be --local (common config): a
  // global/system true must not skip the repo's first enable. Value must use Git bool
  // semantics (true/yes/on/1), not a literal "true" compare. First enable still writes;
  // real write failures still throw. Only --get exit 1 means unset; other failures stay loud.
  let worktreeConfigEnabled = false;
  try {
    worktreeConfigEnabled =
      git(cwd, ["config", "--local", "--bool", "--get", "extensions.worktreeConfig"]) === "true";
  } catch (error) {
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? (error as { status: unknown }).status
        : undefined;
    if (status !== 1) throw error;
  }
  if (!worktreeConfigEnabled) {
    git(cwd, ["config", "extensions.worktreeConfig", "true"]);
  }

  // Migrate immediately so sibling trees never observe bare-in-common under worktreeConfig.
  if (bareInCommon) {
    try { gitFile(commonConfig, ["--unset", "core.bare"]); } catch { /* raced */ }
    gitFile(mainWorktreeConfig, ["core.bare", "true"]);
  }
  if (worktreeInCommon !== undefined) {
    try { gitFile(commonConfig, ["--unset", "core.worktree"]); } catch { /* raced */ }
    gitFile(mainWorktreeConfig, ["core.worktree", worktreeInCommon]);
  }

  const dir = resolve(gitDir, HOOKS_DIR_NAME);
  const path = resolve(dir, "reference-transaction");
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    // Own-package marker → reload OK (HOOK body may change across versions).
    // Foreign same-name hook → fail closed, never overwrite.
    if (!existing.includes(HOOK_MARKER)) {
      throw new Error("ak-roles: refusing to overwrite existing reference-transaction hook");
    }
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, HOOK, "utf8");
  chmodSync(path, 0o755);
  git(cwd, ["config", "--worktree", "core.hooksPath", dir]);

  // Fail closed: common clean + only this worktree carries hooksPath. Residue rolled back.
  try {
    assertHooksScopeClean(cwd, commonConfig, dir);
  } catch (error) {
    rollbackHookInstall(cwd, dir, path);
    // Re-purge common in case the failed path polluted it.
    const again = unsetAkRolesHooksPathInFile(commonConfig);
    if (again !== undefined) removeOurHookDir(again);
    throw error;
  }
}
