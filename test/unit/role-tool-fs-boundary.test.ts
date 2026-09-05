/**
 * #692 FS boundary unit seam. Isolation W/T/P only under mkdtemp; no directory deletes.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assessDetourArgvFsBoundary,
  assessRoleToolFsBoundary,
  isWithinRoleToolFsBoundary,
  resolveMutationPath,
  ROLE_TOOL_FS_BOUNDARY_CODE,
} from "../../src/role-tool-fs-boundary.ts";
import { wrapDetourArgvWithWriteSandbox } from "../../src/engine-detour.ts";

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
  // Absolute and relative forms — path.join would collapse `..` before follow.
  for (const escaped of [`${link}/../keep.txt`, "link/../keep.txt"] as const) {
    const resolved = resolveMutationPath(escaped, workspaceRoot);
    assert.equal(
      isWithinRoleToolFsBoundary(resolved, roots),
      false,
      `resolved=${resolved} for ${escaped}`,
    );
    assert.ok(
      assessRoleToolFsBoundary({
        toolName: "write",
        toolInput: { path: escaped, content: "HIJACK" },
        cwd: workspaceRoot,
        roots,
      }),
      `write via ${escaped} must deny`,
    );
  }
});

test("edit/write/rm/mv outside deny; read-only bash allows", () => {
  const { workspaceRoot, tempRoot, protectedRoot } = isolationRoots();
  const roots = { workspaceRoot, tempRoot };
  const pFile = join(protectedRoot, "keep.txt");

  assert.ok(assessRoleToolFsBoundary({
    toolName: "edit",
    toolInput: { path: pFile, edits: [{ oldText: "a", newText: "b" }] },
    cwd: workspaceRoot,
    roots,
  }));
  assert.ok(assessRoleToolFsBoundary({
    toolName: "write",
    toolInput: { path: pFile, content: "x" },
    cwd: workspaceRoot,
    roots,
  }));
  assert.ok(assessRoleToolFsBoundary({
    toolName: "bash",
    toolInput: { command: `rm -rf ${JSON.stringify(pFile)}` },
    cwd: workspaceRoot,
    roots,
  }));
  assert.ok(assessRoleToolFsBoundary({
    toolName: "bash",
    toolInput: { command: `mv ${JSON.stringify(pFile)} ${JSON.stringify(join(workspaceRoot, "x"))}` },
    cwd: workspaceRoot,
    roots,
  }));
  assert.equal(assessRoleToolFsBoundary({
    toolName: "bash",
    toolInput: { command: `cat ${JSON.stringify(pFile)}` },
    cwd: workspaceRoot,
    roots,
  }), undefined);
  assert.equal(assessRoleToolFsBoundary({
    toolName: "write",
    toolInput: { path: join(workspaceRoot, "ok"), content: "x" },
    cwd: workspaceRoot,
    roots,
  }), undefined);
});

test("bash fail-closed: wrappers, carriers, brace, sed -i, vars, globs", () => {
  const { workspaceRoot, tempRoot, protectedRoot } = isolationRoots();
  const roots = { workspaceRoot, tempRoot };
  const pFile = join(protectedRoot, "keep.txt");
  const link = join(workspaceRoot, "link");
  symlinkSync(join(protectedRoot, "sub"), link);

  for (const command of [
    `bash -c 'rm -f ${pFile}'`,
    `bash -lc 'rm -f ${pFile}'`,
    `command rm -f ${JSON.stringify(pFile)}`,
    `env python3 -c 'open(${JSON.stringify(pFile)},"w").write("ENV")'`,
    `git config --file ${JSON.stringify(pFile)} x.y z`,
    `printf ${JSON.stringify(pFile)} | xargs rm -f`,
    `rm -f {${JSON.stringify(pFile)},${JSON.stringify(pFile)}}`,
    `printf X>${pFile}`,
    `sed -i '' 's/ORIGINAL/HIJACK/' ${JSON.stringify(pFile)}`,
    `P=${JSON.stringify(protectedRoot)}; printf HIJACK > "$P/keep.txt"`,
    `rm -f ${workspaceRoot}/*/keep.txt`,
    `printf X > ${link}/../keep.txt`,
    `node -e "require('fs').unlinkSync(${JSON.stringify(pFile)})"`,
    `find ${JSON.stringify(protectedRoot)} -delete`,
  ] as const) {
    const hit = assessRoleToolFsBoundary({
      toolName: "bash",
      toolInput: { command },
      cwd: workspaceRoot,
      roots,
    });
    assert.ok(hit, `must deny: ${command}`);
    assert.equal(hit.code, ROLE_TOOL_FS_BOUNDARY_CODE, `typed code for: ${command}`);
  }

  // Read unrestricted (including outside).
  assert.equal(
    assessRoleToolFsBoundary({
      toolName: "bash",
      toolInput: { command: `cat ${JSON.stringify(pFile)}` },
      cwd: workspaceRoot,
      roots,
    }),
    undefined,
  );
});

test("detour argv: rm/bash -c outside deny; opaque engine platform-aware", () => {
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
  assert.equal(
    assessDetourArgvFsBoundary({
      argv: ["python3", "-c", `open(${JSON.stringify(pFile)},'w').write('x')`],
      cwd: workspaceRoot,
      roots,
    })?.code,
    ROLE_TOOL_FS_BOUNDARY_CODE,
  );
  // Opaque engine: Darwin allows (sandbox-exec confines writes); non-Darwin fail-closed.
  const opaque = assessDetourArgvFsBoundary({
    argv: ["/usr/bin/true"],
    cwd: workspaceRoot,
    roots,
  });
  if (process.platform === "darwin") {
    assert.equal(opaque, undefined);
  } else {
    assert.equal(opaque?.code, ROLE_TOOL_FS_BOUNDARY_CODE);
  }
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
  assert.equal(readFileSync(pFile, "utf8"), "PROTECTED", "P must stay intact under sandbox");
  assert.equal(readFileSync(wFile, "utf8").trim(), "OK", "W write allowed under sandbox");
});

test("Grok FS boundary hook runner imports shared assessor and denies outside write", async () => {
  const { workspaceRoot, tempRoot, protectedRoot } = isolationRoots();
  const home = mkdtempSync(join(tmpdir(), "ak-692-grok-hook-"));
  const { installGrokFsBoundaryHook } = await import("../../src/grok/fs-boundary-hook.ts");
  await installGrokFsBoundaryHook({
    controlledHome: home,
    workspaceRoot,
    tempRoot,
  });
  const script = join(home, "hooks", "ak-fs-boundary.mjs");
  const hookJson = JSON.parse(readFileSync(join(home, "hooks", "ak-fs-boundary.json"), "utf8"));
  const command: string = hookJson.hooks.PreToolUse[0].hooks[0].command;
  assert.match(command, /tsx/);
  const { spawnSync } = await import("node:child_process");
  // Parse command into argv (simple split on spaces outside quotes — installer uses JSON.stringify paths)
  const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g)!.map((p) => p.replace(/^"|"$/g, ""));
  const event = JSON.stringify({
    toolName: "Write",
    toolInput: { path: join(protectedRoot, "keep.txt"), content: "X" },
    cwd: workspaceRoot,
  });
  const result = spawnSync(parts[0]!, parts.slice(1), {
    input: event,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, "deny");
  assert.equal(decision.code, ROLE_TOOL_FS_BOUNDARY_CODE);
  assert.equal(decision.details?.code, ROLE_TOOL_FS_BOUNDARY_CODE);
  // Malformed payload fail-closed
  const bad = spawnSync(parts[0]!, parts.slice(1), {
    input: "not-json",
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(bad.status, 0, bad.stderr);
  assert.equal(JSON.parse(bad.stdout).decision, "deny");
  void script;
});
