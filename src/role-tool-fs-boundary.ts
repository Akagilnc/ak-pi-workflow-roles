/**
 * Role tool filesystem boundary (#692).
 * One layer at the shared-envelope tool seam: write/delete/move only inside the
 * current workspace root and the process temp root (realpath / symlink-stable).
 * Ordinary bash/edit/write violations block that call with a typed error; the
 * run continues. Engine-detour violations are a detour failure (ADR 0071).
 * Reads are unrestricted. Envelope/host trusted ledger IO is out of scope.
 */
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

import {
  pathContainedIn,
  physicalPathIdentity,
} from "./activation-ledger-topology.ts";

export const ROLE_TOOL_FS_BOUNDARY_CODE = "role-tool-fs-boundary" as const;

/** Tools whose mutation targets are subject to the boundary. */
export const ROLE_TOOL_FS_BOUNDARY_TOOLS = ["bash", "edit", "write"] as const;
export type RoleToolFsBoundaryTool = (typeof ROLE_TOOL_FS_BOUNDARY_TOOLS)[number];

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
  "rm",
  "rmdir",
  "unlink",
  "mv",
  "cp",
  "ln",
  "install",
  "truncate",
  "dd",
  "touch",
  "mkdir",
  "tee",
  "shred",
  "chmod",
  "chown",
  "chgrp",
]);

export function defaultRoleToolFsBoundaryRoots(cwd: string): RoleToolFsBoundaryRoots {
  return {
    workspaceRoot: physicalPathIdentity(cwd),
    tempRoot: physicalPathIdentity(tmpdir()),
  };
}

/** True when candidate lands on or inside either allowed root (symlink-stable). */
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
  const shown = paths.length === 0 ? "(unresolved path)" : paths.join(", ");
  return (
    `角色工具文件系统边界：${toolName} 不得删改工作区与临时目录之外的路径（${ROLE_TOOL_FS_BOUNDARY_CODE}）：${shown}`
  );
}

/**
 * Collect mutation target paths from a bash command string.
 * Covers rm/mv/cp/redirects and simple command lists; not a full shell parser.
 * Read-only commands contribute no targets (read remains unrestricted).
 */
export function extractBashMutationTargetPaths(command: string): string[] {
  const targets: string[] = [];
  for (const simple of splitSimpleCommands(command)) {
    collectMutationTargetsFromSimpleCommand(simple, targets);
  }
  return targets;
}

/**
 * Assess one tool_call for boundary violation. Undefined = allow.
 * edit/write: `path` argument. bash: mutation targets only.
 */
export function assessRoleToolFsBoundary(input: {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly cwd: string;
  readonly roots?: RoleToolFsBoundaryRoots;
}): RoleToolFsBoundaryViolation | undefined {
  const toolName = input.toolName;
  if (
    toolName !== "bash" &&
    toolName !== "edit" &&
    toolName !== "write"
  ) {
    return undefined;
  }

  const roots = input.roots ?? defaultRoleToolFsBoundaryRoots(input.cwd);
  const rawTargets = mutationTargetPathsForTool(toolName, input.toolInput);
  if (rawTargets.length === 0) return undefined;

  const outside: string[] = [];
  for (const raw of rawTargets) {
    const absolute = resolvePathAgainstCwd(raw, input.cwd);
    if (!isWithinRoleToolFsBoundary(absolute, roots)) {
      outside.push(absolute);
    }
  }
  if (outside.length === 0) return undefined;

  return {
    code: ROLE_TOOL_FS_BOUNDARY_CODE,
    toolName,
    paths: outside,
    reason: roleToolFsBoundaryDenyReason(toolName, outside),
  };
}

/**
 * Detour argv mutation check. argv[0] is the executable (may live outside).
 * Remaining path-like tokens that resolve outside W/T are violations when the
 * invocation is a known mutation command or embeds absolute outside paths next
 * to write-like shell text (covers scripted `rm`/`mv`/`writeFile` fixtures).
 */
export function assessDetourArgvFsBoundary(input: {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly roots?: RoleToolFsBoundaryRoots;
}): RoleToolFsBoundaryViolation | undefined {
  if (input.argv.length === 0) return undefined;
  const roots = input.roots ?? defaultRoleToolFsBoundaryRoots(input.cwd);
  const exe = basename(input.argv[0] ?? "");
  const rest = input.argv.slice(1);

  const targets: string[] = [];
  if (MUTATION_COMMANDS.has(exe)) {
    for (const token of rest) {
      if (token === "--") continue;
      if (token.startsWith("-") && token !== "-") continue;
      targets.push(token);
    }
  } else {
    // shell -c SCRIPT / shell -lc SCRIPT / node -e CODE: assess the script body.
    const scriptBodies = scriptBodiesFromArgv(exe, rest);
    for (const body of scriptBodies) {
      targets.push(...extractBashMutationTargetPaths(body));
    }
  }

  if (targets.length === 0) return undefined;

  const outside: string[] = [];
  for (const raw of targets) {
    const absolute = resolvePathAgainstCwd(raw, input.cwd);
    if (!isWithinRoleToolFsBoundary(absolute, roots)) {
      outside.push(absolute);
    }
  }
  if (outside.length === 0) return undefined;

  return {
    code: ROLE_TOOL_FS_BOUNDARY_CODE,
    toolName: "ak_engine_detour",
    paths: outside,
    reason: roleToolFsBoundaryDenyReason("ak_engine_detour", outside),
  };
}

const SHELL_SCRIPT_FLAGS = new Set(["-c", "-lc", "-ic", "-sc"]);
const NODE_EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print"]);

function scriptBodiesFromArgv(exe: string, rest: readonly string[]): string[] {
  const bodies: string[] = [];
  const isShell =
    exe === "bash" ||
    exe === "sh" ||
    exe === "zsh" ||
    exe === "dash" ||
    exe === "ksh";
  const isNode = exe === "node" || exe === "nodejs";
  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i]!;
    if (isShell && SHELL_SCRIPT_FLAGS.has(tok) && i + 1 < rest.length) {
      bodies.push(rest[i + 1]!);
      i += 1;
      continue;
    }
    if (isNode && NODE_EVAL_FLAGS.has(tok) && i + 1 < rest.length) {
      // node -e bodies are JS; still scan for embedded shell-like rm/mv text
      // and absolute path write patterns used by isolation fixtures.
      bodies.push(rest[i + 1]!);
      i += 1;
      continue;
    }
  }
  // Fallback: whole rest joined, so free-form engine argv still yields mutation paths.
  if (bodies.length === 0 && rest.length > 0) {
    bodies.push(rest.join(" "));
  }
  return bodies;
}

function mutationTargetPathsForTool(
  toolName: "bash" | "edit" | "write",
  toolInput: Record<string, unknown>,
): string[] {
  if (toolName === "edit" || toolName === "write") {
    const path = toolInput.path;
    return typeof path === "string" && path.length > 0 ? [path] : [];
  }
  const command = toolInput.command;
  if (typeof command !== "string" || command.length === 0) return [];
  return extractBashMutationTargetPaths(command);
}

function resolvePathAgainstCwd(raw: string, cwd: string): string {
  const expanded = expandUserHome(raw);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
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

function splitSimpleCommands(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote !== null) {
      current += ch;
      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        current += command[i + 1]!;
        i += 1;
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
    // Command separators / pipes start a new simple command.
    if (ch === "|" || ch === ";" || ch === "&") {
      if (ch === "&" && command[i + 1] === "&") {
        pushCurrent();
        i += 1;
        continue;
      }
      if (ch === "|" && command[i + 1] === "|") {
        pushCurrent();
        i += 1;
        continue;
      }
      if (ch === "|") {
        // Pipeline: left may still hold redirects; right is new command.
        pushCurrent();
        continue;
      }
      pushCurrent();
      continue;
    }
    // Newline as separator.
    if (ch === "\n") {
      pushCurrent();
      continue;
    }
    current += ch;
  }
  pushCurrent();
  return parts;

  function pushCurrent(): void {
    const trimmed = current.trim();
    current = "";
    if (trimmed.length > 0) parts.push(trimmed);
  }
}

function collectMutationTargetsFromSimpleCommand(
  simple: string,
  targets: string[],
): void {
  const tokens = tokenizeShell(simple);
  if (tokens.length === 0) return;

  // Redirections anywhere in the simple command (write targets).
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok === ">" || tok === ">>" || tok === ">|" || tok === "&>" || tok === "&>>") {
      const next = tokens[i + 1];
      if (typeof next === "string" && next.length > 0 && next !== "&") {
        targets.push(next);
      }
      continue;
    }
    // `n>path` fused form
    const fused = /^(\d*)>>?\|?$/.exec(tok);
    if (fused !== null) {
      const next = tokens[i + 1];
      if (typeof next === "string" && next.length > 0) targets.push(next);
      continue;
    }
    const fusedPath = /^(\d*)>>?\|?(.*)$/.exec(tok);
    if (fusedPath !== null && fusedPath[2] && fusedPath[2].length > 0 && tok.includes(">")) {
      // e.g. >file or 2>file without space — only when operator present
      if (tok.includes(">") && !tok.startsWith("<")) {
        const pathPart = fusedPath[2];
        if (pathPart.length > 0 && pathPart !== "&1" && pathPart !== "&2") {
          targets.push(pathPart);
        }
      }
    }
  }

  // Leading env assignments: FOO=bar cmd ...
  let idx = 0;
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]!)) {
    idx += 1;
  }
  if (idx >= tokens.length) return;

  let cmd = tokens[idx]!;
  // Strip path prefix from command name: /bin/rm → rm
  cmd = basename(cmd);
  if (!MUTATION_COMMANDS.has(cmd)) return;

  idx += 1;
  // Options until -- or first non-flag operand.
  const operands: string[] = [];
  let endFlags = false;
  for (; idx < tokens.length; idx += 1) {
    const tok = tokens[idx]!;
    if (!endFlags && tok === "--") {
      endFlags = true;
      continue;
    }
    // Skip redirect tokens and their targets (already collected).
    if (tok === ">" || tok === ">>" || tok === ">|" || tok === "&>" || tok === "&>>" || tok === "<" || tok === "<<") {
      idx += 1; // skip target
      continue;
    }
    if (!endFlags && tok.startsWith("-") && tok !== "-") {
      // flag; some take a value (-t dir for install) — treat next as operand if not flag-like
      // Only skip pure flags; path-taking flags still need care for mv -t DEST.
      if ((cmd === "mv" || cmd === "cp" || cmd === "ln" || cmd === "install") &&
        (tok === "-t" || tok === "--target-directory") &&
        idx + 1 < tokens.length
      ) {
        operands.push(tokens[idx + 1]!);
        idx += 1;
      }
      continue;
    }
    // Stop at further operators already handled as separators.
    operands.push(tok);
  }

  for (const op of operands) {
    if (op.length > 0) targets.push(op);
  }
}

function tokenizeShell(command: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < command.length) {
    while (i < command.length && /\s/.test(command[i]!)) i += 1;
    if (i >= command.length) break;
    const ch = command[i]!;
    if (ch === "'" ) {
      i += 1;
      let value = "";
      while (i < command.length && command[i] !== "'") {
        value += command[i]!;
        i += 1;
      }
      if (i < command.length) i += 1; // closing '
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
        value += command[i]!;
        i += 1;
      }
      if (i < command.length) i += 1;
      tokens.push(value);
      continue;
    }
    // Operators as their own tokens when not fused with a path.
    if (ch === ">" || ch === "<" || ch === "&") {
      let op = ch;
      i += 1;
      if (ch === ">" && i < command.length && (command[i] === ">" || command[i] === "|")) {
        op += command[i]!;
        i += 1;
      } else if (ch === "&" && i < command.length && command[i] === ">") {
        op += ">";
        i += 1;
        if (i < command.length && command[i] === ">") {
          op += ">";
          i += 1;
        }
      } else if (ch === "<" && i < command.length && command[i] === "<") {
        op += "<";
        i += 1;
      }
      // Fused path after operator without space: >file
      if ((op === ">" || op === ">>" || op === ">|" ) && i < command.length && !/\s/.test(command[i]!) && command[i] !== "&") {
        let path = "";
        while (i < command.length && !/\s/.test(command[i]!) && !"<>&|;".includes(command[i]!)) {
          path += command[i]!;
          i += 1;
        }
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
      value += command[i]!;
      i += 1;
    }
    if (value.length > 0) tokens.push(value);
  }
  return tokens;
}

