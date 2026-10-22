/**
 * Detour cancellation propagation + spawn-miss result seam.
 * Engine process failure returns to the seat (#1213); does NOT cover public-CLI
 * empty-output / exit-23 cause 贯穿 or the full engine-detour failure table.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { runEngineDetourOnce } from "../../src/engine-detour.ts";
import {
  createEngineDetourToolDefinition,
} from "../../src/engine-detour-tool.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

const hangScript = `
import { setTimeout as sleep } from "node:timers/promises";
await sleep(600_000);
console.log("should-not-print");
`;

async function withHangCwd<T>(run: (cwd: string, argv: string[]) => Promise<T>): Promise<T> {
  return withTempRoot("ak-detour-hang-", async (cwd) => {
    const scriptPath = join(cwd, "hang.mjs");
    await writeFile(scriptPath, hangScript, "utf8");
    return await run(cwd, [process.execPath, scriptPath]);
  });
}

function fakeCtx(cwd: string): ExtensionContext {
  return {
    cwd,
    sessionManager: { getEntries: () => [] },
    abort() {},
  } as unknown as ExtensionContext;
}

test("runEngineDetourOnce abort rejects with signal reason and terminates child", async () => {
  await withHangCwd(async (cwd, argv) => {
    const controller = new AbortController();
    const pending = runEngineDetourOnce({ argv, cwd, signal: controller.signal });
    const reason = new Error("caller-cancel");
    controller.abort(reason);
    await assert.rejects(pending, (error: unknown) => error === reason);
  });
});

test("detour caller AbortSignal cancel propagates unchanged", async () => {
  await withHangCwd(async (cwd, argv) => {
    const tool = createEngineDetourToolDefinition({
      engineName: "kimi",
    });
    const controller = new AbortController();
    const pending = tool.execute("call-1", { argv }, controller.signal, undefined, fakeCtx(cwd));
    const reason = new Error("upper-layer-cancel");
    controller.abort(reason);
    await assert.rejects(pending, (error: unknown) => error === reason);
  });
});

test("detour spawn failure returns cause-bearing result without aborting the seat", async () => {
  const tool = createEngineDetourToolDefinition({ engineName: "kimi" });
  await withTempRoot("ak-detour-spawn-miss-", async (cwd) => {
    const result = await tool.execute(
      "call-spawn-miss",
      { argv: ["ak-engine-definitely-missing-binary-xyz"] },
      undefined,
      undefined,
      fakeCtx(cwd),
    );
    assert.ok(Array.isArray(result.content) && result.content.length > 0);
    assert.equal(result.isError, true, "identified spawn failure is a tool error");
    const details = result.details as { tool?: string; errorCode?: string };
    assert.equal(details.tool, "ak_engine_detour");
    assert.equal(details.errorCode, "ENOENT");
  });
});

test("detour empty or invalid argv returns parameter error without aborting the seat", async () => {
  const tool = createEngineDetourToolDefinition({ engineName: "kimi" });
  await withTempRoot("ak-detour-argv-", async (cwd) => {
    const cases: Array<{ label: string; params: Record<string, unknown> }> = [
      { label: "empty-array", params: { argv: [] } },
      { label: "empty-string-element", params: { argv: [""] } },
      { label: "missing-argv", params: {} },
    ];
    for (const row of cases) {
      const result = await tool.execute(
        `call-argv-${row.label}`,
        row.params as { argv: string[] },
        undefined,
        undefined,
        fakeCtx(cwd),
      );
      assert.ok(
        Array.isArray(result.content) && result.content.length > 0,
        `${row.label}: parameter error returns tool content`,
      );
      assert.equal(result.isError, true, `${row.label}: parameter error is a tool error`);
      const details = result.details as { tool?: string };
      assert.equal(details.tool, "ak_engine_detour", row.label);
    }
  });
});
