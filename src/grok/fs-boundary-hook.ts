/**
 * Grok PreToolUse hook for #692 FS boundary (all roles).
 * One authority: thin runner imports assessRoleToolFsBoundary from the package
 * module (no duplicated path logic). Launched with node --import tsx.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { physicalPathIdentity } from "../activation-ledger-topology.ts";
import { ROLE_TOOL_FS_BOUNDARY_CODE } from "../role-tool-fs-boundary.ts";

export const AK_FS_BOUNDARY_HOOK_FILES = [
  "ak-fs-boundary.json",
  "ak-fs-boundary.mjs",
] as const;

const BOUNDARY_MODULE = fileURLToPath(
  new URL("../role-tool-fs-boundary.ts", import.meta.url),
);

/**
 * Thin ESM runner: stdin event → shared assessRoleToolFsBoundary → decision JSON.
 * Must be launched with `node --import <tsx>` so the .ts authority module loads.
 */
export function renderGrokFsBoundaryHookScript(input: {
  readonly workspaceRoot: string;
  readonly tempRoot: string;
  readonly boundaryModuleUrl: string;
}): string {
  const workspace = physicalPathIdentity(input.workspaceRoot);
  const temp = physicalPathIdentity(input.tempRoot);
  return `#!/usr/bin/env node
import { assessRoleToolFsBoundary } from ${JSON.stringify(input.boundaryModuleUrl)};

const ROOTS = Object.freeze({
  workspaceRoot: ${JSON.stringify(workspace)},
  tempRoot: ${JSON.stringify(temp)},
});
const CODE = ${JSON.stringify(ROLE_TOOL_FS_BOUNDARY_CODE)};

function deny(reason) {
  return { decision: "deny", reason };
}
function allow() {
  return { decision: "allow" };
}

function toolNameOf(event) {
  const raw = event?.toolName ?? event?.tool ?? "";
  const name = String(raw);
  if (/^(Bash|bash|run_terminal_command)$/i.test(name)) return "bash";
  if (/^(Write|write)$/i.test(name)) return "write";
  if (/^(Edit|edit)$/i.test(name)) return "edit";
  return name;
}

function toolInputOf(event, toolName) {
  const input = event?.toolInput;
  if (input === null || typeof input !== "object") return {};
  if (toolName === "bash") {
    const command = typeof input.command === "string" ? input.command
      : typeof input.cmd === "string" ? input.cmd : undefined;
    return command === undefined ? {} : { command };
  }
  const path = typeof input.path === "string" ? input.path
    : typeof input.file_path === "string" ? input.file_path : undefined;
  return path === undefined ? {} : { path };
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify(deny(
      "角色工具文件系统边界：malformed PreToolUse payload（" + CODE + "）",
    )));
    return;
  }
  if (event === null || typeof event !== "object") {
    process.stdout.write(JSON.stringify(deny(
      "角色工具文件系统边界：invalid PreToolUse event（" + CODE + "）",
    )));
    return;
  }
  const toolName = toolNameOf(event);
  if (toolName !== "bash" && toolName !== "edit" && toolName !== "write") {
    process.stdout.write(JSON.stringify(allow()));
    return;
  }
  const cwd = typeof event.cwd === "string" && event.cwd.length > 0
    ? event.cwd
    : process.cwd();
  const violation = assessRoleToolFsBoundary({
    toolName,
    toolInput: toolInputOf(event, toolName),
    cwd,
    roots: ROOTS,
  });
  process.stdout.write(JSON.stringify(
    violation === undefined ? allow() : deny(violation.reason),
  ));
});
`;
}

function resolveTsxLoader(): string | undefined {
  try {
    return createRequire(import.meta.url).resolve("tsx/esm");
  } catch {
    return undefined;
  }
}

/**
 * Install #692 FS boundary PreToolUse hook into controlled GROK_HOME.
 * Runner imports the package boundary module (single authority).
 */
export async function installGrokFsBoundaryHook(input: {
  readonly controlledHome: string;
  readonly workspaceRoot: string;
  readonly tempRoot?: string;
  readonly boundaryModulePath?: string;
}): Promise<void> {
  const hooksDir = join(input.controlledHome, "hooks");
  await mkdir(hooksDir, { recursive: true });
  const scriptPath = join(hooksDir, "ak-fs-boundary.mjs");
  const boundaryPath = input.boundaryModulePath ?? BOUNDARY_MODULE;
  await writeFile(
    scriptPath,
    renderGrokFsBoundaryHookScript({
      workspaceRoot: input.workspaceRoot,
      tempRoot: input.tempRoot ?? tmpdir(),
      boundaryModuleUrl: pathToFileURL(boundaryPath).href,
    }),
    { mode: 0o755 },
  );
  const tsxLoader = resolveTsxLoader();
  const command = tsxLoader === undefined
    ? `${process.execPath} --import tsx ${JSON.stringify(scriptPath)}`
    : `${process.execPath} --import ${JSON.stringify(tsxLoader)} ${JSON.stringify(scriptPath)}`;
  await writeFile(
    join(hooksDir, "ak-fs-boundary.json"),
    `${JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash|run_terminal_command|Write|Edit|write|edit",
            hooks: [{ type: "command", command, timeout: 10 }],
          },
        ],
      },
    }, null, 2)}\n`,
  );
}
