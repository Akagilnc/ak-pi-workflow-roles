import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RoleTurnHost } from "../../src/host-contracts.ts";
import { runAkRole, type NamedRoleTurnHostAdapter } from "../../src/public-cli/cli.ts";
import {
  loadPublicCliConfig,
  resolveEffectiveSeat,
  setPersistentSeatConfig,
  setPersistentSeatHost,
} from "../../src/public-cli/config.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

const stoppedHost: RoleTurnHost = { executeTurn: async () => ({ code: 1, stderr: "stop", timedOut: false }) };
const io = { stdout() {}, stderr() {} };
const credentials = { "openai-codex": true, xai: true } as const;

function adapter(name: string, selected: string[], accepts = true): NamedRoleTurnHostAdapter {
  return {
    name,
    create({ role, model }) {
      if (!accepts) return { ok: false, failure: { kind: "host-model-mismatch", host: name, seat: role, model: `${model?.provider}/${model?.model}` } };
      selected.push(name);
      return { ok: true, host: stoppedHost };
    },
  };
}

async function homeTest(fn: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "ak-host-axis-"));
  try { await fn(home); } finally { await rm(home, { recursive: true, force: true }); }
}

const base = (home: string, adapters: readonly NamedRoleTurnHostAdapter[]) => ({ packageRoot, home, credentials, io, hostAdapters: adapters });

test("host priority is flag > persistent > pi default, and injected grok adapter is selected", async () => homeTest(async (home) => {
  let config = setPersistentSeatConfig({ seats: {} }, "judge", {
    provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high",
  });
  const fallback = resolveEffectiveSeat(config, "judge", credentials);
  assert.deepEqual({ host: fallback.host, source: fallback.hostSource }, { host: "pi", source: "default" });
  config = setPersistentSeatHost(config, "judge", "grok-build");
  const persistent = resolveEffectiveSeat(config, "judge", credentials);
  assert.deepEqual({ host: persistent.host, source: persistent.hostSource }, { host: "grok-build", source: "persistent" });
  const explicitPi = resolveEffectiveSeat(config, "judge", credentials, { host: "pi" });
  assert.deepEqual({ host: explicitPi.host, source: explicitPi.hostSource }, { host: "pi", source: "invocation" });

  await runAkRole(["config", "set", "judge", "openai-codex/gpt-5.6-sol:high"], base(home, [adapter("pi", [])]));
  await runAkRole(["config", "set-host", "judge", "grok-build"], base(home, [adapter("pi", [])]));
  assert.equal((await loadPublicCliConfig(home)).seats.judge?.host, "grok-build");
  const selected: string[] = [];
  await runAkRole(["judge", "x"], base(home, [adapter("pi", selected), adapter("grok-build", selected)]));
  assert.deepEqual(selected, ["grok-build"]);
}));

test("host selection failures are typed and stop before role turn", async () => homeTest(async (home) => {
  let turnCalls = 0;
  const countingHost: RoleTurnHost = {
    executeTurn: async () => {
      turnCalls++;
      throw new Error("host selection failure must stop before executeTurn");
    },
  };
  const pi: NamedRoleTurnHostAdapter = { name: "pi", create() { return { ok: true, host: countingHost }; } };
  const missing = await runAkRole(["judge", "--host", "missing", "x"], base(home, [pi]));
  assert.equal(missing.exitCode, 1);
  assert.deepEqual(missing.hostFailure, { kind: "host-unregistered", host: "missing", seat: "judge", model: "openai-codex/gpt-5.6-sol" });
  assert.equal(turnCalls, 0);
  const mismatchAdapter: NamedRoleTurnHostAdapter = {
    name: "grok-build",
    create({ role, model }) {
      void countingHost;
      return { ok: false, failure: { kind: "host-model-mismatch", host: "grok-build", seat: role, model: `${model?.provider}/${model?.model}` } };
    },
  };
  const mismatch = await runAkRole(["judge", "--host", "grok-build", "x"], base(home, [pi, mismatchAdapter]));
  assert.equal(mismatch.exitCode, 1);
  assert.deepEqual(mismatch.hostFailure, { kind: "host-model-mismatch", host: "grok-build", seat: "judge", model: "openai-codex/gpt-5.6-sol" });
  assert.equal(turnCalls, 0);
}));

test("resume refuses --host structurally", async () => homeTest(async (home) => {
  const result = await runAkRole(["resume", "--host", "pi", "run"], base(home, [adapter("pi", [])]));
  assert.equal(result.exitCode, 2);
}));
