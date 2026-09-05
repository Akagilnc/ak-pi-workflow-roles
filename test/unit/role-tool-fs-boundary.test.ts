/**
 * #692 role tool FS boundary — pure assessment seam (no host session).
 * Isolation roots W/T; protected P outside both; never touches real home.
 * Temp artifacts only under mkdtemp; tests do not delete directories.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assessDetourArgvFsBoundary,
  assessRoleToolFsBoundary,
  extractBashMutationTargetPaths,
  isWithinRoleToolFsBoundary,
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
  writeFileSync(join(protectedRoot, "keep.txt"), "PROTECTED_BYTES", "utf8");
  return { base, workspaceRoot, tempRoot, protectedRoot };
}

test("isWithinRoleToolFsBoundary admits W and T only", () => {
  const { workspaceRoot, tempRoot, protectedRoot } = isolationRoots();
  const roots = { workspaceRoot, tempRoot };
  assert.equal(isWithinRoleToolFsBoundary(join(workspaceRoot, "a"), roots), true);
  assert.equal(isWithinRoleToolFsBoundary(join(tempRoot, "b"), roots), true);
  assert.equal(isWithinRoleToolFsBoundary(join(protectedRoot, "keep.txt"), roots), false);
  assert.equal(isWithinRoleToolFsBoundary(protectedRoot, roots), false);
});

test("edit/write outside P are violations; inside W/T are not", () => {
  const { workspaceRoot, tempRoot, protectedRoot } = isolationRoots();
  const roots = { workspaceRoot, tempRoot };
  const outside = assessRoleToolFsBoundary({
    toolName: "write",
    toolInput: { path: join(protectedRoot, "keep.txt"), content: "x" },
    cwd: workspaceRoot,
    roots,
  });
  assert.ok(outside);
  assert.equal(outside.code, ROLE_TOOL_FS_BOUNDARY_CODE);
  assert.equal(outside.toolName, "write");
  assert.ok(outside.paths.some((p) => p.includes("keep.txt")));

  assert.equal(
    assessRoleToolFsBoundary({
      toolName: "edit",
      toolInput: { path: join(workspaceRoot, "ok.ts"), edits: [] },
      cwd: workspaceRoot,
      roots,
    }),
    undefined,
  );
  assert.equal(
    assessRoleToolFsBoundary({
      toolName: "write",
      toolInput: { path: join(tempRoot, "scratch"), content: "t" },
      cwd: workspaceRoot,
      roots,
    }),
    undefined,
  );
});

test("bash rm/mv/redirect outside P violate; read-only bash does not", () => {
  const { workspaceRoot, tempRoot, protectedRoot } = isolationRoots();
  const roots = { workspaceRoot, tempRoot };
  const pFile = join(protectedRoot, "keep.txt");
  const wFile = join(workspaceRoot, "in-w.txt");

  const rm = assessRoleToolFsBoundary({
    toolName: "bash",
    toolInput: { command: `rm -rf ${JSON.stringify(pFile)}` },
    cwd: workspaceRoot,
    roots,
  });
  assert.ok(rm, "rm outside must violate");

  const mvOut = assessRoleToolFsBoundary({
    toolName: "bash",
    toolInput: { command: `mv ${JSON.stringify(wFile)} ${JSON.stringify(pFile)}` },
    cwd: workspaceRoot,
    roots,
  });
  assert.ok(mvOut, "mv W→P must violate");

  const mvIn = assessRoleToolFsBoundary({
    toolName: "bash",
    toolInput: { command: `mv ${JSON.stringify(pFile)} ${JSON.stringify(wFile)}` },
    cwd: workspaceRoot,
    roots,
  });
  assert.ok(mvIn, "mv P→W must violate (source outside)");

  const redirect = assessRoleToolFsBoundary({
    toolName: "bash",
    toolInput: { command: `printf x > ${JSON.stringify(pFile)}` },
    cwd: workspaceRoot,
    roots,
  });
  assert.ok(redirect, "redirect outside must violate");

  assert.equal(
    assessRoleToolFsBoundary({
      toolName: "bash",
      toolInput: { command: `cat ${JSON.stringify(pFile)}` },
      cwd: workspaceRoot,
      roots,
    }),
    undefined,
    "read-only bash outside remains unrestricted",
  );

  assert.equal(
    assessRoleToolFsBoundary({
      toolName: "bash",
      toolInput: { command: `rm -rf ${JSON.stringify(join(workspaceRoot, "gone"))}` },
      cwd: workspaceRoot,
      roots,
    }),
    undefined,
  );
});

test("symlink in W pointing at P: write/rm targets resolve outside", () => {
  const { workspaceRoot, tempRoot, protectedRoot } = isolationRoots();
  const roots = { workspaceRoot, tempRoot };
  const pFile = join(protectedRoot, "keep.txt");
  const link = join(workspaceRoot, "link-to-p");
  symlinkSync(pFile, link);

  const writeVia = assessRoleToolFsBoundary({
    toolName: "write",
    toolInput: { path: link, content: "overwrite" },
    cwd: workspaceRoot,
    roots,
  });
  assert.ok(writeVia, "write via symlink to P must violate");

  const bashVia = assessRoleToolFsBoundary({
    toolName: "bash",
    toolInput: { command: `printf hijacked > ${JSON.stringify(link)}` },
    cwd: workspaceRoot,
    roots,
  });
  assert.ok(bashVia, "redirect via symlink to P must violate");
});

test("extractBashMutationTargetPaths covers rm/mv operands and redirects", () => {
  assert.deepEqual(
    extractBashMutationTargetPaths("rm -rf /tmp/x"),
    ["/tmp/x"],
  );
  assert.deepEqual(
    extractBashMutationTargetPaths("mv a b"),
    ["a", "b"],
  );
  assert.ok(extractBashMutationTargetPaths("echo hi > /tmp/out").includes("/tmp/out"));
  assert.deepEqual(extractBashMutationTargetPaths("cat /etc/passwd"), []);
  assert.ok(extractBashMutationTargetPaths("rm a && mv b c").includes("a"));
});

test("detour argv mutation outside P violates; engine binary outside does not", () => {
  const { workspaceRoot, tempRoot, protectedRoot } = isolationRoots();
  const roots = { workspaceRoot, tempRoot };
  const pFile = join(protectedRoot, "keep.txt");

  const rm = assessDetourArgvFsBoundary({
    argv: ["rm", "-rf", pFile],
    cwd: workspaceRoot,
    roots,
  });
  assert.ok(rm);

  const embeddedRm = assessDetourArgvFsBoundary({
    argv: ["bash", "-c", `rm -rf ${JSON.stringify(pFile)}`],
    cwd: workspaceRoot,
    roots,
  });
  assert.ok(embeddedRm, "bash -c rm outside must violate");

  assert.equal(
    assessDetourArgvFsBoundary({
      argv: ["/usr/bin/true"],
      cwd: workspaceRoot,
      roots,
    }),
    undefined,
  );
});
