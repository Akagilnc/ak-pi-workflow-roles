/**
 * Detour cancellation propagation + terminal process failures.
 * Package-owned tool idle backstop removed — no 183s execute kill path here.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { runEngineDetourOnce } from "../../src/engine-detour.ts";
import {
  createEngineDetourToolDefinition,
} from "../../src/engine-detour-tool.ts";

const hangScript = `
import { setTimeout as sleep } from "node:timers/promises";
await sleep(600_000);
console.log("should-not-print");
`;

async function withHangCwd<T>(run: (cwd: string, argv: string[]) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "ak-detour-hang-"));
  const scriptPath = join(cwd, "hang.mjs");
  await writeFile(scriptPath, hangScript, "utf8");
  try {
    return await run(cwd, [process.execPath, scriptPath]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
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
      fail(error) { throw error; },
    });
    const controller = new AbortController();
    const pending = tool.execute("call-1", { argv }, controller.signal, undefined, fakeCtx(cwd));
    const reason = new Error("upper-layer-cancel");
    controller.abort(reason);
    await assert.rejects(pending, (error: unknown) => error === reason);
  });
});

test("detour spawn failure stops through the cause-bearing failure seam", async () => {
  const tool = createEngineDetourToolDefinition({
    engineName: "kimi",
    fail(error) { throw error; },
  });
  const cwd = await mkdtemp(join(tmpdir(), "ak-detour-spawn-miss-"));
  try {
    await assert.rejects(
      tool.execute("call-spawn-miss", { argv: ["ak-engine-definitely-missing-binary-xyz"] }, undefined, undefined, fakeCtx(cwd)),
      (error: unknown) => error instanceof Error && error.message.includes("ak-engine-definitely-missing-binary-xyz"),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("silent detour child is not cut by a package-owned tool idle backstop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await withHangCwd(async (cwd, argv) => {
    const tool = createEngineDetourToolDefinition({
        engineName: "opus",
        fail(error) {
          throw error;
        },
      });
      const controller = new AbortController();
      const pending = tool.execute(
        "call-silent",
        { argv },
        controller.signal,
        undefined,
        fakeCtx(cwd),
      );
      let settled: unknown;
      void pending.then(
        (value) => {
          settled = { ok: true, value };
        },
        (error) => {
          settled = { ok: false, error };
        },
      );

      await Promise.resolve();
      // Former package-owned tool idle budget (183s). Mechanism removed — must stay alive.
      t.mock.timers.tick(183_000);
      for (let i = 0; i < 20; i++) await Promise.resolve();

      assert.equal(
        settled,
        undefined,
        "silent detour must not be killed by a removed package-owned tool idle clock",
      );
      // Cleanup via retained caller-cancel path.
      const reason = new Error("test-cleanup-cancel");
      controller.abort(reason);
      await assert.rejects(pending, (error: unknown) => error === reason);
  });
});

test("successful detour projects child stderr verbatim into tool_result details (#536)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-detour-stderr-"));
  try {
    const tool = createEngineDetourToolDefinition({
      engineName: "agy",
      fail(error) { throw error; },
    });
    const result = await tool.execute(
      "call-stderr",
      { argv: [process.execPath, "-e", "process.stdout.write('out-body\\n');process.stderr.write('err-body\\n');"] },
      undefined,
      undefined,
      fakeCtx(cwd),
    );
    assert.equal((result.details as { stderr?: unknown }).stderr, "err-body\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// Keep module URL referenced so tsx resolves consistently under some runners.
void fileURLToPath(import.meta.url);
