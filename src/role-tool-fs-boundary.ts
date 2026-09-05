/**
 * Role tool filesystem boundary (#692).
 *
 * One layer at the shared-envelope tool seam:
 * - edit/write: path must land in workspace or process temp (symlink-component realpath).
 * - bash: fail-closed. Only (a) strict read-only simple commands with no shell
 *   metacharacters, or (b) simple mutation verbs/redirects whose every concrete
 *   literal path resolves inside bounds. Everything else is denied — no wrapper
 *   allowlist arms race, no “unknown exe + path-looking args” pass.
 * - detour: same bash rules on script bodies; opaque engines only when OS write
 *   sandbox confines (Darwin). Reads unrestricted. Ledger/host IO out of scope.
 */
import { lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

import {
  pathContainedIn,
  physicalPathIdentity,
} from "./activation-ledger-topology.ts";

export const ROLE_TOOL_FS_BOUNDARY_CODE = "role-tool-fs-boundary" as const;

export type RoleToolFsBoundaryRoots = Readonly<{
  workspaceRoot: string;
  tempRoot: string;
}>;

export type RoleToolFsBoundaryViolation = Readonly<{
  code: typeof ROLE_TOOL_FS_BOUNDARY_CODE;
  toolName: string;
  paths: readonly string[];
  reason: string;
}>;

/** Verbs that may mutate when given path operands / redirects. */
const MUTATION_VERBS = new Set([
  "rm", "rmdir", "unlink", "mv", "cp", "ln", "install", "truncate", "dd",
  "touch", "mkdir", "tee", "shred", "chmod", "chown", "chgrp",
]);

/**
 * Verbs that are read-only only as a single simple command with no shell
 * metacharacters and no write flags (sed -i / find -delete / git config set).
 */
const READ_ONLY_VERBS = new Set([
  "cat", "head", "tail", "less", "more", "ls", "ll", "dir",
  "find", "grep", "egrep", "fgrep", "rg", "ag", "ack",
  "wc", "stat", "file", "diff", "cmp", "md5", "md5sum", "sha256sum",
  "echo", "printf", "true", "false", "test", "[",
  "pwd", "which", "type", "printenv",
  "date", "whoami", "id", "uname", "hostname", "basename", "dirname",
  "realpath", "readlink", "jq", "yq", "sort", "uniq", "cut", "tr", "awk", "sed",
  "sleep", "seq", "cal", "df", "du", "free", "ps", "git",
]);

/**
 * Any of these in the command string means the shell can embed unprovable work
 * (substitution, background, pipeline, brace, etc.). Strict read-only and
 * simple-mutation paths both reject them.
 */
const SHELL_META = /\$|`|;|\||&|\n|\r|\(|\)|\{|\}|<|>|~|\*|\?/;

export function defaultRoleToolFsBoundaryRoots(cwd: string): RoleToolFsBoundaryRoots {
  return {
    workspaceRoot: physicalPathIdentity(cwd),
    tempRoot: physicalPathIdentity(tmpdir()),
  };
}

export function isWithinRoleToolFsBoundary(
  candidate: string,
  roots: RoleToolFsBoundaryRoots,
): boolean {
  const identity = physicalPathIdentity(candidate);
  const workspace = physicalPathIdentity(roots.workspaceRoot);
  const temp = physicalPathIdentity(roots.tempRoot);
  return (
    identity === workspace ||
    identity === temp ||
    pathContainedIn(workspace, identity) ||
    pathContainedIn(temp, identity)
  );
}

export function roleToolFsBoundaryDenyReason(
  toolName: string,
  paths: readonly string[],
): string {
  const shown = paths.length === 0 ? "(unprovable or outside path)" : paths.join(", ");
  return (
    `角色工具文件系统边界：${toolName} 不得删改工作区与临时目录之外的路径（${ROLE_TOOL_FS_BOUNDARY_CODE}）：${shown}`
  );
}

/**
 * Resolve a user path with symlink components followed left-to-right.
 * Does NOT lexically collapse `..` before following (closes link/../escape).
 */
export function resolveMutationPath(raw: string, cwd: string): string {
  const expanded = expandUserHome(raw);
  const absolute = isAbsolute(expanded)
    ? expanded.replace(/\/{2,}/g, "/")
    : appendRelativePreservingDots(physicalPathIdentity(cwd), expanded);
  return followComponents(absolute);
}

export function assessRoleToolFsBoundary(input: {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly cwd: string;
  readonly roots?: RoleToolFsBoundaryRoots;
}): RoleToolFsBoundaryViolation | undefined {
  if (input.toolName !== "bash" && input.toolName !== "edit" && input.toolName !== "write") {
    return undefined;
  }
  const roots = input.roots ?? defaultRoleToolFsBoundaryRoots(input.cwd);

  if (input.toolName === "edit" || input.toolName === "write") {
    const path = input.toolInput.path;
    if (typeof path !== "string" || path.length === 0) return undefined;
    return denyIfOutside(input.toolName, [path], input.cwd, roots);
  }

  const command = input.toolInput.command;
  if (typeof command !== "string" || command.length === 0) return undefined;
  return assessBashCommand(command, input.cwd, roots, "bash");
}

export function assessDetourArgvFsBoundary(input: {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly roots?: RoleToolFsBoundaryRoots;
}): RoleToolFsBoundaryViolation | undefined {
  if (input.argv.length === 0) return undefined;
  const roots = input.roots ?? defaultRoleToolFsBoundaryRoots(input.cwd);
  const exe = basename(input.argv[0] ?? "");
  const rest = input.argv.slice(1);

  if (MUTATION_VERBS.has(exe)) {
    const targets = rest.filter((t) => t !== "--" && !(t.startsWith("-") && t !== "-"));
    if (targets.length === 0 || targets.some((t) => SHELL_META.test(t))) {
      return denyUnprovable("ak_engine_detour");
    }
    return denyIfOutside("ak_engine_detour", targets, input.cwd, roots)
      ?? undefined;
  }

  const body = scriptBodyFromArgv(exe, rest);
  if (body !== undefined) {
    return assessBashCommand(body, input.cwd, roots, "ak_engine_detour");
  }

  // Opaque engine binary: only when OS write sandbox confines the child.
  if (process.platform === "darwin") return undefined;
  return denyUnprovable("ak_engine_detour");
}

function assessBashCommand(
  command: string,
  cwd: string,
  roots: RoleToolFsBoundaryRoots,
  toolName: string,
): RoleToolFsBoundaryViolation | undefined {
  const trimmed = command.trim();
  if (trimmed.length === 0) return undefined;

  // Nested bash -c / -lc bodies: assess body; outer is still not a free pass.
  for (const body of extractNestedShellBodies(trimmed)) {
    const hit = assessBashCommand(body, cwd, roots, toolName);
    if (hit !== undefined) return hit;
  }

  // Strict read-only: one simple command, allowlisted verb, zero shell meta.
  if (isStrictReadOnly(trimmed)) return undefined;

  // Simple mutation: mutation verb and/or redirects with only concrete literal paths.
  const mutation = trySimpleConcreteMutation(trimmed, cwd, roots, toolName);
  if (mutation !== "not-simple") return mutation;

  return denyUnprovable(toolName);
}

function isStrictReadOnly(command: string): boolean {
  if (SHELL_META.test(command)) return false;
  if (/>>?/.test(command)) return false;
  const tokens = tokenizeShell(command);
  let idx = 0;
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]!)) idx += 1;
  if (idx >= tokens.length) return false;
  const verb = basename(tokens[idx]!);
  if (!READ_ONLY_VERBS.has(verb)) return false;
  if (verb === "find" && /(?:-delete|-exec\b|-fprint)/.test(command)) return false;
  if (verb === "sed" && /(?:^|\s)-[a-zA-Z]*i[a-zA-Z]*(?:\s|$)/.test(command)) return false;
  if (verb === "git") {
    const args = tokens.slice(idx + 1);
    const sub = args.find((a) => !a.startsWith("-"));
    if (sub === undefined) return true;
    const reads = new Set([
      "status", "log", "diff", "show", "rev-parse", "rev-list",
      "branch", "tag", "remote", "ls-files", "ls-tree", "cat-file",
      "describe", "blame", "shortlog", "help", "version",
    ]);
    if (sub === "config") {
      return args.some((a) => a === "--list" || a === "--get" || a === "-l" || a === "--get-regexp");
    }
    return reads.has(sub);
  }
  // Remaining tokens must be free of shell meta (already whole-command checked).
  return true;
}

/**
 * @returns violation | undefined (allow) | "not-simple"
 */
function trySimpleConcreteMutation(
  command: string,
  cwd: string,
  roots: RoleToolFsBoundaryRoots,
  toolName: string,
): RoleToolFsBoundaryViolation | undefined | "not-simple" {
  // Reject if any shell meta remains besides redirect operators.
  const withoutRedirectOps = command.replace(/(?:^|[\s\d])>>?\|?/g, " ");
  if (SHELL_META.test(withoutRedirectOps)) return "not-simple";

  const tokens = tokenizeShell(command);
  if (tokens.length === 0) return "not-simple";

  const targets: string[] = [];
  // Redirect destinations.
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok === ">" || tok === ">>" || tok === ">|" || tok === "&>" || tok === "&>>") {
      const next = tokens[i + 1];
      if (typeof next === "string" && next.length > 0) targets.push(next);
      continue;
    }
    const fused = /^(?:.*[^>])?(>>?\|?)(.+)$/.exec(tok);
    if (fused && tok.includes(">") && fused[2] && !fused[2].startsWith("&")) {
      targets.push(fused[2]);
    }
  }

  let idx = 0;
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]!)) idx += 1;
  if (idx >= tokens.length) {
    return targets.length > 0 ? denyIfOutside(toolName, targets, cwd, roots) ?? undefined : "not-simple";
  }
  const verb = basename(tokens[idx]!);
  const isMutation = MUTATION_VERBS.has(verb);
  if (!isMutation && targets.length === 0) return "not-simple";

  if (isMutation) {
    idx += 1;
    for (; idx < tokens.length; idx += 1) {
      const tok = tokens[idx]!;
      if (tok === "--") continue;
      if (tok === ">" || tok === ">>" || tok === ">|" || tok === "&>" || tok === "&>>" || tok === "<" || tok === "<<") {
        idx += 1;
        continue;
      }
      if (tok.startsWith("-") && tok !== "-") continue;
      targets.push(tok);
    }
  }

  if (targets.length === 0) return denyUnprovable(toolName);
  if (targets.some((t) => SHELL_META.test(t))) return denyUnprovable(toolName);
  return denyIfOutside(toolName, targets, cwd, roots) ?? undefined;
}

function denyUnprovable(toolName: string): RoleToolFsBoundaryViolation {
  return {
    code: ROLE_TOOL_FS_BOUNDARY_CODE,
    toolName,
    paths: [],
    reason: roleToolFsBoundaryDenyReason(toolName, []),
  };
}

function denyIfOutside(
  toolName: string,
  rawTargets: readonly string[],
  cwd: string,
  roots: RoleToolFsBoundaryRoots,
): RoleToolFsBoundaryViolation | undefined {
  const outside: string[] = [];
  for (const raw of rawTargets) {
    const resolved = resolveMutationPath(raw, cwd);
    if (!isWithinRoleToolFsBoundary(resolved, roots)) outside.push(resolved);
  }
  if (outside.length === 0) return undefined;
  return {
    code: ROLE_TOOL_FS_BOUNDARY_CODE,
    toolName,
    paths: outside,
    reason: roleToolFsBoundaryDenyReason(toolName, outside),
  };
}

/** Exported for unit coverage of path extraction on simple mutation forms. */
export function extractBashMutationTargetPaths(command: string): string[] {
  if (SHELL_META.test(command.replace(/(?:^|[\s\d])>>?\|?/g, " "))) return [];
  const tokens = tokenizeShell(command);
  const targets: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok === ">" || tok === ">>" || tok === ">|") {
      const next = tokens[i + 1];
      if (typeof next === "string") targets.push(next);
    }
  }
  let idx = 0;
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]!)) idx += 1;
  if (idx < tokens.length && MUTATION_VERBS.has(basename(tokens[idx]!))) {
    for (let i = idx + 1; i < tokens.length; i += 1) {
      const tok = tokens[i]!;
      if (tok === "--") continue;
      if (tok.startsWith("-") && tok !== "-") continue;
      if (tok === ">" || tok === ">>") {
        i += 1;
        continue;
      }
      targets.push(tok);
    }
  }
  return targets;
}

function scriptBodyFromArgv(exe: string, rest: readonly string[]): string | undefined {
  const shells = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
  const nodeFlags = new Set(["-e", "--eval", "-p", "--print"]);
  const cFlags = new Set(["-c", "--command", "-lc", "-ic", "-sc"]);
  const interpreters = new Set(["python", "python3", "ruby", "perl", "php", "lua", "node", "nodejs"]);
  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i]!;
    if (shells.has(exe) && (cFlags.has(tok) || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(tok)) && i + 1 < rest.length) {
      return rest[i + 1]!;
    }
    if ((exe === "node" || exe === "nodejs") && nodeFlags.has(tok) && i + 1 < rest.length) {
      return `eval ${rest[i + 1]!}`;
    }
    if (interpreters.has(exe) && cFlags.has(tok) && i + 1 < rest.length) {
      return `eval ${rest[i + 1]!}`;
    }
  }
  return undefined;
}

function extractNestedShellBodies(command: string): string[] {
  const bodies: string[] = [];
  const re =
    /\b(?:env\s+)?(?:bash|sh|zsh|dash|ksh)\b((?:\s+-[a-zA-Z0-9]+)*)\s+(?:'([^']*)'|"([^"]*)"|(\S+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    const flags = match[1] ?? "";
    if (!/-[a-zA-Z]*c[a-zA-Z]*/.test(flags)) continue;
    const body = match[2] ?? match[3] ?? match[4];
    if (typeof body === "string" && body.length > 0) bodies.push(body);
  }
  return bodies;
}

function expandUserHome(raw: string): string {
  if (raw === "~") return process.env.HOME ?? raw;
  if (raw.startsWith(`~${sep}`) || raw.startsWith("~/")) {
    const home = process.env.HOME;
    if (typeof home !== "string" || home.length === 0) return raw;
    return appendRelativePreservingDots(home, raw.slice(2));
  }
  return raw;
}

function appendRelativePreservingDots(base: string, rel: string): string {
  const parts = rel.split(/[/\\]/).filter((p) => p.length > 0);
  let cur = base;
  for (const part of parts) {
    cur = cur.endsWith(sep) ? `${cur}${part}` : `${cur}${sep}${part}`;
  }
  return cur;
}

function followComponents(absolute: string): string {
  if (absolute === sep) return sep;
  const parts = absolute.split(sep).filter((p) => p.length > 0);
  let current = absolute.startsWith(sep) ? sep : "";
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (part === ".") continue;
    if (part === "..") {
      current = current === sep || current === "" ? current : dirname(current);
      if (current === "") current = sep;
      continue;
    }
    const next = current === sep ? `${sep}${part}` : current === "" ? part : join(current, part);
    try {
      lstatSync(next);
      try {
        current = realpathSync(next);
      } catch {
        current = next;
      }
    } catch {
      const rest = parts.slice(i);
      const prefix =
        current === ""
          ? physicalPathIdentity(process.cwd())
          : physicalPathIdentity(current === sep ? sep : current);
      return rest.reduce((acc, p) => {
        if (p === ".") return acc;
        if (p === "..") return dirname(acc);
        return join(acc, p);
      }, prefix === sep && rest.length ? sep : prefix);
    }
  }
  try {
    return realpathSync(current);
  } catch {
    return physicalPathIdentity(current);
  }
}

function tokenizeShell(command: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < command.length) {
    while (i < command.length && /\s/.test(command[i]!)) i += 1;
    if (i >= command.length) break;
    const ch = command[i]!;
    if (ch === "'") {
      i += 1;
      let value = "";
      while (i < command.length && command[i] !== "'") value += command[i++]!;
      if (i < command.length) i += 1;
      tokens.push(value);
      continue;
    }
    if (ch === '"') {
      i += 1;
      let value = "";
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < command.length) {
          value += command[i + 1]!;
          i += 2;
          continue;
        }
        value += command[i++]!;
      }
      if (i < command.length) i += 1;
      tokens.push(value);
      continue;
    }
    if (ch === ">" || ch === "<" || ch === "&") {
      let op = ch;
      i += 1;
      if (ch === ">" && i < command.length && (command[i] === ">" || command[i] === "|")) op += command[i++]!;
      else if (ch === "&" && i < command.length && command[i] === ">") {
        op += ">";
        i += 1;
        if (i < command.length && command[i] === ">") op += command[i++]!;
      } else if (ch === "<" && i < command.length && command[i] === "<") op += command[i++]!;
      if ((op === ">" || op === ">>" || op === ">|") && i < command.length && !/\s/.test(command[i]!) && command[i] !== "&") {
        let path = "";
        while (i < command.length && !/\s/.test(command[i]!) && !"<>&|;".includes(command[i]!)) path += command[i++]!;
        tokens.push(op);
        if (path.length > 0) tokens.push(path);
        continue;
      }
      tokens.push(op);
      continue;
    }
    let value = "";
    while (i < command.length && !/\s/.test(command[i]!) && !"<>&|;".includes(command[i]!)) {
      if (command[i] === "\\" && i + 1 < command.length) {
        value += command[i + 1]!;
        i += 2;
        continue;
      }
      value += command[i++]!;
    }
    if (value.length > 0) tokens.push(value);
  }
  return tokens;
}
