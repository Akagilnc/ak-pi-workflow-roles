/**
 * #380 — detour cancel vs idle/engine-failure split; idle aborts derived signal.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { runEngineDetourOnce } from "../../src/engine-detour.ts";
import {
  createEngineDetourToolDefinition,
} from "../../src/engine-detour-tool.ts";
import {
  clearActivationEngineLaborFallbackLatch,
  createEngineLaborFallbackLatch,
  installActivationEngineLaborFallbackLatch,
  readEngineLaborFallbackField,
} from "../../src/engine-labor-fallback.ts";
import {
  PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS,
  PackageOwnedToolIdleTimeoutError,
  isPackageOwnedToolIdleTimeoutError,
  wrapPackageOwnedToolDefinition,
} from "../../src/package-owned-tool-idle.ts";

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

test("detour caller AbortSignal cancel propagates and does not record fallback", async () => {
  await withHangCwd(async (cwd, argv) => {
    const latch = createEngineLaborFallbackLatch();
    installActivationEngineLaborFallbackLatch(latch);
    try {
      const tool = createEngineDetourToolDefinition({
        engineName: "kimi",
        fail(error) {
          throw error;
        },
      });
      const controller = new AbortController();
      const pending = tool.execute(
        "call-1",
        { argv },
        controller.signal,
        undefined,
        fakeCtx(cwd),
      );
      const reason = new Error("upper-layer-cancel");
      controller.abort(reason);
      await assert.rejects(pending, (error: unknown) => error === reason);
      assert.equal(
        readEngineLaborFallbackField(latch),
        undefined,
        "caller cancel must not write engineLaborFallback",
      );
    } finally {
      clearActivationEngineLaborFallbackLatch();
    }
  });
});

test("package-owned idle on detour soft-fails via seat fallback and records latch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await withHangCwd(async (cwd, argv) => {
    const latch = createEngineLaborFallbackLatch();
    installActivationEngineLaborFallbackLatch(latch);
    try {
      const tool = createEngineDetourToolDefinition({
        engineName: "kimi",
        fail(error) {
          throw error;
        },
      }) as ToolDefinition;
      // createEngineDetourToolDefinition already wraps; ensure single wrap.
      const wrapped = wrapPackageOwnedToolDefinition(tool);
      const pending = wrapped.execute(
        "call-idle",
        { argv },
        undefined,
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
      t.mock.timers.tick(PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS);
      // Drain cooperative softFail microtasks + idle hard-reject drain.
      for (let i = 0; i < 20; i++) await Promise.resolve();

      assert.ok(settled && typeof settled === "object");
      const outcome = settled as { ok: boolean; value?: unknown; error?: unknown };
      if (outcome.ok) {
        const value = outcome.value as {
          details?: { detourFailed?: boolean; engineLaborFallback?: { engine?: string } };
        };
        assert.equal(value.details?.detourFailed, true);
        assert.equal(value.details?.engineLaborFallback?.engine, "kimi");
      } else {
        // Hard-reject still acceptable if soft path lost the race — latch must exist.
        assert.ok(
          isPackageOwnedToolIdleTimeoutError(outcome.error) ||
            outcome.error instanceof PackageOwnedToolIdleTimeoutError,
        );
      }
      const field = readEngineLaborFallbackField(latch);
      assert.ok(field, "idle path must record seat-fallback declaration");
      assert.equal(field.engineLaborFallback.engine, "kimi");
      assert.equal(field.engineLaborFallback.laborBy, "seat");
      assert.match(field.engineLaborFallback.failure, /idle timeout|aborted|package-owned/i);
    } finally {
      clearActivationEngineLaborFallbackLatch();
    }
  });
});

// Keep module URL referenced so tsx resolves consistently under some runners.
void fileURLToPath(import.meta.url);
