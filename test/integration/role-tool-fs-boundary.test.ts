/**
 * #692 FS boundary — production extension entry (withInProcessPi + role-runtime).
 * Isolation W/T/P under tmp only; this file never deletes directories.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";

import {
  AK_ROLE_ENGINE_ENV,
  ENGINE_DETOUR_TOOL_NAME,
} from "../../src/engine-detour.ts";
import { INSPECTOR_OUTPUT_TOOL_NAME } from "../../src/inspector-contracts.ts";
import { ROLE_TOOL_FS_BOUNDARY_CODE } from "../../src/role-tool-fs-boundary.ts";
import {
  packageRoot,
  seedGitRepository,
  withActivationHome,
  withInProcessPi,
} from "../helpers/pi-test-harness.ts";

const EXTENSION = join(packageRoot, "extensions", "role-runtime.ts");
const MARKER = "PROTECTED_BYTES_692";

function textOf(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && "text" in part
        ? String((part as { text: unknown }).text)
        : "",
    )
    .join("");
}

function toolResult(
  entries: readonly { type?: string; message?: any }[],
  id: string,
): any | undefined {
  return entries.find(
    (e) =>
      e.type === "message" &&
      e.message?.role === "toolResult" &&
      e.message?.toolCallId === id,
  )?.message;
}

function seedWork(work: string): void {
  mkdirSync(work, { recursive: true });
  seedGitRepository(work);
  execFileSync("git", ["config", "user.email", "fs-bound@test.local"], { cwd: work, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "FS Bound"], { cwd: work, stdio: "ignore" });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: work, stdio: "ignore" });
}

async function withFixture<T>(
  run: (f: {
    home: string;
    agentDir: string;
    workspace: string;
    tempRoot: string;
    protectedFile: string;
    protectedRoot: string;
  }) => Promise<T>,
): Promise<T> {
  return withActivationHome({ prefix: "ak-692-fs-" }, async ({ home, agentDir }) => {
    const workspace = join(home, "W");
    const tempRoot = join(home, "T");
    mkdirSync(tempRoot, { recursive: true });
    seedWork(workspace);
    const protectedRoot = mkdtempSync(join(tmpdir(), "ak-692-P-"));
    const protectedFile = join(protectedRoot, "keep.txt");
    writeFileSync(protectedFile, MARKER, "utf8");
    const prevTmp = process.env.TMPDIR;
    const prevTmp2 = process.env.TMP;
    process.env.TMPDIR = tempRoot;
    process.env.TMP = tempRoot;
    try {
      return await run({ home, agentDir, workspace, tempRoot, protectedFile, protectedRoot });
    } finally {
      if (prevTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmp;
      if (prevTmp2 === undefined) delete process.env.TMP;
      else process.env.TMP = prevTmp2;
    }
  });
}

function assertBlocked(result: any, id: string): void {
  assert.ok(result, `${id} missing toolResult`);
  assert.equal(result.isError, true, `${id} must be typed error`);
  assert.match(textOf(result), new RegExp(ROLE_TOOL_FS_BOUNDARY_CODE), `${id} code`);
}

test("#692 matrix: rm/edit/write/mv/symlink deny; read+W/T allow; run continues", { timeout: 60_000 }, async () => {
  await withFixture(async ({ home, agentDir, workspace, tempRoot, protectedFile, protectedRoot }) => {
    const link = join(workspace, "link-to-p");
    symlinkSync(protectedFile, link);
    const linkDir = join(workspace, "link-dir");
    mkdirSync(join(protectedRoot, "sub"), { recursive: true });
    writeFileSync(join(protectedRoot, "sub", "keep.txt"), MARKER, "utf8");
    symlinkSync(join(protectedRoot, "sub"), linkDir);
    // Literal — path.join collapses `..` before symlink follow.
    const escapePath = `${linkDir}/../keep.txt`;
    const wFile = join(workspace, "in-w.txt");
    writeFileSync(wFile, "w", "utf8");

    const faux = fauxProvider({
      api: "ak-692-matrix",
      provider: "ak-692-matrix",
      tokenSize: { min: 1000, max: 1000 },
    });

    await withInProcessPi({
      activationLedgerSession: true,
      cwd: workspace,
      home,
      agentDir,
      faux,
      modelsPath: null,
      noExtensions: true,
      systemPrompt: "692",
      mode: "print",
      flags: { "ak-role": "inspector" },
      additionalExtensionPaths: [EXTENSION],
    }, async ({ session, sessionManager }) => {
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("bash", { command: `rm -rf ${JSON.stringify(protectedFile)}` }, { id: "rm" }),
          fauxToolCall("edit", { path: protectedFile, edits: [{ oldText: MARKER, newText: "X" }] }, { id: "edit" }),
          fauxToolCall("write", { path: protectedFile, content: "X" }, { id: "write" }),
          fauxToolCall("bash", { command: `mv ${JSON.stringify(wFile)} ${JSON.stringify(protectedFile)}` }, { id: "mv-out" }),
          fauxToolCall("bash", { command: `mv ${JSON.stringify(protectedFile)} ${JSON.stringify(join(workspace, "stolen"))}` }, { id: "mv-in" }),
          fauxToolCall("bash", { command: `printf X > ${JSON.stringify(link)}` }, { id: "symlink-write" }),
          fauxToolCall("bash", { command: `rm -f ${JSON.stringify(link)}` }, { id: "symlink-rm-via-link" }),
          fauxToolCall("write", { path: escapePath, content: "HIJACK" }, { id: "symlink-dotdot" }),
          fauxToolCall("bash", { command: `bash -c 'rm -f ${protectedFile}'` }, { id: "nested-bash" }),
          fauxToolCall("read", { path: protectedFile }, { id: "read" }),
          fauxToolCall("write", { path: join(workspace, "ok-w.txt"), content: "w-ok" }, { id: "w-ok" }),
          fauxToolCall("write", { path: join(tempRoot, "ok-t.txt"), content: "t-ok" }, { id: "t-ok" }),
        ], { stopReason: "toolUse" }),
        fauxAssistantMessage(
          fauxToolCall(INSPECTOR_OUTPUT_TOOL_NAME, { status: "pass", findings: [] }, { id: "out" }),
          { stopReason: "toolUse" },
        ),
      ]);

      await session.prompt("matrix");
      const entries = sessionManager.getEntries();
      for (const id of [
        "rm", "edit", "write", "mv-out", "mv-in",
        "symlink-write", "symlink-rm-via-link", "symlink-dotdot", "nested-bash",
      ]) {
        assertBlocked(toolResult(entries, id), id);
      }
      assert.equal(readFileSync(protectedFile, "utf8"), MARKER);
      assert.equal(toolResult(entries, "read")?.isError, false);
      assert.match(textOf(toolResult(entries, "read")), new RegExp(MARKER));
      assert.equal(toolResult(entries, "w-ok")?.isError, false);
      assert.equal(toolResult(entries, "t-ok")?.isError, false);
      assert.equal(readFileSync(join(workspace, "ok-w.txt"), "utf8"), "w-ok");
      assert.equal(readFileSync(join(tempRoot, "ok-t.txt"), "utf8"), "t-ok");
      assert.equal(toolResult(entries, "out")?.isError, false);

      // Trusted ledger session file coexists.
      const sessionFile = sessionManager.getSessionFile?.();
      assert.ok(typeof sessionFile === "string" && readFileSync(sessionFile, "utf8").length > 0);
    });
  });
});

test("#692 detour outside fails run (ADR 0071); P intact", { timeout: 60_000 }, async () => {
  await withFixture(async ({ home, agentDir, workspace, protectedFile }) => {
    const prevEngine = process.env[AK_ROLE_ENGINE_ENV];
    const prevExit = process.exitCode;
    process.env[AK_ROLE_ENGINE_ENV] = "kimi";
    process.exitCode = undefined;
    const faux = fauxProvider({
      api: "ak-692-detour",
      provider: "ak-692-detour",
      tokenSize: { min: 1000, max: 1000 },
    });
    try {
      await withInProcessPi({
        activationLedgerSession: true,
        cwd: workspace,
        home,
        agentDir,
        faux,
        modelsPath: null,
        noExtensions: true,
        systemPrompt: "692-detour",
        mode: "print",
        flags: { "ak-role": "inspector" },
        additionalExtensionPaths: [EXTENSION],
      }, async ({ session, sessionManager }) => {
        faux.setResponses([
          fauxAssistantMessage(
            fauxToolCall(
              ENGINE_DETOUR_TOOL_NAME,
              { argv: ["bash", "-c", `rm -rf ${JSON.stringify(protectedFile)}`] },
              { id: "detour" },
            ),
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage(
            fauxToolCall(INSPECTOR_OUTPUT_TOOL_NAME, { status: "pass", findings: [] }, { id: "out" }),
            { stopReason: "toolUse" },
          ),
        ]);
        try {
          await session.prompt("detour");
        } catch {
          // optional
        }
        const detour = toolResult(sessionManager.getEntries(), "detour");
        assert.ok(detour?.isError);
        const blob = textOf(detour) + JSON.stringify(detour.details ?? {});
        assert.ok(
          blob.includes(ROLE_TOOL_FS_BOUNDARY_CODE) || blob.includes("文件系统边界"),
          blob,
        );
        assert.equal(readFileSync(protectedFile, "utf8"), MARKER);
        assert.equal(process.exitCode, 1);
        assert.equal(toolResult(sessionManager.getEntries(), "out"), undefined);
      });
    } finally {
      process.exitCode = prevExit;
      if (prevEngine === undefined) delete process.env[AK_ROLE_ENGINE_ENV];
      else process.env[AK_ROLE_ENGINE_ENV] = prevEngine;
    }
  });
});
