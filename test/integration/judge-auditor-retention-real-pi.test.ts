// #420 整改：自 test/unit/public-cli-failure-settlement.test.ts 按性质移出（起真默认 Pi
// 子进程 + 真 HTTP provider，不属开发内环快档）。契约不变：Judge 公开入口在 retention
// 失败下仍如实保留真实默认-Pi auditor provider stop。
import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import test from "node:test";

import { runAkRole } from "../../src/public-cli/cli.ts";
import {
  assertPublicFailureSettlement,
  captureIo,
  seedGitProject,
  withTempHome,
} from "../helpers/failure-settlement-kit.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

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
    let raw = Buffer.concat(chunks);
    if (raw.length === 0) {
      response.writeHead(200);
      response.end();
      return;
    }
    if (request.headers["content-encoding"] === "gzip" || (raw[0] === 0x1f && raw[1] === 0x8b)) {
      const { gunzipSync } = await import("node:zlib");
      raw = gunzipSync(raw);
    } else if (request.headers["content-encoding"] === "zstd" || (raw[0] === 0x28 && raw[1] === 0xb5 && raw[2] === 0x2f && raw[3] === 0xfd)) {
      const { zstdDecompressSync } = await import("node:zlib");
      raw = (zstdDecompressSync as any)(raw);
    }
    const body = JSON.parse(raw.toString("utf8")) as any;
    requestCount += 1;
    const toolNames = (body.tools ?? []).map((tool: any) => tool.function?.name);
    // Judge draft province gate runs before auditor; pass so retention still hits auditor stop.
    if (toolNames.includes("ak_gatekeeper_output")) {
      const args = { status: "dispatch", officer: "notary" };
      const payload = { id: `chatcmpl-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "faux-1", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call-${requestCount}`, type: "function", function: { name: "ak_gatekeeper_output", arguments: JSON.stringify(args) } }] }, finish_reason: null }] };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
      response.write(`data: ${JSON.stringify({ ...payload, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }
    if (toolNames.includes("ak_notary_output")) {
      const args = { status: "pass", findings: [] };
      const payload = { id: `chatcmpl-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "faux-1", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call-${requestCount}`, type: "function", function: { name: "ak_notary_output", arguments: JSON.stringify(args) } }] }, finish_reason: null }] };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
      response.write(`data: ${JSON.stringify({ ...payload, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }
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
      // Production retain is Sitian under dirname(sessionParent)/auditor/records.jsonl.
      // Binding may already have created auditor/; replace records.jsonl with a directory
      // so retainComplianceResponse fails with EISDIR (legacy targeted session custom entry).
      const sitianAuditorPath = join(reportedParentDirectory, "auditor");
      const sitianRecordsPath = join(sitianAuditorPath, "records.jsonl");
      await mkdir(sitianAuditorPath, { recursive: true });
      await rm(sitianRecordsPath, { recursive: true, force: true });
      await mkdir(sitianRecordsPath);
      const parentBytes = await readFile(parentFile);
      // Also replace parent principal with a directory so any residual session write still EISDIR.
      await rm(parentFile, { force: true });
      await mkdir(parentFile);
      let restored = false;
      let watcher: import("node:fs").FSWatcher | undefined;
      restoreParent = async () => {
        if (restored) return;
        restored = true;
        if (restoreInterval !== undefined) clearInterval(restoreInterval);
        try { watcher?.close(); } catch {}
        await rm(parentFile, { recursive: true, force: true });
        await writeFile(parentFile, parentBytes);
        try { await rm(sitianRecordsPath, { recursive: true, force: true }); } catch {}
      };
      const checkAndRestore = async () => {
        try {
          const childDir = join(reportedParentDirectory, "auditor-roles");
          const names = await (await import("node:fs/promises")).readdir(childDir);
          for (const name of names) {
            const targetPath = name.endsWith(".jsonl") ? join(childDir, name) : join(childDir, name, "session.jsonl");
            try {
              const text = await readFile(targetPath, "utf8");
              if (text.includes("ak_auditor_compliance_failure")) {
                await restoreParent?.();
              }
            } catch (err) {
              if ((err as NodeJS.ErrnoException)?.code === "ENOENT" || (err as NodeJS.ErrnoException)?.code === "EISDIR") continue;
              throw err;
            }
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT" || (error as NodeJS.ErrnoException)?.code === "EISDIR") return;
          retainFailure(error);
          try {
            await restoreParent?.();
          } catch (restoreError) {
            retainFailure(restoreError);
          }
        }
      };
      try {
        const { watch } = await import("node:fs");
        watcher = watch(reportedParentDirectory, { recursive: true }, () => {
          void checkAndRestore();
        });
      } catch {}
      restoreInterval = setInterval(() => { void checkAndRestore(); }, 5);
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
  const agentDirGuardUrl = new URL("../helpers/test-agent-dir-guard.ts", import.meta.url).href;
  await writeFile(extension, `
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertWritableTestAgentDir } from ${JSON.stringify(agentDirGuardUrl)};
export default function (pi) {
  console.error("[ak-patch] normal activation banner");
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  assertWritableTestAgentDir(agentDir);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "openai-codex": {
        baseUrl: "http://127.0.0.1:${address.port}/v1",
        apiKey: "test",
        api: "openai-completions",
        models: [{
          id: "faux-1",
          name: "faux-1",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 4096,
          compat: { requiresToolResultName: true },
        }],
      },
    },
  }, null, 2), "utf8");
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
    const agentDir = join(home, ".pi", "agent");
    await mkdir(project, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    seedGitProject(project);
    const retentionIo = captureIo();
    const tracer = await createJudgeAuditorRetentionTracer(home);
    let retentionResult;
    try {
      retentionResult = await runAkRole(
        ["--model", "openai-codex/faux-1:off", "judge", "--project", project, "audit provider stop"],
        {
          packageRoot, home, agentDir, cwd: project, io: retentionIo.io,
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
    // Institutional fetch records the structured 500 Response as upstream testimony
    // (5xx wire observation). errorMessage still carries the SDK-folded body;
    // cause follows the observed Response, not prose.
    const retentionSettlement = await assertPublicFailureSettlement({
      result: retentionResult,
      stdout: retentionIo.stdout,
      stderr: retentionIo.stderr,
      expectedCause: "provider",
      diagnosticIncludes: "WebSocket error",
    });
    const retentionArtifact = JSON.parse(await readFile(retentionSettlement.errorRef.path, "utf8")) as any;
    assert.equal(retentionArtifact.details?.errorMessage?.includes("WebSocket error") || retentionArtifact.diagnostic?.includes("WebSocket error"), true);
    assert.equal(retentionArtifact.details?.httpStatus, 500);
    assert.equal(retentionArtifact.details.retentionFailure.name, "ComplianceResponseRetentionError");
    assert.equal(retentionArtifact.details.retentionFailure.cause.code, "EISDIR");
  });
});
