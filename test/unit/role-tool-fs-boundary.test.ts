/**
 * #692 FS boundary unit seam. Isolation W/T/P only under mkdtemp; no directory deletes.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { wrapDetourArgvWithWriteSandbox } from "../../src/engine-detour.ts";
import {
  assessDetourArgvFsBoundary,
  assessRoleToolFsBoundary,
  isWithinRoleToolFsBoundary,
  resolveMutationPath,
  ROLE_TOOL_FS_BOUNDARY_CODE,
} from "../../src/role-tool-fs-boundary.ts";

function isolationRoots() {
  const base = mkdtempSync(join(tmpdir(), "ak-692-unit-"));
  const workspaceRoot = join(base, "W");
  const tempRoot = join(base, "T");
  const protectedRoot = join(base, "P");
  mkdirSync(workspaceRoot);
  mkdirSync(tempRoot);
  mkdirSync(protectedRoot);
  mkdirSync(join(protectedRoot, "sub"));
  writeFileSync(join(protectedRoot, "keep.txt"), "PROTECTED", "utf8");
  writeFileSync(join(protectedRoot, "sub", "keep.txt"), "PROTECTED_SUB", "utf8");
  return { workspaceRoot, tempRoot, protectedRoot };
}

function denyCode(
  toolName: "bash" | "edit" | "write",
  toolInput: Record<string, unknown>,
  cwd: string,
  roots: { workspaceRoot: string; tempRoot: string },
): string | undefined {
  return assessRoleToolFsBoundary({ toolName, toolInput, cwd, roots })?.code;
}

test("isWithinRoleToolFsBoundary admits W and T only", () => {
  const { workspaceRoot, tempRoot, protectedRoot } = isolationRoots();
  const roots = { workspaceRoot, tempRoot };
  assert.equal(isWithinRoleToolFsBoundary(join(workspaceRoot, "a"), roots), true);
  assert.equal(isWithinRoleToolFsBoundary(join(tempRoot, "b"), roots), true);
  assert.equal(isWithinRoleToolFsBoundary(join(protectedRoot, "keep.txt"), roots), false);
});

test("symlink component walk: absolute and relative link/../keep land in P", () => {
  const { workspaceRoot, tempRoot, protectedRoot } = isolationRoots();
  const roots = { workspaceRoot, tempRoot };
  const link = join(workspaceRoot, "link");
  symlinkSync(join(protectedRoot, "sub"), link);
  for (const escaped of [`${link}/../keep.txt`, "link/../keep.txt"] as const) {
    assert.equal(isWithinRoleToolFsBoundary(resolveMutationPath(escaped, workspaceRoot), roots), false);
    assert.equal(
      denyCode("write", { path: escaped, content: "HIJACK" }, workspaceRoot, roots),
      ROLE_TOOL_FS_BOUNDARY_CODE,
    );
  }
});

test("edit/write/rm/mv outside deny; strict read-only bash allows", () => {
  const { workspaceRoot, tempRoot, protectedRoot } = isolationRoots();
  const roots = { workspaceRoot, tempRoot };
  const pFile = join(protectedRoot, "keep.txt");

  assert.equal(denyCode("edit", { path: pFile, edits: [] }, workspaceRoot, roots), ROLE_TOOL_FS_BOUNDARY_CODE);
  assert.equal(denyCode("write", { path: pFile, content: "x" }, workspaceRoot, roots), ROLE_TOOL_FS_BOUNDARY_CODE);
  assert.equal(
    denyCode("bash", { command: `rm -rf ${JSON.stringify(pFile)}` }, workspaceRoot, roots),
    ROLE_TOOL_FS_BOUNDARY_CODE,
  );
  assert.equal(
    denyCode(
      "bash",
      { command: `mv ${JSON.stringify(pFile)} ${JSON.stringify(join(workspaceRoot, "x"))}` },
      workspaceRoot,
      roots,
    ),
    ROLE_TOOL_FS_BOUNDARY_CODE,
  );
  assert.equal(denyCode("bash", { command: `cat ${JSON.stringify(pFile)}` }, workspaceRoot, roots), undefined);
  assert.equal(
    denyCode("write", { path: join(workspaceRoot, "ok"), content: "x" }, workspaceRoot, roots),
    undefined,
  );
});

test("bash fail-closed: substitution, background, wrappers, carriers, interpreters", () => {
  const { workspaceRoot, tempRoot, protectedRoot } = isolationRoots();
  const roots = { workspaceRoot, tempRoot };
  const pFile = join(protectedRoot, "keep.txt");
  const wScript = join(workspaceRoot, "script.py");
  writeFileSync(wScript, "open('x','w').write('y')\n", "utf8");

  for (const command of [
    `cat "$(rm -f ${JSON.stringify(pFile)})"`,
    `cat ${JSON.stringify(pFile)} & rm -f ${JSON.stringify(pFile)}`,
    `command rm -f ${JSON.stringify(pFile)}`,
    `env python3 -c 'open(${JSON.stringify(pFile)},"w").write("ENV")'`,
    `python3 ${JSON.stringify(wScript)}`,
    `git config --file ${JSON.stringify(pFile)} x.y z`,
    `printf ${JSON.stringify(pFile)} | xargs rm -f`,
    `rm -f {${JSON.stringify(pFile)},${JSON.stringify(pFile)}}`,
    `sed -i '' 's/A/B/' ${JSON.stringify(pFile)}`,
    `P=${JSON.stringify(protectedRoot)}; printf X > "$P/keep.txt"`,
    `rm -f ${workspaceRoot}/*/keep.txt`,
    `bash -c 'rm -f ${pFile}'`,
    `node -e "require('fs').unlinkSync(${JSON.stringify(pFile)})"`,
  ] as const) {
    assert.equal(
      denyCode("bash", { command }, workspaceRoot, roots),
      ROLE_TOOL_FS_BOUNDARY_CODE,
      `must deny: ${command}`,
    );
  }
});

test("detour argv: mutation deny; opaque engine platform-aware", () => {
  const { workspaceRoot, tempRoot, protectedRoot } = isolationRoots();
  const roots = { workspaceRoot, tempRoot };
  const pFile = join(protectedRoot, "keep.txt");

  assert.equal(
    assessDetourArgvFsBoundary({ argv: ["rm", "-rf", pFile], cwd: workspaceRoot, roots })?.code,
    ROLE_TOOL_FS_BOUNDARY_CODE,
  );
  assert.equal(
    assessDetourArgvFsBoundary({
      argv: ["bash", "-c", `rm -rf ${JSON.stringify(pFile)}`],
      cwd: workspaceRoot,
      roots,
    })?.code,
    ROLE_TOOL_FS_BOUNDARY_CODE,
  );
  const opaque = assessDetourArgvFsBoundary({
    argv: ["/usr/bin/true"],
    cwd: workspaceRoot,
    roots,
  });
  if (process.platform === "darwin") assert.equal(opaque, undefined);
  else assert.equal(opaque?.code, ROLE_TOOL_FS_BOUNDARY_CODE);
});

test("Darwin detour write sandbox blocks P and allows W (real IO)", async () => {
  if (process.platform !== "darwin") return;
  const { workspaceRoot, tempRoot, protectedRoot } = isolationRoots();
  const pFile = join(protectedRoot, "keep.txt");
  const wFile = join(workspaceRoot, "ok.txt");
  const wrapped = wrapDetourArgvWithWriteSandbox(
    ["bash", "-c", `echo HIJACK > ${JSON.stringify(pFile)}; echo OK > ${JSON.stringify(wFile)}; exit 0`],
    workspaceRoot,
    { workspaceRoot, tempRoot },
  );
  assert.equal(wrapped[0], "/usr/bin/sandbox-exec");
  const { spawnSync } = await import("node:child_process");
  spawnSync(wrapped[0]!, wrapped.slice(1), {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: { ...process.env, TMPDIR: tempRoot },
  });
  assert.equal(readFileSync(pFile, "utf8"), "PROTECTED");
  assert.equal(readFileSync(wFile, "utf8").trim(), "OK");
});

test("Grok FS boundary hook runner imports shared assessor and returns typed code", async () => {
  const { workspaceRoot, tempRoot, protectedRoot } = isolationRoots();
  const home = mkdtempSync(join(tmpdir(), "ak-692-grok-hook-"));
  const { installGrokFsBoundaryHook } = await import("../../src/grok/fs-boundary-hook.ts");
  await installGrokFsBoundaryHook({ controlledHome: home, workspaceRoot, tempRoot });
  const hookJson = JSON.parse(readFileSync(join(home, "hooks", "ak-fs-boundary.json"), "utf8"));
  const command: string = hookJson.hooks.PreToolUse[0].hooks[0].command;
  const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g)!.map((p) => p.replace(/^"|"$/g, ""));
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(parts[0]!, parts.slice(1), {
    input: JSON.stringify({
      toolName: "Write",
      toolInput: { path: join(protectedRoot, "keep.txt"), content: "X" },
      cwd: workspaceRoot,
    }),
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, "deny");
  assert.equal(decision.code, ROLE_TOOL_FS_BOUNDARY_CODE);
});
