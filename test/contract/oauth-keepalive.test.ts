// #685 C1: withInProcessPi host legs culled. C3 §I: e2e 双窗 refresh / shutdown 零
// tick / unexpired 零网络 / production setting seam 未结（非笼统「异常面」）；
// docs/research/issue-685-c3-deleted-contract-handoff.md.
/**
 * #351 kimi-coding OAuth keepalive — required automatic tracers.
 *
 * Seams:
 *   1) Real extension session lifecycle entry (withInProcessPi + createRoleRuntimeExtension + bindExtensions)
 *   2) Public ctx.modelRegistry.refresh facade driven by keepalive ticks
 *   3) Provider-side oauth.refresh callback / network (not internal credential parsing)
 *
 * Soak (>30min live kimi-coding) is out of CI gate — not covered here.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";


import {
  createOAuthKeepalive,
  OAUTH_KEEPALIVE_INTERVAL_MS,
  OAUTH_KEEPALIVE_SETTING_FILENAME,
  readOAuthKeepaliveProviders,
} from "../../src/oauth-keepalive.ts";
import { withActivationHome } from "../helpers/pi-test-harness.ts";

beforeEach(() => { vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] }); });
afterEach(() => { vi.useRealTimers(); });

type OAuthCounters = {
  refreshCount: number;
  networkCalls: number;
  lastAccess: string | undefined;
};




test("#351 single-flight: in-flight refresh causes second tick to skip", async () => {
  let release!: () => void;
  const hold = {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  const counters: OAuthCounters = { refreshCount: 0, networkCalls: 0, lastAccess: undefined };
  const refreshCalls: number[] = [];
  const keepalive = createOAuthKeepalive({
    providers: ["kimi-coding"],
  });

  const modelRegistry = {
    async refresh() {
      refreshCalls.push(Date.now());
      await hold.promise;
      counters.refreshCount += 1;
      return { aborted: false, errors: new Map<string, Error>() };
    },
  };

  keepalive.start({ modelRegistry });
  assert.equal(vi.getTimerCount(), 1);

  // The production interval is unref'd; fake time must still drive it.
  await vi.advanceTimersByTimeAsync(OAUTH_KEEPALIVE_INTERVAL_MS);
  assert.equal(refreshCalls.length, 1);

  // Second tick while in-flight — must not start another refresh.
  await vi.advanceTimersByTimeAsync(OAUTH_KEEPALIVE_INTERVAL_MS);
  assert.equal(refreshCalls.length, 1, "single-flight must skip overlapping tick");

  release();
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(counters.refreshCount, 1);

  // After settle, next tick may run.
  await vi.advanceTimersByTimeAsync(OAUTH_KEEPALIVE_INTERVAL_MS);
  assert.equal(refreshCalls.length, 2);

  keepalive.stop();
});

test(
  "#351 restart single-flight: stop→start keeps max concurrent refresh === 1 across generations",
  async () => {
    let releaseOld!: () => void;
    const oldHold = {
      promise: new Promise<void>((resolve) => {
        releaseOld = resolve;
      }),
    };
    let active = 0;
    let maxConcurrent = 0;
    const refreshStarted: number[] = [];
    const refreshSettled: number[] = [];
    let callIndex = 0;

    const keepalive = createOAuthKeepalive({ providers: ["kimi-coding"] });

    const modelRegistry = {
      async refresh(_options?: { signal?: AbortSignal }) {
        // Ignore abort: models the slow refresh that outlives stop()/generation change.
        const id = callIndex++;
        refreshStarted.push(id);
        active += 1;
        maxConcurrent = Math.max(maxConcurrent, active);
        try {
          if (id === 0) await oldHold.promise;
          return { aborted: false, errors: new Map<string, Error>() };
        } finally {
          active -= 1;
          refreshSettled.push(id);
        }
      },
    };

    keepalive.start({ modelRegistry });
    assert.equal(vi.getTimerCount(), 1);

    // Generation-0 tick: refresh starts and is held open (ignores abort).
    await vi.advanceTimersByTimeAsync(OAUTH_KEEPALIVE_INTERVAL_MS);
    assert.deepEqual(refreshStarted, [0]);
    assert.equal(active, 1);

    // stop→start: new generation interval; old refresh still unsettled.
    keepalive.stop();
    keepalive.start({ modelRegistry });
    assert.equal(vi.getTimerCount(), 1, "restart must schedule exactly one new interval");

    // New-generation tick while old refresh still in flight — must be skipped.
    await vi.advanceTimersByTimeAsync(OAUTH_KEEPALIVE_INTERVAL_MS);
    assert.deepEqual(refreshStarted, [0], "new tick must not start while old refresh unsettled");
    assert.equal(maxConcurrent, 1);

    // Old call settles; next tick may run.
    releaseOld();
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(refreshSettled, [0]);

    await vi.advanceTimersByTimeAsync(OAUTH_KEEPALIVE_INTERVAL_MS);
    assert.deepEqual(refreshStarted, [0, 1], "post-settle tick must run");
    assert.equal(maxConcurrent, 1, "instance concurrent refresh must stay ≤ 1 across restart");

    keepalive.stop();
  },
);

test("#351 error path: refresh rejection emits one warning; interval continues", async () => {
  let warningCount = 0;
  const originalWarn = console.warn;
  console.warn = (..._args: unknown[]) => {
    warningCount += 1;
  };

  try {
    let attempts = 0;
    const keepalive = createOAuthKeepalive({ providers: ["kimi-coding"] });
    const boom = new Error("token endpoint down");
    boom.name = "TokenEndpointError";

    keepalive.start({
      modelRegistry: {
        async refresh() {
          attempts += 1;
          throw boom;
        },
      },
    });

    await vi.advanceTimersByTimeAsync(OAUTH_KEEPALIVE_INTERVAL_MS);
    assert.equal(attempts, 1);
    assert.equal(warningCount, 1, "exactly one warning per failed tick/provider");

    // Interval still alive — next tick retries (no circuit breaker).
    await vi.advanceTimersByTimeAsync(OAUTH_KEEPALIVE_INTERVAL_MS);
    assert.equal(attempts, 2);
    assert.equal(warningCount, 2);

    keepalive.stop();
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    console.warn = originalWarn;
  }
});

test("#351 dual surface: ui.notify + console both available → exactly one visible warning", async () => {
  let consoleWarningCount = 0;
  const notificationTypes: Array<string | undefined> = [];
  const originalWarn = console.warn;
  console.warn = (..._args: unknown[]) => {
    consoleWarningCount += 1;
  };

  try {
    let attempts = 0;
    const keepalive = createOAuthKeepalive({ providers: ["kimi-coding"] });
    const boom = new Error("token endpoint down");
    boom.name = "TokenEndpointError";

    keepalive.start({
      modelRegistry: {
        async refresh() {
          attempts += 1;
          throw boom;
        },
      },
      ui: {
        notify(_message, type) {
          notificationTypes.push(type);
        },
      },
    });

    await vi.advanceTimersByTimeAsync(OAUTH_KEEPALIVE_INTERVAL_MS);
    assert.equal(attempts, 1);
    assert.equal(notificationTypes.length, 1, "ui.notify must receive exactly one warning");
    assert.equal(notificationTypes[0], "warning");
    assert.equal(
      consoleWarningCount,
      0,
      "must not also console.warn when ui.notify is available",
    );

    // No immediate retry / no circuit breaker — next natural tick tries again.
    await vi.advanceTimersByTimeAsync(OAUTH_KEEPALIVE_INTERVAL_MS);
    assert.equal(attempts, 2);
    assert.equal(notificationTypes.length, 2);
    assert.equal(consoleWarningCount, 0);

    keepalive.stop();
  } finally {
    console.warn = originalWarn;
  }
});

test("#351 notify throw: falls back once to console.warn with provider/class and notify cause", async () => {
  const consoleArgs: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    consoleArgs.push(args);
  };

  try {
    const keepalive = createOAuthKeepalive({ providers: ["kimi-coding"] });
    const boom = new Error("token endpoint down");
    boom.name = "TokenEndpointError";
    const notifyBoom = new Error("ui bus closed");
    notifyBoom.name = "NotifyTransportError";

    keepalive.start({
      modelRegistry: {
        async refresh() {
          throw boom;
        },
      },
      ui: {
        notify() {
          throw notifyBoom;
        },
      },
    });

    await vi.advanceTimersByTimeAsync(OAUTH_KEEPALIVE_INTERVAL_MS);
    assert.equal(consoleArgs.length, 1, "exactly one console fallback when notify throws");
    // Route/cause identity only — do not lock warning presentation text (#685 C3).
    const cause = consoleArgs[0]![1];
    assert.equal(cause, notifyBoom, "fallback must carry the notify throw cause");

    keepalive.stop();
  } finally {
    console.warn = originalWarn;
  }
});

test(
  "#351 setting whitespace: padded provider id is normalized into refresh providers",
  async () => {
    await withActivationHome(
      { prefix: "ak-oauth-keepalive-ws-" },
      async ({ agentDir }) => {
        await writeFile(
          join(agentDir, OAUTH_KEEPALIVE_SETTING_FILENAME),
          `${JSON.stringify({ providers: ["  custom-oauth  "] })}\n`,
          "utf8",
        );
        const providers = readOAuthKeepaliveProviders();
        assert.deepEqual(
          [...providers],
          ["custom-oauth"],
          "setting reader must return trimmed provider ids",
        );

        const seenProviders: string[][] = [];
        const keepalive = createOAuthKeepalive({ providers });
        keepalive.start({
          modelRegistry: {
            async refresh(options) {
              seenProviders.push([...(options?.providers ?? [])]);
              return { aborted: false, errors: new Map<string, Error>() };
            },
          },
        });

        await vi.advanceTimersByTimeAsync(OAUTH_KEEPALIVE_INTERVAL_MS);
        assert.deepEqual(
          seenProviders,
          [["custom-oauth"]],
          "refresh must receive normalized provider ids from the setting entry",
        );
        keepalive.stop();
      },
    );
  },
);
