/**
 * #692 role tool FS boundary — real shared-envelope entry (withInProcessPi).
 * Isolation: W workspace + T tmpdir + P protected (outside both, not real home).
 * Temp only under mkdtemp; this file never deletes directories.
 * Focused acceptance only (mutation proof is a one-shot delivery run, not a permanent test).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
} from "@earendil-works/pi-ai";

import {
  ENGINE_DETOUR_TOOL_NAME,
  AK_ROLE_ENGINE_ENV,
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
const PROTECTED_MARKER = "PROTECTED_BYTES_692_UNCHANGED";

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

function toolResultById(
  entries: readonly { type?: string; message?: any }[],
  id: string,
): any | undefined {
  return entries.find(
    (entry) =>
      entry.type === "message" &&
      entry.message?.role === "toolResult" &&
      entry.message?.toolCallId === id,
  )?.message;
}

function seedWorktree(work: string): void {
  mkdirSync(work, { recursive: true });
  seedGitRepository(work);
  execFileSync("git", ["config", "user.email", "fs-boundary@test.local"], {
    cwd: work,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "FS Boundary"], {
    cwd: work,
    stdio: "ignore",
  });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], {
    cwd: work,
    stdio: "ignore",
  });
}

async function withBoundaryFixture<T>(
  run: (fixture: {
    home: string;
    agentDir: string;
    workspace: string;
    tempRoot: string;
    protectedRoot: string;
    protectedFile: string;
  }) => Promise<T>,
): Promise<T> {
  return withActivationHome({ prefix: "ak-692-fs-bound-" }, async ({ home, agentDir }) => {
    const workspace = join(home, "W");
    const tempRoot = join(home, "T");
    mkdirSync(tempRoot, { recursive: true });
    seedWorktree(workspace);
    // P is a sibling under OS tmp — outside W and T, never the real home.
    const protectedRoot = mkdtempSync(join(tmpdir(), "ak-692-P-"));
    const protectedFile = join(protectedRoot, "keep.txt");
    writeFileSync(protectedFile, PROTECTED_MARKER, "utf8");

    const previousTmpdir = process.env.TMPDIR;
    const previousTmp = process.env.TMP;
    process.env.TMPDIR = tempRoot;
    process.env.TMP = tempRoot;
    try {
      return await run({
        home,
        agentDir,
        workspace,
        tempRoot,
        protectedRoot,
        protectedFile,
      });
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
      if (previousTmp === undefined) delete process.env.TMP;
      else process.env.TMP = previousTmp;
    }
  });
}

test(
  "#692 negative matrix: rm/write/mv/symlink blocked; P unchanged; run continues to inspector pass",
  { timeout: 60_000 },
  async () => {
    await withBoundaryFixture(async ({ home, agentDir, workspace, tempRoot, protectedFile }) => {
      const link = join(workspace, "link-to-p");
      symlinkSync(protectedFile, link);
      const wFile = join(workspace, "in-w.txt");
      writeFileSync(wFile, "workspace-ok", "utf8");
      const tFile = join(tempRoot, "in-t.txt");
      writeFileSync(tFile, "temp-ok", "utf8");

      const faux = fauxProvider({
        api: "ak-692-fs-bound",
        provider: "ak-692-fs-bound",
        tokenSize: { min: 1000, max: 1000 },
      });

      const ids = {
        rm: "692-rm",
        write: "692-write",
        mvOut: "692-mv-out",
        mvIn: "692-mv-in",
        symlinkWrite: "692-symlink-write",
        readOutside: "692-read-outside",
        writeInsideW: "692-write-w",
        writeInsideT: "692-write-t",
        output: "692-output",
      } as const;

      await withInProcessPi(
        {
          activationLedgerSession: true,
          cwd: workspace,
          home,
          agentDir,
          faux,
          modelsPath: null,
          noExtensions: true,
          systemPrompt: "FS BOUNDARY 692",
          mode: "print",
          flags: { "ak-role": "inspector" },
          additionalExtensionPaths: [EXTENSION],
        },
        async ({ session, sessionManager }) => {
          faux.setResponses([
            (context: Context) => {
              void context;
              return fauxAssistantMessage(
                [
                  fauxToolCall(
                    "bash",
                    { command: `rm -rf ${JSON.stringify(protectedFile)}` },
                    { id: ids.rm },
                  ),
                  fauxToolCall(
                    "write",
                    { path: protectedFile, content: "hijack" },
                    { id: ids.write },
                  ),
                  fauxToolCall(
                    "bash",
                    {
                      command: `mv ${JSON.stringify(wFile)} ${JSON.stringify(protectedFile)}`,
                    },
                    { id: ids.mvOut },
                  ),
                  fauxToolCall(
                    "bash",
                    {
                      command: `mv ${JSON.stringify(protectedFile)} ${JSON.stringify(join(workspace, "stolen.txt"))}`,
                    },
                    { id: ids.mvIn },
                  ),
                  fauxToolCall(
                    "bash",
                    { command: `printf hijacked > ${JSON.stringify(link)}` },
                    { id: ids.symlinkWrite },
                  ),
                  fauxToolCall(
                    "read",
                    { path: protectedFile },
                    { id: ids.readOutside },
                  ),
                  fauxToolCall(
                    "write",
                    { path: join(workspace, "allowed-w.txt"), content: "w-ok" },
                    { id: ids.writeInsideW },
                  ),
                  fauxToolCall(
                    "write",
                    { path: join(tempRoot, "allowed-t.txt"), content: "t-ok" },
                    { id: ids.writeInsideT },
                  ),
                ],
                { stopReason: "toolUse" },
              );
            },
            fauxAssistantMessage(
              fauxToolCall(
                INSPECTOR_OUTPUT_TOOL_NAME,
                { status: "pass", findings: [] },
                { id: ids.output },
              ),
              { stopReason: "toolUse" },
            ),
          ]);

          await session.prompt("Exercise FS boundary matrix.");

          const entries = sessionManager.getEntries();
          for (const id of [ids.rm, ids.write, ids.mvOut, ids.mvIn, ids.symlinkWrite] as const) {
            const result = toolResultById(entries, id);
            assert.ok(result, `${id} must produce a toolResult`);
            assert.equal(result.isError, true, `${id} must be typed tool error`);
            assert.match(
              textOf(result),
              new RegExp(ROLE_TOOL_FS_BOUNDARY_CODE),
              `${id} reason must name boundary code`,
            );
          }

          assert.equal(
            readFileSync(protectedFile, "utf8"),
            PROTECTED_MARKER,
            "P bytes must be unchanged after blocked mutations",
          );

          const readResult = toolResultById(entries, ids.readOutside);
          assert.ok(readResult, "read outside must run");
          assert.equal(readResult.isError, false, "read outside is unrestricted");
          assert.match(textOf(readResult), new RegExp(PROTECTED_MARKER));

          const writeW = toolResultById(entries, ids.writeInsideW);
          assert.ok(writeW);
          assert.equal(writeW.isError, false, "write inside W allowed");
          assert.equal(readFileSync(join(workspace, "allowed-w.txt"), "utf8"), "w-ok");

          const writeT = toolResultById(entries, ids.writeInsideT);
          assert.ok(writeT);
          assert.equal(writeT.isError, false, "write inside T allowed");
          assert.equal(readFileSync(join(tempRoot, "allowed-t.txt"), "utf8"), "t-ok");

          const output = toolResultById(entries, ids.output);
          assert.ok(output, "run must continue to inspector output");
          assert.equal(output.isError, false, "inspector terminal accepted");
        },
      );
    });
  },
);

test(
  "#692 detour argv write outside P fails the whole run (ADR 0071)",
  { timeout: 60_000 },
  async () => {
    await withBoundaryFixture(async ({ home, agentDir, workspace, protectedFile }) => {
      const previousEngine = process.env[AK_ROLE_ENGINE_ENV];
      process.env[AK_ROLE_ENGINE_ENV] = "kimi";
      const previousExit = process.exitCode;
      process.exitCode = undefined;

      const faux = fauxProvider({
        api: "ak-692-detour-bound",
        provider: "ak-692-detour-bound",
        tokenSize: { min: 1000, max: 1000 },
      });

      try {
        await withInProcessPi(
          {
            activationLedgerSession: true,
            cwd: workspace,
            home,
            agentDir,
            faux,
            modelsPath: null,
            noExtensions: true,
            systemPrompt: "FS BOUNDARY DETOUR 692",
            mode: "print",
            flags: { "ak-role": "inspector" },
            additionalExtensionPaths: [EXTENSION],
          },
          async ({ session, sessionManager }) => {
            faux.setResponses([
              fauxAssistantMessage(
                fauxToolCall(
                  ENGINE_DETOUR_TOOL_NAME,
                  { argv: ["bash", "-c", `rm -rf ${JSON.stringify(protectedFile)}`] },
                  { id: "692-detour-rm" },
                ),
                { stopReason: "toolUse" },
              ),
              // Must not be accepted if detour stops the run (ADR 0071).
              fauxAssistantMessage(
                fauxToolCall(
                  INSPECTOR_OUTPUT_TOOL_NAME,
                  { status: "pass", findings: [] },
                  { id: "692-detour-output" },
                ),
                { stopReason: "toolUse" },
              ),
            ]);

            // failInfrastructure aborts + exitCode=1; prompt may settle after the throw is
            // projected as a tool error — assert the run-stop facts, not a prompt rejection shape.
            try {
              await session.prompt("Detour outside boundary.");
            } catch {
              // optional throw depending on host projection timing
            }

            const detourResult = toolResultById(
              sessionManager.getEntries(),
              "692-detour-rm",
            );
            assert.ok(detourResult, "detour must leave a toolResult");
            assert.equal(detourResult.isError, true, "detour boundary is a failure result");
            const detourText = textOf(detourResult);
            const detourDetails = JSON.stringify(detourResult.details ?? {});
            assert.ok(
              detourText.includes(ROLE_TOOL_FS_BOUNDARY_CODE) ||
                detourDetails.includes(ROLE_TOOL_FS_BOUNDARY_CODE) ||
                detourText.includes("文件系统边界") ||
                detourDetails.includes("文件系统边界"),
              `detour failure must carry boundary diagnostic, got text=${detourText} details=${detourDetails}`,
            );

            assert.equal(
              readFileSync(protectedFile, "utf8"),
              PROTECTED_MARKER,
              "P must stay intact when detour is stopped",
            );
            assert.equal(
              process.exitCode,
              1,
              "detour boundary failure must stop the run with exitCode 1",
            );

            const output = toolResultById(
              sessionManager.getEntries(),
              "692-detour-output",
            );
            assert.equal(
              output,
              undefined,
              "inspector must not accept after detour boundary failure (no seat fallback)",
            );
          },
        );
      } finally {
        process.exitCode = previousExit;
        if (previousEngine === undefined) delete process.env[AK_ROLE_ENGINE_ENV];
        else process.env[AK_ROLE_ENGINE_ENV] = previousEngine;
      }
    });
  },
);

test(
  "#692 trusted ledger session write coexists with boundary (same run)",
  { timeout: 60_000 },
  async () => {
    await withBoundaryFixture(async ({ home, agentDir, workspace, protectedFile }) => {
      const faux = fauxProvider({
        api: "ak-692-ledger",
        provider: "ak-692-ledger",
        tokenSize: { min: 1000, max: 1000 },
      });

      await withInProcessPi(
        {
          activationLedgerSession: true,
          cwd: workspace,
          home,
          agentDir,
          faux,
          modelsPath: null,
          noExtensions: true,
          systemPrompt: "FS BOUNDARY LEDGER 692",
          mode: "print",
          flags: { "ak-role": "inspector" },
          additionalExtensionPaths: [EXTENSION],
        },
        async ({ session, sessionManager }) => {
          faux.setResponses([
            fauxAssistantMessage(
              [
                fauxToolCall(
                  "bash",
                  { command: `rm -rf ${JSON.stringify(protectedFile)}` },
                  { id: "692-ledger-rm" },
                ),
                fauxToolCall(
                  INSPECTOR_OUTPUT_TOOL_NAME,
                  { status: "pass", findings: [] },
                  { id: "692-ledger-out" },
                ),
              ],
              { stopReason: "toolUse" },
            ),
          ]);

          await session.prompt("Boundary + ledger.");

          const sessionFile = sessionManager.getSessionFile?.();
          assert.ok(
            typeof sessionFile === "string" && sessionFile.length > 0,
            "durable session file must exist (trusted ledger write)",
          );
          const body = readFileSync(sessionFile, "utf8");
          assert.ok(body.length > 0, "session dossier has bytes");
          assert.equal(readFileSync(protectedFile, "utf8"), PROTECTED_MARKER);

          const blocked = toolResultById(sessionManager.getEntries(), "692-ledger-rm");
          assert.ok(blocked?.isError === true);
          const accepted = toolResultById(sessionManager.getEntries(), "692-ledger-out");
          assert.ok(accepted && accepted.isError !== true);
        },
      );
    });
  },
);
