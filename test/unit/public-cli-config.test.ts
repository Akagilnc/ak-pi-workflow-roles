import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  effectiveSeatConfigurations,
  loadPublicCliConfig,
  publicCliConfigPath,
  resolveEffectiveSeat,
  savePublicCliConfig,
  setPersistentSeatConfig,
  type CredentialProviders,
  type PublicCliConfig,
} from "../../src/public-cli/config.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-public-cli-config-"));
  try {
    return await scenario(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("bulk persistent configuration survives a new process boundary", async () => {
  await withTempHome(async (home) => {
    let config: PublicCliConfig = { seats: {} };
    config = setPersistentSeatConfig(config, "judge", {
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "high",
    });
    config = setPersistentSeatConfig(config, "navigator", {
      provider: "xai",
      model: "grok-4.5",
      thinking: "medium",
    });
    await savePublicCliConfig(config, home);

    // New process boundary: reload from the same home path with a fresh read.
    const reloaded = await loadPublicCliConfig(home);
    assert.deepEqual(reloaded.seats.judge, {
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "high",
    });
    assert.deepEqual(reloaded.seats.navigator, {
      provider: "xai",
      model: "grok-4.5",
      thinking: "medium",
    });
    assert.equal(publicCliConfigPath(home).endsWith("public-cli.json"), true);
    const raw = JSON.parse(await readFile(publicCliConfigPath(home), "utf8")) as PublicCliConfig;
    assert.deepEqual(raw.seats.judge?.model, "gpt-5.6-sol");
  });
});

test("command-local model/thinking overrides do not rewrite persistent configuration", async () => {
  await withTempHome(async (home) => {
    let config: PublicCliConfig = { seats: {} };
    config = setPersistentSeatConfig(config, "coder", {
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      thinking: "high",
    });
    await savePublicCliConfig(config, home);

    const credentials: CredentialProviders = { "openai-codex": true, xai: true };
    const before = await readFile(publicCliConfigPath(home), "utf8");
    const effective = resolveEffectiveSeat(
      await loadPublicCliConfig(home),
      "coder",
      credentials,
      {
        model: "xai/grok-4.5",
        thinking: "medium",
      },
    );
    assert.equal(effective.source, "invocation");
    assert.deepEqual(effective.selection, {
      provider: "xai",
      model: "grok-4.5",
      thinking: "medium",
    });
    const after = await readFile(publicCliConfigPath(home), "utf8");
    assert.equal(after, before);
    const persisted = await loadPublicCliConfig(home);
    assert.deepEqual(persisted.seats.coder, {
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      thinking: "high",
    });
  });
});

test("effective seats prefer credentials: codex-only, xai-only, both prefers codex, neither unconfigured", () => {
  const empty: PublicCliConfig = { seats: {} };

  const codexOnly = effectiveSeatConfigurations(empty, { "openai-codex": true, xai: false });
  assert.equal(codexOnly.find((s) => s.seat === "judge")?.source, "startup");
  assert.deepEqual(codexOnly.find((s) => s.seat === "judge")?.selection, {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    thinking: "high",
  });
  assert.deepEqual(codexOnly.find((s) => s.seat === "navigator")?.selection, {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    thinking: "medium",
  });

  const xaiOnly = effectiveSeatConfigurations(empty, { "openai-codex": false, xai: true });
  assert.deepEqual(xaiOnly.find((s) => s.seat === "judge")?.selection, {
    provider: "xai",
    model: "grok-4.5",
    thinking: "high",
  });

  const both = effectiveSeatConfigurations(empty, { "openai-codex": true, xai: true });
  assert.equal(both.find((s) => s.seat === "coder")?.selection?.provider, "openai-codex");

  const neither = effectiveSeatConfigurations(empty, { "openai-codex": false, xai: false });
  assert.equal(neither.find((s) => s.seat === "judge")?.source, "unconfigured");
  assert.equal(neither.find((s) => s.seat === "judge")?.selection, undefined);

  const seats = neither.map((s) => s.seat);
  assert.deepEqual(seats, [
    "judge",
    "fixer",
    "coder",
    "reviewer",
    "collector",
    "doctor",
    "merger",
    "navigator",
  ]);
  assert.equal(seats.includes("auditor" as never), false);
});

test("persistent seat config wins over startup candidates", () => {
  const config = setPersistentSeatConfig(
    { seats: {} },
    "fixer",
    { provider: "xai", model: "grok-4.5", thinking: "high" },
  );
  const effective = resolveEffectiveSeat(config, "fixer", {
    "openai-codex": true,
    xai: true,
  });
  assert.equal(effective.source, "persistent");
  assert.deepEqual(effective.selection, {
    provider: "xai",
    model: "grok-4.5",
    thinking: "high",
  });
});
