// #420 整改：自 test/unit/public-cli-failure-settlement.test.ts 按性质移出（起真默认 Pi
// 子进程 + 真 HTTP provider，不属开发内环快档）。契约不变：Judge 公开入口在 retention
// 失败下仍如实保留真实默认-Pi auditor provider stop。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { runAkRole } from "../../src/public-cli/cli.ts";
import {
  CONCISE_DIAGNOSTIC_MAX_CHARS,
  exitCodeForTerminalOutcome,
  isLawfulTypedTerminalOutcome,
} from "../../src/public-cli/settlement.ts";
import type {
  ControlledFailureCause,
  TerminalArtifactRef,
  TerminalResult,
} from "../../src/public-cli/terminal.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-public-cli-fail-"));
  try {
    return await scenario(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => {
        stdout.push(text);
      },
      stderr: (text: string) => {
        stderr.push(text);
      },
    },
  };
}

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@test.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

async function assertPublicFailureSettlement(input: {
  result: { exitCode: number; terminal?: TerminalResult };
  stdout: string[];
  stderr: string[];
  expectedCause: ControlledFailureCause;
  diagnosticIncludes?: string;
  diagnosticEquals?: string;
  identityName?: string;
  identityCode?: string | number;
}): Promise<{ terminal: TerminalResult; errorRef: TerminalArtifactRef }> {
  assert.equal(input.result.exitCode, 1);
  assert.equal(input.stdout.length, 1, "exactly one stdout Terminal emission");
  assert.equal(input.stderr.length, 1, "exactly one stderr diagnostic emission");
  assert.ok((input.stdout[0] ?? "").length > 0);
  assert.equal(
    input.stderr[0]!.split("\n").filter((line) => line.trim() !== "").length,
    1,
    "stderr diagnostic must be one concise line",
  );

  const terminal = input.result.terminal;
  assert.ok(terminal, "public seam must return settled Terminal");
  assert.equal(terminal.roleOutcome.kind, "failure");
  if (terminal.roleOutcome.kind !== "failure") {
    throw new Error("expected failure role outcome");
  }
  assert.equal(terminal.roleOutcome.cause, input.expectedCause);
  assert.equal(typeof terminal.roleOutcome.diagnostic, "string");
  assert.ok(terminal.roleOutcome.diagnostic.length > 0);
  if (input.diagnosticEquals !== undefined) {
    assert.equal(terminal.roleOutcome.diagnostic, input.diagnosticEquals);
  }
  if (input.diagnosticIncludes !== undefined) {
    assert.equal(
      terminal.roleOutcome.diagnostic.includes(input.diagnosticIncludes),
      true,
    );
  }
  assert.equal(isLawfulTypedTerminalOutcome(terminal.roleOutcome), false);
  assert.equal(exitCodeForTerminalOutcome(terminal.roleOutcome), 1);
  assert.ok(terminal.navigator);
  assert.equal(terminal.resume, undefined);
  assert.equal(typeof terminal.runId, "string");
  assert.ok(terminal.runId !== undefined && terminal.runId.length > 0);
  assert.ok(Array.isArray(terminal.artifacts));
  assert.ok(terminal.artifacts.length >= 1);

  // Durability via typed artifact refs — never private layout/filenames.
  const errorRef = terminal.artifacts.find((a) => a.kind === "error");
  assert.ok(errorRef, "failure Terminal must carry error artifact ref");
  const errorBody = JSON.parse(await readFile(errorRef!.path, "utf8")) as {
    kind: string;
    cause: string;
    diagnostic: string;
    identity?: { name?: string; code?: string | number };
  };
  assert.equal(errorBody.kind, "error");
  assert.equal(errorBody.cause, input.expectedCause);
  assert.equal(errorBody.diagnostic, terminal.roleOutcome.diagnostic);
  if (input.identityName !== undefined) {
    assert.equal(errorBody.identity?.name, input.identityName);
  }
  if (input.identityCode !== undefined) {
    assert.equal(errorBody.identity?.code, input.identityCode);
  }
  assert.equal("judgeStatus" in errorBody, false);

  const evidenceRef = terminal.artifacts.find((a) => a.kind === "evidence");
  assert.ok(evidenceRef, "failure Terminal must carry evidence artifact ref");
  await access(evidenceRef!.path);

  // Presentation is bounded even when durable diagnostic is longer.
  const presented = input.stderr[0]!;
  assert.ok(presented.length <= CONCISE_DIAGNOSTIC_MAX_CHARS + 32);

  return { terminal, errorRef: errorRef! };
}

async function createJudgeAuditorRetentionTracer(home: string): Promise<{ extension: string; close(): Promise<void> }> {
  const marker = join(home, "parent-judge.txt");
  const extension = join(home, "provider-judge.ts");
  let requestCount = 0;
  let tracerFailure: unknown;
  let restoreParent: (() => Promise<void>) | undefined;
  let retentionInjected = false;
  let restoreInterval: ReturnType<typeof setInterval> | undefined;
  const retainFailure = (error: unknown) => {
    if (tracerFailure === undefined) tracerFailure = error;
  };
  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as any;
    requestCount += 1;
    const toolNames = (body.tools ?? []).map((tool: any) => tool.function?.name);
    const auditTool = toolNames.find((name: string) => name?.endsWith("_audit_decision"));
    if (auditTool !== undefined) {
      if (retentionInjected) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "WebSocket error" } }));
        return;
      }
      retentionInjected = true;
      const reportedParentFile = (await readFile(marker, "utf8")).trim();
      // Packed/default-Pi fixtures may expose the session principal itself where
      // SessionManager reports the conventional nested session.jsonl path.
      const reportedParentDirectory = dirname(reportedParentFile);
      // The provider request can race the SessionManager's first durable append.
      // Wait for the reported principal rather than coupling this tracer to mkdir timing.
      let parentFile: string | undefined;
      for (let attempt = 0; attempt < 100 && parentFile === undefined; attempt += 1) {
        try {
          await stat(reportedParentFile);
          parentFile = reportedParentFile;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOTDIR") parentFile = reportedParentDirectory;
          else await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      if (parentFile === undefined) throw new Error("reported parent session principal was not created");
      const parentBytes = await readFile(parentFile);
      await rm(parentFile, { force: true });
      await mkdir(parentFile);
      let restored = false;
      restoreParent = async () => {
        if (restored) return;
        restored = true;
        if (restoreInterval !== undefined) clearInterval(restoreInterval);
        await rm(parentFile, { recursive: true, force: true });
        await writeFile(parentFile, parentBytes);
      };
      restoreInterval = setInterval(() => {
        void (async () => {
          try {
            const childDir = join(parentFile, "..", "auditor-roles");
            const names = await (await import("node:fs/promises")).readdir(childDir);
            for (const name of names) {
              const text = await readFile(join(childDir, name), "utf8");
              if (text.includes("ak_auditor_compliance_failure")) await restoreParent?.();
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
            retainFailure(error);
            try {
              await restoreParent?.();
            } catch (restoreError) {
              retainFailure(restoreError);
            }
          }
        })();
      }, 5);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "WebSocket error" } }));
      return;
    }
    const outputTool = toolNames.find((name: string) => name === "ak_judge_output");
    const args = { judgeStatus: "converged", note: "test" };
    const payload = { id: `chatcmpl-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "faux-1", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call-${requestCount}`, type: "function", function: { name: outputTool, arguments: JSON.stringify(args) } }] }, finish_reason: null }] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
    response.write(`data: ${JSON.stringify({ ...payload, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      retainFailure(error);
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test provider did not listen");
  await writeFile(extension, `
import { writeFileSync } from "node:fs";
export default function (pi) {
  console.error("[ak-patch] normal activation banner");
  pi.registerProvider("openai-codex", {
    name: "Retention tracer", baseUrl: "http://127.0.0.1:${address.port}/v1", apiKey: "test", api: "openai-completions",
    models: [{ id: "faux-1", name: "faux-1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }]
  });
  pi.on("session_start", (_event, ctx) => writeFileSync(${JSON.stringify(marker)}, ctx.sessionManager.getSessionFile(), "utf8"));
}
`, "utf8");
  return {
    extension,
    close: async () => {
      if (restoreInterval !== undefined) clearInterval(restoreInterval);
      try {
        await restoreParent?.();
      } catch (error) {
        retainFailure(error);
      }
      try {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      } catch (error) {
        retainFailure(error);
      }
      if (tracerFailure !== undefined) throw tracerFailure;
    },
  };
}

test("Judge publicly retains a real default-Pi auditor provider stop across retention failure", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj-judge-retention");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const retentionIo = captureIo();
    const tracer = await createJudgeAuditorRetentionTracer(home);
    let retentionResult;
    try {
      retentionResult = await runAkRole(
        ["--model", "openai-codex/faux-1:off", "judge", "--project", project, "audit provider stop"],
        {
          packageRoot, home, cwd: project, io: retentionIo.io,
          credentials: { "openai-codex": true, xai: true },
          createRunId: () => "run-judge-auditor-retention-failure",
          judgeExtraPiArgs: ["-e", tracer.extension],
          judgeTimeoutMs: 60_000,
        },
      );
    } finally {
      await tracer.close();
    }
    assert.notEqual(retentionResult.exitCode === 1 && retentionResult.terminal?.roleOutcome.kind === "failure" ? retentionResult.terminal.roleOutcome.cause : undefined, "timeout");
    // openai-completions throws APIError before onResponse, so non-2xx never becomes
    // typed HTTP testimony at this seam (r3-A: onResponse only, no fetch wrap).
    // Held errorMessage still reaches error.json; cause stays the honest unknown.
    const retentionSettlement = await assertPublicFailureSettlement({
      result: retentionResult,
      stdout: retentionIo.stdout,
      stderr: retentionIo.stderr,
      expectedCause: "unrecognized",
      diagnosticIncludes: "WebSocket error",
    });
    const retentionArtifact = JSON.parse(await readFile(retentionSettlement.errorRef.path, "utf8")) as any;
    assert.equal(retentionArtifact.details?.errorMessage?.includes("WebSocket error") || retentionArtifact.diagnostic?.includes("WebSocket error"), true);
    assert.equal(retentionArtifact.details?.provider, undefined);
    assert.equal(retentionArtifact.details.retentionFailure.name, "ComplianceResponseRetentionError");
    assert.equal(retentionArtifact.details.retentionFailure.cause.code, "EISDIR");
  });
});
