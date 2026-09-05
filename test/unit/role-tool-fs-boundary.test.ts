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

test("symlink component walk: W/link/../keep resolves into P (not lexical W)", () => {
  const { workspaceRoot, tempRoot, protectedRoot } = isolationRoots();
  const roots = { workspaceRoot, tempRoot };
  const link = join(workspaceRoot, "link");
  symlinkSync(join(protectedRoot, "sub"), link);
  // Literal string — path.join would collapse `..` before follow.
  const escaped = `${link}/../keep.txt`;
  const resolved = resolveMutationPath(escaped, workspaceRoot);
  assert.ok(
    resolved.includes("keep.txt"),
    `resolved=${resolved}`,
  );
  // Must land under P, not under W.
  assert.equal(isWithinRoleToolFsBoundary(resolved, roots), false);

  const write = assessRoleToolFsBoundary({
    toolName: "write",
    toolInput: { path: escaped, content: "HIJACK" },
    cwd: workspaceRoot,
    roots,
  });
  assert.ok(write, "write via symlink-.. escape must deny");
  assert.equal(write.code, ROLE_TOOL_FS_BOUNDARY_CODE);
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

test("bash fail-closed: nested shell, cd, node -e, find -delete", () => {
  const { workspaceRoot, tempRoot, protectedRoot } = isolationRoots();
  const roots = { workspaceRoot, tempRoot };
  const pFile = join(protectedRoot, "keep.txt");

  assert.ok(assessRoleToolFsBoundary({
    toolName: "bash",
    toolInput: { command: `bash -c 'rm -f ${pFile}'` },
    cwd: workspaceRoot,
    roots,
  }), "nested bash -c rm outside");

  assert.ok(assessRoleToolFsBoundary({
    toolName: "bash",
    toolInput: { command: `cd ${JSON.stringify(protectedRoot)} && rm -f keep.txt` },
    cwd: workspaceRoot,
    roots,
  }), "cd + relative rm fail-closed");

  assert.ok(assessRoleToolFsBoundary({
    toolName: "bash",
    toolInput: { command: `node -e "require('fs').unlinkSync(${JSON.stringify(pFile)})"` },
    cwd: workspaceRoot,
    roots,
  }), "node -e fail-closed");

  assert.ok(assessRoleToolFsBoundary({
    toolName: "bash",
    toolInput: { command: `find ${JSON.stringify(protectedRoot)} -delete` },
    cwd: workspaceRoot,
    roots,
  }), "find -delete fail-closed");
});

test("detour argv: rm/bash -c outside deny; opaque engine argv alone allows (sandbox owns IO)", () => {
  const { workspaceRoot, tempRoot, protectedRoot } = isolationRoots();
  const roots = { workspaceRoot, tempRoot };
  const pFile = join(protectedRoot, "keep.txt");

  assert.ok(assessDetourArgvFsBoundary({
    argv: ["rm", "-rf", pFile],
    cwd: workspaceRoot,
    roots,
  }));
  assert.ok(assessDetourArgvFsBoundary({
    argv: ["bash", "-c", `rm -rf ${JSON.stringify(pFile)}`],
    cwd: workspaceRoot,
    roots,
  }));
  assert.ok(assessDetourArgvFsBoundary({
    argv: ["python3", "-c", `open(${JSON.stringify(pFile)},'w').write('x')`],
    cwd: workspaceRoot,
    roots,
  }));
  assert.equal(assessDetourArgvFsBoundary({
    argv: ["/usr/bin/true"],
    cwd: workspaceRoot,
    roots,
  }), undefined);
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
