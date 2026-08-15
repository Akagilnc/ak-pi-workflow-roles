import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  effectiveSeatConfigurations,
  formatModelSpec,
  loadPublicCliConfig,
  parseModelSpec,
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

// #346: public CLI --model :thinking suffix is optional on invocation.
test("bare provider/model invocation is legal and does not invent thinking", () => {
  const bare = parseModelSpec("kimi-coding/k3-256k");
  assert.deepEqual(bare, {
    provider: "kimi-coding",
    model: "k3-256k",
  });
  assert.equal("thinking" in bare, false);
  assert.equal(formatModelSpec(bare), "kimi-coding/k3-256k");

  const effective = resolveEffectiveSeat(
    { seats: {} },
    "coder",
    { "openai-codex": true, xai: false },
    { model: "kimi-coding/k3-256k" },
  );
  assert.equal(effective.source, "invocation");
  assert.deepEqual(effective.selection, {
    provider: "kimi-coding",
    model: "k3-256k",
  });
  assert.equal(effective.selection !== undefined && "thinking" in effective.selection, false);
});

test("provider/model:thinking suffix still parses and formats with thinking", () => {
  const withThinking = parseModelSpec("openai-codex/gpt-5.6-luna:high");
  assert.deepEqual(withThinking, {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    thinking: "high",
  });
  assert.equal(formatModelSpec(withThinking), "openai-codex/gpt-5.6-luna:high");

  const effective = resolveEffectiveSeat(
    { seats: {} },
    "coder",
    { "openai-codex": true, xai: false },
    { model: "openai-codex/gpt-5.6-luna:medium" },
  );
  assert.deepEqual(effective.selection, {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    thinking: "medium",
  });
});

test("malformed model specs keep the pre-#346 typed rejection surface", () => {
  assert.throws(
    () => parseModelSpec(""),
    /model specification must be non-empty/,
  );
  assert.throws(
    () => parseModelSpec("no-slash-model"),
    /model specification must be provider\/model\[:thinking\]/,
  );
  assert.throws(
    () => parseModelSpec("/missing-provider"),
    /model specification must be provider\/model\[:thinking\]/,
  );
  // Colon present but suffix empty/unknown: typed format reject (not swallowed into model).
  // Index-0 colon (`:provider/model`) must also enter typed suffix rejection.
  assert.throws(
    () => parseModelSpec("openai-codex/gpt-5.6-luna:bogus"),
    /model specification must be provider\/model\[:thinking\]/,
  );
  assert.throws(
    () => parseModelSpec("openai-codex/gpt-5.6-luna:"),
    /model specification must be provider\/model\[:thinking\]/,
  );
  assert.throws(
    () => parseModelSpec(":provider/model"),
    /model specification must be provider\/model\[:thinking\]/,
  );
  // Unknown provider/model is syntactically legal — resolution is not this parser's job.
  assert.deepEqual(parseModelSpec("no-such-provider/no-such-model"), {
    provider: "no-such-provider",
    model: "no-such-model",
  });
});
