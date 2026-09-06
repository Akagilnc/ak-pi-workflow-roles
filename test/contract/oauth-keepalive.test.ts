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
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxProvider,
  InMemoryCredentialStore,
  type OAuthCredential,
  type Provider,
} from "@earendil-works/pi-ai";

import {
  createOAuthKeepalive,
  OAUTH_KEEPALIVE_SETTING_FILENAME,
  readOAuthKeepaliveProviders,
  type OAuthKeepaliveScheduler,
} from "../../src/oauth-keepalive.ts";
import { createPiRoleRuntimeExtension } from "../../src/pi/adapter.ts";
import {
  flushEventLoopTurns,
  withActivationHome,
} from "../helpers/pi-test-harness.ts";

function manualScheduler(): {
  scheduler: OAuthKeepaliveScheduler;
  ticks: Array<() => void>;
} {
  const ticks: Array<() => void> = [];
  const scheduler: OAuthKeepaliveScheduler = {
    every(_ms, tick) {
      ticks.push(tick);
      return () => {
        const idx = ticks.indexOf(tick);
        if (idx >= 0) ticks.splice(idx, 1);
      };
    },
  };
  return { scheduler, ticks };
}

type OAuthCounters = {
  refreshCount: number;
  networkCalls: number;
  lastAccess: string | undefined;
};

function oauthCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    refresh: "refresh-token",
    access: "access-token",
    expires: Date.now() - 1_000,
    ...overrides,
  };
}

/**
 * Controllable OAuth provider: refreshModels present so Models.refresh includes it;
 * oauth.refresh is the network oracle. Stream comes from faux for request success.
 */
function createOAuthMockProvider(options: {
  id: string;
  faux: ReturnType<typeof fauxProvider>;
  counters: OAuthCounters;
  /** When set, refresh rejects with this error (network failure path). */
  refreshError?: Error;
  /** Delay refresh resolution (single-flight). */
  hold?: { promise: Promise<void> };
}): Provider {
  const { id, faux, counters } = options;
  const base = faux.provider;
  return {
    ...base,
    id,
    name: `mock-oauth:${id}`,
    auth: {
      oauth: {
        name: `Mock OAuth ${id}`,
        async login() {
          throw new Error(`login not used in keepalive tests (${id})`);
        },
        async refresh(credential, signal) {
          if (signal.aborted) {
            const err = new Error("aborted");
            err.name = "AbortError";
            throw err;
          }
          if (options.hold) await options.hold.promise;
          if (signal.aborted) {
            const err = new Error("aborted");
            err.name = "AbortError";
            throw err;
          }
          counters.networkCalls += 1;
          counters.refreshCount += 1;
          if (options.refreshError) throw options.refreshError;
          const next: OAuthCredential = {
            type: "oauth",
            refresh: credential.refresh,
            access: `access-${id}-${counters.refreshCount}`,
            expires: Date.now() + 60_000,
          };
          counters.lastAccess = next.access;
          return next;
        },
        async toAuth(credential) {
          return { apiKey: credential.access };
        },
      },
    },
    async refreshModels(context) {
      // Catalog no-op: presence alone admits this provider into Models.refresh.
      await context.publish({});
    },
  };
}

function minimalRoleExtension(oauthKeepalive: {
  providers?: readonly string[];
  intervalMs?: number;
  scheduler?: OAuthKeepaliveScheduler;
}) {
  return createPiRoleRuntimeExtension({
    loadJudgeSoul: async () => "judge",
    auditSoulCompliance: async () => ({ status: "pass" as const }),
  }, { oauthKeepalive });
}

async function fireTick(ticks: Array<() => void>, index = 0): Promise<void> {
  assert.ok(ticks[index], `expected scheduled tick at index ${index}`);
  ticks[index]!();
  // Allow the async runTick body (and nested refresh) to settle.
  await flushEventLoopTurns(30);
}

test("#351 single-flight: in-flight refresh causes second tick to skip", async () => {
  let release!: () => void;
  const hold = {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  const counters: OAuthCounters = { refreshCount: 0, networkCalls: 0, lastAccess: undefined };
  const refreshCalls: number[] = [];
  const { scheduler, ticks } = manualScheduler();

  const keepalive = createOAuthKeepalive({
    providers: ["kimi-coding"],
    scheduler,
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
  assert.equal(ticks.length, 1);

  // Start first tick (held open).
  ticks[0]!();
  await flushEventLoopTurns(5);
  assert.equal(refreshCalls.length, 1);

  // Second tick while in-flight — must not start another refresh.
  ticks[0]!();
  await flushEventLoopTurns(5);
  assert.equal(refreshCalls.length, 1, "single-flight must skip overlapping tick");

  release();
  await flushEventLoopTurns(10);
  assert.equal(counters.refreshCount, 1);

  // After settle, next tick may run.
  ticks[0]!();
  await flushEventLoopTurns(10);
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

    const { scheduler, ticks } = manualScheduler();
    const keepalive = createOAuthKeepalive({
      providers: ["kimi-coding"],
      scheduler,
    });

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
    assert.equal(ticks.length, 1);

    // Generation-0 tick: refresh starts and is held open (ignores abort).
    ticks[0]!();
    await flushEventLoopTurns(5);
    assert.deepEqual(refreshStarted, [0]);
    assert.equal(active, 1);

    // stop→start: new generation interval; old refresh still unsettled.
    keepalive.stop();
    keepalive.start({ modelRegistry });
    assert.equal(ticks.length, 1, "restart must schedule exactly one new interval");

    // New-generation tick while old refresh still in flight — must be skipped.
    ticks[0]!();
    await flushEventLoopTurns(5);
    assert.deepEqual(refreshStarted, [0], "new tick must not start while old refresh unsettled");
    assert.equal(maxConcurrent, 1);

    // Old call settles; next tick may run.
    releaseOld();
    await flushEventLoopTurns(10);
    assert.deepEqual(refreshSettled, [0]);

    ticks[0]!();
    await flushEventLoopTurns(10);
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
    const { scheduler, ticks } = manualScheduler();
    let attempts = 0;
    const keepalive = createOAuthKeepalive({
      providers: ["kimi-coding"],
      scheduler,
    });
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

    await fireTick(ticks, 0);
    assert.equal(attempts, 1);
    assert.equal(warningCount, 1, "exactly one warning per failed tick/provider");

    // Interval still alive — next tick retries (no circuit breaker).
    await fireTick(ticks, 0);
    assert.equal(attempts, 2);
    assert.equal(warningCount, 2);

    keepalive.stop();
    assert.equal(ticks.length, 0);
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
    const { scheduler, ticks } = manualScheduler();
    let attempts = 0;
    const keepalive = createOAuthKeepalive({
      providers: ["kimi-coding"],
      scheduler,
    });
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

    await fireTick(ticks, 0);
    assert.equal(attempts, 1);
    assert.equal(notificationTypes.length, 1, "ui.notify must receive exactly one warning");
    assert.equal(notificationTypes[0], "warning");
    assert.equal(
      consoleWarningCount,
      0,
      "must not also console.warn when ui.notify is available",
    );

    // No immediate retry / no circuit breaker — next natural tick tries again.
    await fireTick(ticks, 0);
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
    const { scheduler, ticks } = manualScheduler();
    const keepalive = createOAuthKeepalive({
      providers: ["kimi-coding"],
      scheduler,
    });
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

    await fireTick(ticks, 0);
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

        const { scheduler, ticks } = manualScheduler();
        const seenProviders: string[][] = [];
        const keepalive = createOAuthKeepalive({ providers, scheduler });
        keepalive.start({
          modelRegistry: {
            async refresh(options) {
              seenProviders.push([...(options?.providers ?? [])]);
              return { aborted: false, errors: new Map<string, Error>() };
            },
          },
        });

        await fireTick(ticks, 0);
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
