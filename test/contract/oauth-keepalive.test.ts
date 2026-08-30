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
import { createPiRoleRuntimeExtension as createRoleRuntimeExtension } from "../../src/pi/adapter.ts";
import {
  flushEventLoopTurns,
  withHermeticHome,
  withInProcessPi,
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

function minimalRoleDeps(oauthKeepalive?: {
  providers?: readonly string[];
  intervalMs?: number;
  scheduler?: OAuthKeepaliveScheduler;
}) {
  return {
    loadJudgeSoul: async () => "judge",
    transcriptFromContext: () => "",
    auditSoulCompliance: async () => ({ status: "pass" as const }),
    ...(oauthKeepalive === undefined ? {} : { oauthKeepalive }),
  };
}

async function fireTick(ticks: Array<() => void>, index = 0): Promise<void> {
  assert.ok(ticks[index], `expected scheduled tick at index ${index}`);
  ticks[index]!();
  // Allow the async runTick body (and nested refresh) to settle.
  await flushEventLoopTurns(30);
}

test(
  "#351 e2e success: real session entry → ≥2 expiry windows → oauth.refresh ≥2 → next model request succeeds",
  async () => {
    await withHermeticHome({ prefix: "ak-oauth-keepalive-e2e-" }, async ({ home, agentDir }) => {
      const { scheduler, ticks } = manualScheduler();
      const counters: OAuthCounters = { refreshCount: 0, networkCalls: 0, lastAccess: undefined };
      const faux = fauxProvider({
        api: "ak-oauth-keepalive-e2e",
        provider: "kimi-coding",
        tokenSize: { min: 1000, max: 1000 },
      });
      const provider = createOAuthMockProvider({ id: "kimi-coding", faux, counters });
      const credentials = new InMemoryCredentialStore();
      await credentials.modify("kimi-coding", async () => oauthCredential());

      await withInProcessPi(
        {
          cwd: home,
          agentDir,
          faux,
          provider,
          credentials,
          modelsPath: null,
          noExtensions: true,
          noTools: "builtin",
          systemPrompt: "OAUTH KEEPALIVE E2E",
          mode: "print",
          flags: {},
          extensionFactories: [
            createRoleRuntimeExtension(
              minimalRoleDeps({ providers: ["kimi-coding"], scheduler }),
            ),
          ],
        },
        async ({ session }) => {
          // Session start already hung the interval; first tick is deferred (setInterval semantics).
          assert.equal(ticks.length, 1, "session_start must schedule exactly one keepalive interval");
          assert.equal(counters.refreshCount, 0, "no refresh before first tick");

          // Window 1: expired → refresh
          await fireTick(ticks, 0);
          assert.equal(counters.refreshCount, 1);
          assert.equal(counters.networkCalls, 1);

          // Window 2: re-expire stored credential, fire next tick
          await credentials.modify("kimi-coding", async (current) => {
            assert.ok(current?.type === "oauth");
            return { ...current, expires: Date.now() - 1 };
          });
          await fireTick(ticks, 0);
          assert.equal(counters.refreshCount, 2, "second expiry window must drive oauth.refresh again");
          assert.equal(counters.networkCalls, 2);

          // External success: model request through this session after keepalive renewals.
          // Extra scripted response absorbs any post-turn envelope follow-up (receipt nudge).
          faux.setResponses([
            fauxAssistantMessage("keepalive-ok"),
            fauxAssistantMessage("follow-up-absorbed"),
          ]);
          await session.prompt("ping after keepalive");
          const assistantTexts = session.messages
            .filter((m) => m.role === "assistant")
            .map((m) =>
              "content" in m && Array.isArray(m.content)
                ? m.content
                    .filter((block): block is { type: "text"; text: string } => block.type === "text")
                    .map((block) => block.text)
                    .join("")
                : "",
            );
          assert.ok(
            assistantTexts.some((text) => text.includes("keepalive-ok")),
            `session prompt must return keepalive-ok; got ${JSON.stringify(assistantTexts)}`,
          );
        },
      );
    });
  },
);

test(
  "#351 non-target provider: keepalive providers filter leaves unconfigured oauth refresh at 0",
  async () => {
    await withHermeticHome({ prefix: "ak-oauth-keepalive-nontarget-" }, async ({ home, agentDir }) => {
      const { scheduler, ticks } = manualScheduler();
      const target: OAuthCounters = { refreshCount: 0, networkCalls: 0, lastAccess: undefined };
      const side: OAuthCounters = { refreshCount: 0, networkCalls: 0, lastAccess: undefined };
      const faux = fauxProvider({
        api: "ak-oauth-keepalive-nontarget",
        provider: "kimi-coding",
        tokenSize: { min: 1000, max: 1000 },
      });
      const targetProvider = createOAuthMockProvider({ id: "kimi-coding", faux, counters: target });
      const sideFaux = fauxProvider({
        api: "ak-oauth-keepalive-side",
        provider: "side-oauth",
        tokenSize: { min: 1000, max: 1000 },
      });
      const sideProvider = createOAuthMockProvider({ id: "side-oauth", faux: sideFaux, counters: side });
      const credentials = new InMemoryCredentialStore();
      await credentials.modify("kimi-coding", async () => oauthCredential());
      await credentials.modify("side-oauth", async () => oauthCredential({ access: "side-expired" }));

      await withInProcessPi(
        {
          cwd: home,
          agentDir,
          faux,
          provider: targetProvider,
          credentials,
          modelsPath: null,
          noExtensions: true,
          noTools: "builtin",
          systemPrompt: "OAUTH KEEPALIVE NONTARGET",
          mode: "print",
          flags: {},
          extensionFactories: [
            createRoleRuntimeExtension(
              minimalRoleDeps({ providers: ["kimi-coding"], scheduler }),
            ),
          ],
        },
        async ({ modelRuntime }) => {
          // Register side provider after bindExtensions; ticks not yet fired.
          modelRuntime.registerNativeProvider(sideProvider);
          await modelRuntime.refresh({ allowNetwork: false });

          await fireTick(ticks, 0);
          assert.equal(target.refreshCount, 1, "configured provider is refreshed");
          assert.equal(side.refreshCount, 0, "unconfigured provider oauth.refresh must stay 0");
          assert.equal(side.networkCalls, 0, "unconfigured provider must see zero network");
        },
      );
    });
  },
);

test("#351 shutdown: session_shutdown then advance scheduler yields zero further ticks", async () => {
  await withHermeticHome({ prefix: "ak-oauth-keepalive-shutdown-" }, async ({ home, agentDir }) => {
    const { scheduler, ticks } = manualScheduler();
    const counters: OAuthCounters = { refreshCount: 0, networkCalls: 0, lastAccess: undefined };
    const faux = fauxProvider({
      api: "ak-oauth-keepalive-shutdown",
      provider: "kimi-coding",
      tokenSize: { min: 1000, max: 1000 },
    });
    const provider = createOAuthMockProvider({ id: "kimi-coding", faux, counters });
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("kimi-coding", async () => oauthCredential());

    await withInProcessPi(
      {
        cwd: home,
        agentDir,
        faux,
        provider,
        credentials,
        modelsPath: null,
        noExtensions: true,
        noTools: "builtin",
        systemPrompt: "OAUTH KEEPALIVE SHUTDOWN",
        mode: "print",
        flags: {},
        // Emit production session_shutdown on teardown (same hook keepalive owns).
        reviewerShutdown: true,
        extensionFactories: [
          createRoleRuntimeExtension(
            minimalRoleDeps({ providers: ["kimi-coding"], scheduler }),
          ),
        ],
      },
      async ({ session }) => {
        await fireTick(ticks, 0);
        assert.equal(counters.refreshCount, 1);
        const afterFirst = counters.refreshCount;

        // Production shutdown path.
        await session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
        // Cancel removes the tick; advancing must be a no-op.
        assert.equal(ticks.length, 0, "stop must clear scheduled interval");
        // Even if a stale tick reference were held, stop aborts further work —
        // here the cancel already removed it.
        assert.equal(counters.refreshCount, afterFirst);
      },
    );
  });
});

test("#351 unexpired window: tick is no-op (zero network / zero oauth.refresh)", async () => {
  await withHermeticHome({ prefix: "ak-oauth-keepalive-fresh-" }, async ({ home, agentDir }) => {
    const { scheduler, ticks } = manualScheduler();
    const counters: OAuthCounters = { refreshCount: 0, networkCalls: 0, lastAccess: undefined };
    const faux = fauxProvider({
      api: "ak-oauth-keepalive-fresh",
      provider: "kimi-coding",
      tokenSize: { min: 1000, max: 1000 },
    });
    const provider = createOAuthMockProvider({ id: "kimi-coding", faux, counters });
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("kimi-coding", async () =>
      oauthCredential({
        access: "still-valid",
        expires: Date.now() + 30 * 60_000,
      }),
    );

    await withInProcessPi(
      {
        cwd: home,
        agentDir,
        faux,
        provider,
        credentials,
        modelsPath: null,
        noExtensions: true,
        noTools: "builtin",
        systemPrompt: "OAUTH KEEPALIVE FRESH",
        mode: "print",
        flags: {},
        extensionFactories: [
          createRoleRuntimeExtension(
            minimalRoleDeps({ providers: ["kimi-coding"], scheduler }),
          ),
        ],
      },
      async () => {
        await fireTick(ticks, 0);
        assert.equal(counters.refreshCount, 0, "unexpired token must not call oauth.refresh");
        assert.equal(counters.networkCalls, 0, "unexpired token must yield zero network");
      },
    );
  });
});

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

test("#351 error path: refresh rejection emits one warning with provider + error class; interval continues", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
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
    assert.equal(warnings.length, 1, "exactly one warning per failed tick/provider");
    assert.match(warnings[0]!, /kimi-coding/);
    assert.match(warnings[0]!, /TokenEndpointError/);

    // Interval still alive — next tick retries (no circuit breaker).
    await fireTick(ticks, 0);
    assert.equal(attempts, 2);
    assert.equal(warnings.length, 2);

    keepalive.stop();
    assert.equal(ticks.length, 0);
  } finally {
    console.warn = originalWarn;
  }
});

test("#351 dual surface: ui.notify + console both available → exactly one visible warning", async () => {
  const consoleWarnings: string[] = [];
  const notifications: string[] = [];
  const notificationTypes: Array<string | undefined> = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    consoleWarnings.push(args.map(String).join(" "));
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
        notify(message, type) {
          notifications.push(message);
          notificationTypes.push(type);
        },
      },
    });

    await fireTick(ticks, 0);
    assert.equal(attempts, 1);
    assert.equal(notifications.length, 1, "ui.notify must receive exactly one warning");
    assert.equal(notificationTypes[0], "warning");
    assert.match(notifications[0]!, /kimi-coding/);
    assert.match(notifications[0]!, /TokenEndpointError/);
    assert.equal(
      consoleWarnings.length,
      0,
      "must not also console.warn when ui.notify is available",
    );

    // No immediate retry / no circuit breaker — next natural tick tries again.
    await fireTick(ticks, 0);
    assert.equal(attempts, 2);
    assert.equal(notifications.length, 2);
    assert.equal(consoleWarnings.length, 0);

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
    const [text, cause] = consoleArgs[0]!;
    assert.equal(typeof text, "string");
    assert.match(String(text), /kimi-coding/);
    assert.match(String(text), /TokenEndpointError/);
    assert.equal(cause, notifyBoom, "fallback must carry the notify throw cause");

    keepalive.stop();
  } finally {
    console.warn = originalWarn;
  }
});

test(
  "#351 production setting seam: non-default oauth-keepalive.json drives real session refresh filter",
  async () => {
    await withHermeticHome({ prefix: "ak-oauth-keepalive-setting-" }, async ({ home, agentDir }) => {
      // Default-provider read branch (absorbed from the former constants test):
      // with no oauth-keepalive.json present, the production reader falls back
      // to the default provider set — a real ENOENT branch, not a constant pin.
      const defaults = readOAuthKeepaliveProviders();
      assert.deepEqual([...defaults], ["kimi-coding"]);

      // Production extension root reads this file via readOAuthKeepaliveProviders().
      await writeFile(
        join(agentDir, OAUTH_KEEPALIVE_SETTING_FILENAME),
        `${JSON.stringify({ providers: ["custom-oauth"] })}\n`,
        "utf8",
      );
      const providers = readOAuthKeepaliveProviders();
      assert.deepEqual(
        [...providers],
        ["custom-oauth"],
        "production setting reader must surface non-default providers",
      );

      const { scheduler, ticks } = manualScheduler();
      const custom: OAuthCounters = { refreshCount: 0, networkCalls: 0, lastAccess: undefined };
      const side: OAuthCounters = { refreshCount: 0, networkCalls: 0, lastAccess: undefined };
      const faux = fauxProvider({
        api: "ak-oauth-keepalive-setting",
        provider: "custom-oauth",
        tokenSize: { min: 1000, max: 1000 },
      });
      const customProvider = createOAuthMockProvider({ id: "custom-oauth", faux, counters: custom });
      const sideFaux = fauxProvider({
        api: "ak-oauth-keepalive-setting-side",
        provider: "kimi-coding",
        tokenSize: { min: 1000, max: 1000 },
      });
      const sideProvider = createOAuthMockProvider({ id: "kimi-coding", faux: sideFaux, counters: side });
      const credentials = new InMemoryCredentialStore();
      await credentials.modify("custom-oauth", async () => oauthCredential());
      await credentials.modify("kimi-coding", async () => oauthCredential({ access: "kimi-expired" }));

      await withInProcessPi(
        {
          cwd: home,
          agentDir,
          faux,
          provider: customProvider,
          credentials,
          modelsPath: null,
          noExtensions: true,
          noTools: "builtin",
          systemPrompt: "OAUTH KEEPALIVE SETTING",
          mode: "print",
          flags: {},
          extensionFactories: [
            // Same production seam: setting-read providers enter createRoleRuntimeExtension.
            createRoleRuntimeExtension(
              minimalRoleDeps({ providers, scheduler }),
            ),
          ],
        },
        async ({ modelRuntime }) => {
          modelRuntime.registerNativeProvider(sideProvider);
          await modelRuntime.refresh({ allowNetwork: false });

          await fireTick(ticks, 0);
          assert.equal(custom.refreshCount, 1, "configured non-default provider must refresh");
          assert.equal(side.refreshCount, 0, "default kimi-coding must stay zero when not in setting");
          assert.equal(side.networkCalls, 0);
        },
      );
    });
  },
);

test(
  "#351 setting whitespace: padded provider id is normalized into refresh providers",
  async () => {
    await withHermeticHome(
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
