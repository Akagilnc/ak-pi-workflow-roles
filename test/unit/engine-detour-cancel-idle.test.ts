/**
 * #380 — detour cancel vs idle/engine-failure split; idle aborts derived signal.
 */
import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
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

/** Child polls a control file; each content change emits one stdout byte (activity). */
const activityScript = `
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
writeFileSync("ready", "1");
let last = "";
for (;;) {
  try {
    const cur = readFileSync("poke", "utf8");
    if (cur !== last) {
      last = cur;
      process.stdout.write("x");
    }
  } catch {
    // poke file may race with parent setup
  }
  await sleep(20);
}
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

async function withActivityCwd<T>(
  run: (cwd: string, argv: string[], poke: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "ak-detour-activity-"));
  const scriptPath = join(cwd, "activity.mjs");
  const pokePath = join(cwd, "poke");
  await writeFile(scriptPath, activityScript, "utf8");
  await writeFile(pokePath, "0", "utf8");
  try {
    return await run(cwd, [process.execPath, scriptPath], async () => {
      await writeFile(pokePath, `${Date.now()}\n`, "utf8");
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** Real-time wait that still works under node:test mock timers (Date + setImmediate). */
async function realWait(ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function waitForReady(cwd: string, timeoutMs = 5_000): Promise<void> {
  const readyPath = join(cwd, "ready");
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      await access(readyPath);
      return;
    } catch {
      await realWait(20);
    }
  }
  throw new Error("activity child did not become ready");
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

test("runEngineDetourOnce invokes onOutputActivity for stdout and stderr bytes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-detour-chunk-"));
  const scriptPath = join(cwd, "chunks.mjs");
  await writeFile(
    scriptPath,
    `process.stdout.write("out"); process.stderr.write("err");\n`,
    "utf8",
  );
  try {
    let touches = 0;
    const result = await runEngineDetourOnce({
      argv: [process.execPath, scriptPath],
      cwd,
      onOutputActivity: () => {
        touches += 1;
      },
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "out");
    assert.equal(result.stderr, "err");
    assert.ok(touches >= 2, `expected stdout+stderr activity touches, got ${touches}`);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("long-silent detour child is cut by package-owned idle (183s silence)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await withHangCwd(async (cwd, argv) => {
    const latch = createEngineLaborFallbackLatch();
    installActivationEngineLaborFallbackLatch(latch);
    try {
      const tool = createEngineDetourToolDefinition({
        engineName: "opus",
        fail(error) {
          throw error;
        },
      }) as ToolDefinition;
      const pending = tool.execute(
        "call-silent",
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
      t.mock.timers.tick(PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS - 1);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      assert.equal(settled, undefined, "must still be alive just before 183s silence");

      t.mock.timers.tick(1);
      for (let i = 0; i < 20; i++) await Promise.resolve();

      assert.ok(settled && typeof settled === "object");
      const field = readEngineLaborFallbackField(latch);
      assert.ok(field, "silent hang must record seat-fallback after idle cut");
      assert.equal(field.engineLaborFallback.engine, "opus");
    } finally {
      clearActivationEngineLaborFallbackLatch();
    }
  });
});

test("slow detour child that keeps emitting bytes survives past 183s idle window", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await withActivityCwd(async (cwd, argv, pokeChild) => {
    const latch = createEngineLaborFallbackLatch();
    installActivationEngineLaborFallbackLatch(latch);
    try {
      const tool = createEngineDetourToolDefinition({
        engineName: "opus",
        fail(error) {
          throw error;
        },
      }) as ToolDefinition;
      const pending = tool.execute(
        "call-active",
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

      await waitForReady(cwd);
      // Survive well past one 183s budget by touching the clock before each boundary.
      // Cumulative mocked time here is > 2 * 183s with the tool still running.
      for (let window = 0; window < 3; window++) {
        t.mock.timers.tick(PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS - 1);
        for (let i = 0; i < 5; i++) await Promise.resolve();
        assert.equal(
          settled,
          undefined,
          `must still be running just before idle boundary #${window + 1}`,
        );
        await pokeChild();
        // Child poll → stdout byte → parent data → package-owned idle.poke (real I/O).
        await realWait(250);
        for (let i = 0; i < 10; i++) await Promise.resolve();
        assert.equal(
          settled,
          undefined,
          `byte activity must reset idle window #${window + 1}`,
        );
      }

      // True silence after the last byte: the 183s law still cuts.
      t.mock.timers.tick(PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      assert.ok(settled && typeof settled === "object", "eventual silence must settle");
      const field = readEngineLaborFallbackField(latch);
      assert.ok(field, "post-activity silence still records seat-fallback");
      assert.equal(field.engineLaborFallback.engine, "opus");
    } finally {
      clearActivationEngineLaborFallbackLatch();
    }
  });
});

// Keep module URL referenced so tsx resolves consistently under some runners.
void fileURLToPath(import.meta.url);
