/**
 * Role tool filesystem boundary (#692).
 * One layer: write/delete/move only inside workspace + process temp (symlink-
 * component realpath). Ordinary bash/edit/write → block call, run continues.
 * Detour → fail whole run (ADR 0071). Reads unrestricted. Unprovable bash/detour
 * mutation is fail-closed (no regex arms race). Ledger/host IO out of scope.
 */
import { lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve as lexicalResolve,
  sep,
} from "node:path";

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

const MUTATION_COMMANDS = new Set([
  "rm", "rmdir", "unlink", "mv", "cp", "ln", "install", "truncate", "dd",
  "touch", "mkdir", "tee", "shred", "chmod", "chown", "chgrp",
]);

/** Commands / forms whose mutation targets cannot be proven from argv text alone. */
const UNPROVABLE_MUTATION = /\b(?:eval|source|exec)\b|\b(?:find|xargs)\b.*(?:-delete|-exec\b|-fprint)|\b(?:python|python3|ruby|perl|php|lua)\b.*\s-c\b|\bnode(?:js)?\b.*\s(?:-e|--eval|-p)\b|\bcd\b/i;

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
 * Does NOT lexically collapse `..` before following (closes W/link/../escape).
 */
export function resolveMutationPath(raw: string, cwd: string): string {
  const expanded = expandUserHome(raw);
  // Never lexically collapse `..` before symlink follow. Relative inputs are
  // appended as literal components under real cwd (closes link/../escape).
  const absolute = isAbsolute(expanded)
    ? expandAbsoluteLexical(expanded)
    : appendRelativePreservingDots(physicalPathIdentity(cwd), expanded);
  return followComponents(absolute);
}

/**
 * Assess bash/edit/write. Undefined = allow.
 * Bash: fail-closed on unprovable mutation; proven outside targets denied.
 */
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

/** Detour argv: same fail-closed mutation rules; exe path itself may live outside. */
export function assessDetourArgvFsBoundary(input: {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly roots?: RoleToolFsBoundaryRoots;
}): RoleToolFsBoundaryViolation | undefined {
  if (input.argv.length === 0) return undefined;
  const roots = input.roots ?? defaultRoleToolFsBoundaryRoots(input.cwd);
  const exe = basename(input.argv[0] ?? "");
  const rest = input.argv.slice(1);

  if (MUTATION_COMMANDS.has(exe)) {
    const targets = rest.filter((t) => t !== "--" && !(t.startsWith("-") && t !== "-"));
    if (targets.length === 0) {
      return {
        code: ROLE_TOOL_FS_BOUNDARY_CODE,
        toolName: "ak_engine_detour",
        paths: [],
        reason: roleToolFsBoundaryDenyReason("ak_engine_detour", []),
      };
    }
    return denyIfOutside("ak_engine_detour", targets, input.cwd, roots);
  }

  const bodies = scriptBodiesFromArgv(exe, rest);
  if (bodies.length === 0) {
    // Opaque engine: only safe when OS write sandbox confines the child (Darwin).
    // Without a real-IO sandbox, fail closed — no host-native sandbox in-tree.
    if (process.platform === "darwin") return undefined;
    return {
      code: ROLE_TOOL_FS_BOUNDARY_CODE,
      toolName: "ak_engine_detour",
      paths: [],
      reason: roleToolFsBoundaryDenyReason("ak_engine_detour", []),
    };
  }
  for (const body of bodies) {
    const hit = assessBashCommand(body, input.cwd, roots, "ak_engine_detour");
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function assessBashCommand(
  command: string,
  cwd: string,
  roots: RoleToolFsBoundaryRoots,
  toolName: string,
): RoleToolFsBoundaryViolation | undefined {
  // Always assess nested shell -c bodies first (bash -c 'rm P', etc.).
  for (const body of extractNestedShellBodies(command)) {
    const hit = assessBashCommand(body, cwd, roots, toolName);
    if (hit !== undefined) return hit;
  }

  // Unprovable mutation forms: fail closed (no target extraction arms race).
  if (UNPROVABLE_MUTATION.test(command)) {
    return {
      code: ROLE_TOOL_FS_BOUNDARY_CODE,
      toolName,
      paths: [],
      reason: roleToolFsBoundaryDenyReason(toolName, []),
    };
  }

  // Nested shell without extractable -c body (or env bash …) → fail closed.
  if (/\b(?:bash|sh|zsh|dash|ksh)\b/.test(command) && extractNestedShellBodies(command).length === 0) {
    // Allow the shell binary only when the whole command is that shell alone (no args) — still no mutation.
    // Any shell invocation used as a carrier is unprovable if body wasn't extracted above.
    const trimmed = command.trim();
    if (!/^(?:\S*\/)?(?:bash|sh|zsh|dash|ksh)\s*$/.test(trimmed)) {
      return {
        code: ROLE_TOOL_FS_BOUNDARY_CODE,
        toolName,
        paths: [],
        reason: roleToolFsBoundaryDenyReason(toolName, []),
      };
    }
  }

  const targets = extractBashMutationTargetPaths(command);
  const hasMutationVerb = commandHasMutationVerb(command);
  const hasRedirect = />>?/.test(command);

  if (!hasMutationVerb && !hasRedirect) return undefined; // read-only / no mutation

  if (targets.length === 0) {
    // Mutation indicated but no extractable targets → fail closed.
    return {
      code: ROLE_TOOL_FS_BOUNDARY_CODE,
      toolName,
      paths: [],
      reason: roleToolFsBoundaryDenyReason(toolName, []),
    };
  }
  return denyIfOutside(toolName, targets, cwd, roots);
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

/** Exported for unit coverage of path extraction. */
export function extractBashMutationTargetPaths(command: string): string[] {
  const targets: string[] = [];
  for (const simple of splitSimpleCommands(command)) {
    collectMutationTargetsFromSimpleCommand(simple, targets);
  }
  return targets;
}

function commandHasMutationVerb(command: string): boolean {
  for (const simple of splitSimpleCommands(command)) {
    const tokens = tokenizeShell(simple);
    let idx = 0;
    while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]!)) idx += 1;
    if (idx >= tokens.length) continue;
    if (MUTATION_COMMANDS.has(basename(tokens[idx]!))) return true;
  }
  return false;
}

function extractNestedShellBodies(command: string): string[] {
  const bodies: string[] = [];
  // bash -c BODY / bash -lc BODY / env bash -c BODY — flag cluster containing c takes next arg.
  const re =
    /\b(?:env\s+)?(?:bash|sh|zsh|dash|ksh)\b((?:\s+-[a-zA-Z0-9]+)*)\s+(?:'([^']*)'|"([^"]*)"|(\S+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    const flags = match[1] ?? "";
    if (!/(?:^|\s)-[a-zA-Z]*c[a-zA-Z]*(?:\s|$)/.test(flags) && !/(?:^|\s)-c(?:\s|$)/.test(flags) && !/-[a-zA-Z]*c[a-zA-Z]*/.test(flags)) {
      continue;
    }
    const body = match[2] ?? match[3] ?? match[4];
    if (typeof body === "string" && body.length > 0) bodies.push(body);
  }
  return bodies;
}

const SHELL_SCRIPT_FLAGS = new Set(["-c", "-lc", "-ic", "-sc"]);
const NODE_EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print"]);
const INTERPRETER_C_FLAGS = new Set(["-c", "--command"]);
const INTERPRETER_EXES = new Set(["python", "python3", "ruby", "perl", "php", "lua", "node", "nodejs"]);

function scriptBodiesFromArgv(exe: string, rest: readonly string[]): string[] {
  const bodies: string[] = [];
  const isShell = ["bash", "sh", "zsh", "dash", "ksh"].includes(exe);
  const isNode = exe === "node" || exe === "nodejs";
  const isInterpreter = INTERPRETER_EXES.has(exe);
  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i]!;
    if (isShell && SHELL_SCRIPT_FLAGS.has(tok) && i + 1 < rest.length) {
      bodies.push(rest[i + 1]!);
      i += 1;
      continue;
    }
    if (isNode && NODE_EVAL_FLAGS.has(tok) && i + 1 < rest.length) {
      // Mark as unprovable mutation body via a sentinel the bash assessor denies.
      bodies.push(`node -e ${rest[i + 1]!}`);
      i += 1;
      continue;
    }
    if (isInterpreter && INTERPRETER_C_FLAGS.has(tok) && i + 1 < rest.length) {
      bodies.push(`${exe} -c ${rest[i + 1]!}`);
      i += 1;
    }
  }
  return bodies;
}

function expandUserHome(raw: string): string {
  if (raw === "~") return process.env.HOME ?? raw;
  if (raw.startsWith(`~${sep}`) || raw.startsWith("~/")) {
    const home = process.env.HOME;
    if (typeof home !== "string" || home.length === 0) return raw;
    return join(home, raw.slice(2));
  }
  return raw;
}

/** Absolute path: keep root, do not collapse `..` across symlink components yet. */
function expandAbsoluteLexical(absolute: string): string {
  // Normalize repeated separators only; keep .. for component walk.
  return absolute.replace(/\/{2,}/g, "/");
}

/** Append relative segments under base without collapsing `..` (followComponents owns that). */
function appendRelativePreservingDots(base: string, rel: string): string {
  const parts = rel.split(/[/\\]/).filter((p) => p.length > 0);
  let cur = base;
  for (const part of parts) {
    cur = cur.endsWith(sep) ? `${cur}${part}` : `${cur}${sep}${part}`;
  }
  return cur;
}

/**
 * Walk absolute path components left-to-right. When a component exists and is a
 * symlink, replace the walk cursor with its realpath before consuming `..`.
 */
function followComponents(absolute: string): string {
  if (absolute === sep) return sep;
  const root = absolute.startsWith(sep) ? sep : "";
  const parts = absolute.split(sep).filter((p) => p.length > 0);
  let current = root === sep ? sep : "";
  if (root !== sep && parts.length === 0) return physicalPathIdentity(absolute);

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
      const st = lstatSync(next);
      if (st.isSymbolicLink() || st.isDirectory() || st.isFile()) {
        // realpath this node so subsequent .. operate on the real parent chain.
        try {
          current = realpathSync(next);
        } catch {
          current = next;
        }
      } else {
        current = next;
      }
    } catch {
      // Missing node: rejoin remaining components lexically under current real prefix.
      const rest = parts.slice(i);
      const prefix = current === "" ? physicalPathIdentity(process.cwd()) : physicalPathIdentity(current === sep ? sep : current);
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

function splitSimpleCommands(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote !== null) {
      current += ch;
      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        current += command[++i]!;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "\n") {
      push();
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      push();
      i += 1;
      continue;
    }
    if (ch === "|" && command[i + 1] === "|") {
      push();
      i += 1;
      continue;
    }
    current += ch;
  }
  push();
  return parts;

  function push(): void {
    const t = current.trim();
    current = "";
    if (t.length > 0) parts.push(t);
  }
}

function collectMutationTargetsFromSimpleCommand(simple: string, targets: string[]): void {
  const tokens = tokenizeShell(simple);
  if (tokens.length === 0) return;

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok === ">" || tok === ">>" || tok === ">|" || tok === "&>" || tok === "&>>") {
      const next = tokens[i + 1];
      if (typeof next === "string" && next.length > 0 && next !== "&") targets.push(next);
      continue;
    }
    // Fused redirect without space: printf X>file or 2>file
    const fused = /^(?:.*[^>])?(>>?\|?)(.+)$/.exec(tok);
    if (fused !== null && fused[1] !== undefined && fused[2] !== undefined && fused[2].length > 0 && tok.includes(">")) {
      const dest = fused[2];
      if (dest !== "&1" && dest !== "&2" && !dest.startsWith("&")) targets.push(dest);
    }
  }

  let idx = 0;
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]!)) idx += 1;
  if (idx >= tokens.length) return;
  const cmd = basename(tokens[idx]!);
  if (!MUTATION_COMMANDS.has(cmd)) return;
  idx += 1;
  let endFlags = false;
  for (; idx < tokens.length; idx += 1) {
    const tok = tokens[idx]!;
    if (!endFlags && tok === "--") {
      endFlags = true;
      continue;
    }
    if (tok === ">" || tok === ">>" || tok === ">|" || tok === "&>" || tok === "&>>" || tok === "<" || tok === "<<") {
      idx += 1;
      continue;
    }
    if (!endFlags && tok.startsWith("-") && tok !== "-") {
      if (
        (cmd === "mv" || cmd === "cp" || cmd === "ln" || cmd === "install") &&
        (tok === "-t" || tok === "--target-directory") &&
        idx + 1 < tokens.length
      ) {
        targets.push(tokens[idx + 1]!);
        idx += 1;
      }
      continue;
    }
    targets.push(tok);
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

/** @internal test aid — lexicalResolve kept available for contrast cases. */
export function lexicalResolveForTest(raw: string, cwd: string): string {
  return lexicalResolve(cwd, raw);
}
