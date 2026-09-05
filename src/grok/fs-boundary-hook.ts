/**
 * Grok PreToolUse hook for #692 FS boundary (all roles).
 * Mirrors shared-envelope assessRoleToolFsBoundary for Bash/edit/write on the
 * Grok native tool surface (Pi tool_call does not see Grok-native tools).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { physicalPathIdentity } from "../activation-ledger-topology.ts";
import {
  ROLE_TOOL_FS_BOUNDARY_CODE,
  roleToolFsBoundaryDenyReason,
} from "../role-tool-fs-boundary.ts";

export const AK_FS_BOUNDARY_HOOK_FILES = [
  "ak-fs-boundary.json",
  "ak-fs-boundary.mjs",
] as const;

/**
 * Render a standalone PreToolUse hook that denies bash/edit/write outside W/T.
 * Roots are baked at install time (workspace = role cwd, temp = process tmpdir).
 */
export function renderGrokFsBoundaryHookScript(input: {
  readonly workspaceRoot: string;
  readonly tempRoot: string;
}): string {
  const workspace = physicalPathIdentity(input.workspaceRoot);
  const temp = physicalPathIdentity(input.tempRoot);
  // Inline a minimal copy of the boundary decision so the hook process does not
  // import package modules (Grok hook runner is a bare node -e style spawn).
  return `#!/usr/bin/env node
const { lstatSync, realpathSync } = require("node:fs");
const { dirname, isAbsolute, join, basename, sep } = require("node:path");
const WORKSPACE = ${JSON.stringify(workspace)};
const TEMP = ${JSON.stringify(temp)};
const CODE = ${JSON.stringify(ROLE_TOOL_FS_BOUNDARY_CODE)};

function pathContainedIn(root, candidate) {
  const rel = require("node:path").relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}
function physicalIdentity(path) {
  const absolute = require("node:path").resolve(path);
  const missing = [];
  let cursor = absolute;
  for (;;) {
    try { return missing.length === 0 ? realpathSync(cursor) : join(realpathSync(cursor), ...missing); }
    catch (e) {
      if (!e || e.code !== "ENOENT") return absolute;
      const parent = dirname(cursor);
      if (parent === cursor) return absolute;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}
function within(candidate) {
  const id = physicalIdentity(candidate);
  return id === WORKSPACE || id === TEMP || pathContainedIn(WORKSPACE, id) || pathContainedIn(TEMP, id);
}
function followComponents(absolute) {
  if (absolute === sep) return sep;
  const parts = absolute.split(sep).filter(Boolean);
  let current = absolute.startsWith(sep) ? sep : "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === ".") continue;
    if (part === "..") { current = current === sep || current === "" ? current : dirname(current); if (current === "") current = sep; continue; }
    const next = current === sep ? sep + part : current === "" ? part : join(current, part);
    try {
      lstatSync(next);
      try { current = realpathSync(next); } catch { current = next; }
    } catch {
      const rest = parts.slice(i);
      const prefix = current === "" ? physicalIdentity(process.cwd()) : physicalIdentity(current === sep ? sep : current);
      return rest.reduce((acc, p) => p === "." ? acc : p === ".." ? dirname(acc) : join(acc, p), prefix === sep && rest.length ? sep : prefix);
    }
  }
  try { return realpathSync(current); } catch { return physicalIdentity(current); }
}
function resolveMutation(raw, cwd) {
  let expanded = raw;
  if (raw === "~") expanded = process.env.HOME || raw;
  else if (raw.startsWith("~" + sep) || raw.startsWith("~/")) expanded = join(process.env.HOME || "", raw.slice(2));
  const absolute = isAbsolute(expanded) ? expanded.replace(/\\/{2,}/g, "/") : (() => {
    const base = physicalIdentity(cwd);
    return expanded.split(/[/\\\\]/).filter(Boolean).reduce((acc, p) => p === "." ? acc : p === ".." ? dirname(acc) : join(acc, p), base);
  })();
  return followComponents(absolute);
}
const MUTATION = new Set(["rm","rmdir","unlink","mv","cp","ln","install","truncate","dd","touch","mkdir","tee","shred","chmod","chown","chgrp"]);
const UNPROVABLE = /\\b(?:eval|source|exec)\\b|\\b(?:find|xargs)\\b.*(?:-delete|-exec\\b|-fprint)|\\b(?:python|python3|ruby|perl|php|lua)\\b.*\\s-c\\b|\\bnode(?:js)?\\b.*\\s(?:-e|--eval|-p)\\b|\\bcd\\b/i;

function deny(toolName, paths) {
  const shown = paths.length === 0 ? "(unprovable or outside path)" : paths.join(", ");
  return { decision: "deny", reason: "角色工具文件系统边界：" + toolName + " 不得删改工作区与临时目录之外的路径（" + CODE + "）：" + shown };
}
function allow() { return { decision: "allow" }; }

function assessBash(command, cwd) {
  if (UNPROVABLE.test(command)) return deny("bash", []);
  // redirects
  const targets = [];
  const redir = /(?:^|[\\s\\d])>>?\\s*(\\S+)/g;
  let m;
  while ((m = redir.exec(command))) targets.push(m[1].replace(/^['"]|['"]$/g, ""));
  const words = command.match(/(?:[^\\s"']+|"[^"]*"|'[^']*')+/g) || [];
  for (let i = 0; i < words.length; i++) {
    let w = words[i].replace(/^['"]|['"]$/g, "");
    if (MUTATION.has(basename(w))) {
      for (let j = i + 1; j < words.length; j++) {
        let t = words[j].replace(/^['"]|['"]$/g, "");
        if (t === "--") continue;
        if (t.startsWith("-") && t !== "-") continue;
        if (t === ">" || t === ">>") { j++; continue; }
        targets.push(t);
      }
      break;
    }
  }
  if (targets.length === 0 && !/(?:^|[\\s\\d])>>?/.test(command) && !words.some(w => MUTATION.has(basename(w.replace(/^['"]|['"]$/g, ""))))) {
    return allow();
  }
  if (targets.length === 0) return deny("bash", []);
  const outside = [];
  for (const t of targets) {
    const r = resolveMutation(t, cwd);
    if (!within(r)) outside.push(r);
  }
  return outside.length ? deny("bash", outside) : allow();
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  let event = {};
  try { event = JSON.parse(raw); } catch { /* fail-open on malformed host payload */ }
  const name = event && typeof event === "object" ? (event.toolName || event.tool || "") : "";
  const input = event && typeof event === "object" ? event.toolInput : undefined;
  const cwd = event && typeof event === "object" && typeof event.cwd === "string" ? event.cwd : process.cwd();
  let decision = allow();
  const tool = String(name);
  if (/^(Bash|bash|run_terminal_command)$/i.test(tool)) {
    const command = input && typeof input === "object" && typeof input.command === "string" ? input.command
      : input && typeof input === "object" && typeof input.cmd === "string" ? input.cmd : undefined;
    if (typeof command === "string") decision = assessBash(command, cwd);
  } else if (/^(Write|write|Edit|edit)$/i.test(tool)) {
    const path = input && typeof input === "object" && typeof input.path === "string" ? input.path
      : input && typeof input === "object" && typeof input.file_path === "string" ? input.file_path : undefined;
    if (typeof path === "string" && path.length > 0) {
      const r = resolveMutation(path, cwd);
      decision = within(r) ? allow() : deny(tool.toLowerCase(), [r]);
    }
  }
  process.stdout.write(JSON.stringify(decision));
});
`;
}

/**
 * Install #692 FS boundary PreToolUse hook into controlled GROK_HOME.
 * Installed for every role when the host supports pre_tool_use deny.
 */
export async function installGrokFsBoundaryHook(input: {
  readonly controlledHome: string;
  readonly workspaceRoot: string;
  readonly tempRoot?: string;
}): Promise<void> {
  const hooksDir = join(input.controlledHome, "hooks");
  await mkdir(hooksDir, { recursive: true });
  const scriptName = "ak-fs-boundary.mjs";
  const scriptPath = join(hooksDir, scriptName);
  await writeFile(
    scriptPath,
    renderGrokFsBoundaryHookScript({
      workspaceRoot: input.workspaceRoot,
      tempRoot: input.tempRoot ?? tmpdir(),
    }),
    { mode: 0o755 },
  );
  await writeFile(
    join(hooksDir, "ak-fs-boundary.json"),
    `${JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash|run_terminal_command|Write|Edit|write|edit",
            hooks: [
              {
                type: "command",
                command: `${process.execPath} ${JSON.stringify(scriptPath)}`,
                timeout: 5,
              },
            ],
          },
        ],
      },
    }, null, 2)}\n`,
  );
}

export function fsBoundaryDenyReasonForTest(toolName: string, paths: string[]): string {
  return roleToolFsBoundaryDenyReason(toolName, paths);
}
