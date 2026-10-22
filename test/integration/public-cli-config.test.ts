import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";

import {
  runAkRole,
  projectConfigDisplaySeats,
  projectConfigSeatDisplay,
} from "../../src/public-cli/cli.ts";
import {
  clearPersistentSeatConfig,
  effectiveSeatConfigurations,
  loadPublicCliConfig,
  publicCliConfigPath,
  resolveEffectiveSeat,
  savePublicCliConfig,
  setPersistentSeatConfig,
  setPersistentSeatEngine,
  type CredentialProviders,
  type PublicCliConfig,
} from "../../src/public-cli/config.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("ak-public-cli-config-", scenario);
}

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
    seedGitProject(home);
    let selected: unknown;
    const result = await runAkRole([
      "coder", "plan", "--project", home,
      "--model", "xai/grok-4.5", "--thinking", "medium", "Plan the repair.",
    ], {
      packageRoot, home, cwd: home, credentials, io: captureIo().io,
      roleTurnHost: {
        async executeTurn(request) {
          selected = request.model;
          return { code: 0, stderr: "", timedOut: false };
        },
      },
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(selected, {
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

const CODEX_CREDS: CredentialProviders = { "openai-codex": true, xai: true };

// #620 config display projection boundaries (persistent face; inherit only when earned).
test("#620 config display: inherit only under gatekeeper; coder-only stays disk face", () => {
  const coderOnly = projectConfigDisplaySeats({
    seats: {
      coder: { provider: "xai", model: "grok-4.5", thinking: "high" },
    },
  });
  assert.deepEqual(
    coderOnly.map((row) => row.seat),
    ["coder"],
  );
  assert.equal(coderOnly[0]?.source, "persistent");
  assert.equal(projectConfigSeatDisplay({ seats: {} }, "notary").source, "unconfigured");
  assert.equal(projectConfigSeatDisplay({ seats: {} }, "judge").source, "unconfigured");

  const withGate = projectConfigDisplaySeats({
    seats: {
      gatekeeper: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "low" },
    },
  });
  assert.equal(
    withGate.find((row) => row.seat === "notary")?.source,
    "inherit-gatekeeper",
  );
  assert.deepEqual(withGate.find((row) => row.seat === "inspector")?.selection, {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    thinking: "low",
  });
  // judge absent from disk and not a subordinate — not invented on config face.
  assert.equal(
    withGate.some((row) => row.seat === "judge"),
    false,
  );
});

// #620: direct path consumes institutional authority (own > gatekeeper > unconfigured).
test("#620 subordinate seats: own persistent > inherit-gatekeeper > unconfigured (no startup)", () => {
  const empty: PublicCliConfig = { seats: {} };
  assert.equal(resolveEffectiveSeat(empty, "notary", CODEX_CREDS).source, "unconfigured");
  assert.equal(resolveEffectiveSeat(empty, "inspector", CODEX_CREDS).source, "unconfigured");
  assert.equal(resolveEffectiveSeat(empty, "notary", CODEX_CREDS).selection, undefined);

  const gateOnly = setPersistentSeatConfig(empty, "gatekeeper", {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    thinking: "low",
  });
  const inheritedNotary = resolveEffectiveSeat(gateOnly, "notary", CODEX_CREDS);
  assert.equal(inheritedNotary.source, "inherit-gatekeeper");
  assert.deepEqual(inheritedNotary.selection, {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    thinking: "low",
  });
  const inheritedInspector = resolveEffectiveSeat(gateOnly, "inspector", CODEX_CREDS);
  assert.equal(inheritedInspector.source, "inherit-gatekeeper");
  assert.deepEqual(inheritedInspector.selection, inheritedNotary.selection);

  let both = setPersistentSeatConfig(gateOnly, "inspector", {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    thinking: "medium",
  });
  both = setPersistentSeatConfig(both, "notary", {
    provider: "xai",
    model: "grok-4.5",
    thinking: "high",
  });
  assert.equal(resolveEffectiveSeat(both, "gatekeeper", CODEX_CREDS).source, "persistent");
  assert.deepEqual(resolveEffectiveSeat(both, "inspector", CODEX_CREDS).selection, {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    thinking: "medium",
  });
  assert.equal(resolveEffectiveSeat(both, "inspector", CODEX_CREDS).source, "persistent");
  assert.deepEqual(resolveEffectiveSeat(both, "notary", CODEX_CREDS).selection, {
    provider: "xai",
    model: "grok-4.5",
    thinking: "high",
  });
  assert.equal(resolveEffectiveSeat(both, "notary", CODEX_CREDS).source, "persistent");

  // Gatekeeper change must not move an explicit subordinate pin.
  const gateMoved = setPersistentSeatConfig(both, "gatekeeper", {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    thinking: "xhigh",
  });
  assert.deepEqual(resolveEffectiveSeat(gateMoved, "notary", CODEX_CREDS).selection, {
    provider: "xai",
    model: "grok-4.5",
    thinking: "high",
  });
});

test("#620 clearing subordinate model restores gatekeeper inheritance on direct path", async () => {
  await withTempHome(async (home) => {
    let config = setPersistentSeatConfig(
      { seats: {} },
      "gatekeeper",
      { provider: "xai", model: "grok-4.5", thinking: "high" },
    );
    config = setPersistentSeatConfig(config, "inspector", {
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "medium",
    });
    await savePublicCliConfig(config, home);

    config = clearPersistentSeatConfig(await loadPublicCliConfig(home), "inspector");
    await savePublicCliConfig(config, home);
    const reloaded = await loadPublicCliConfig(home);
    assert.equal(reloaded.seats.inspector, undefined);
    assert.deepEqual(reloaded.seats.gatekeeper, {
      provider: "xai",
      model: "grok-4.5",
      thinking: "high",
    });
    const inspector = resolveEffectiveSeat(reloaded, "inspector", CODEX_CREDS);
    assert.equal(inspector.source, "inherit-gatekeeper");
    assert.deepEqual(inspector.selection, {
      provider: "xai",
      model: "grok-4.5",
      thinking: "high",
    });

    config = clearPersistentSeatConfig(reloaded, "gatekeeper");
    await savePublicCliConfig(config, home);
    const cleared = await loadPublicCliConfig(home);
    assert.equal(cleared.seats.gatekeeper, undefined);
    assert.equal(resolveEffectiveSeat(cleared, "gatekeeper", CODEX_CREDS).source, "unconfigured");
    assert.equal(resolveEffectiveSeat(cleared, "inspector", CODEX_CREDS).source, "unconfigured");

    // Idempotent clear of an already-absent seat.
    assert.deepEqual(clearPersistentSeatConfig(cleared, "gatekeeper"), cleared);
  });
});

test("#453/#620 clear notary model keeps engine; inherits gatekeeper; no startup fallback", async () => {
  await withTempHome(async (home) => {
    let config = setPersistentSeatConfig(
      { seats: {} },
      "gatekeeper",
      { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "low" },
    );
    config = setPersistentSeatConfig(config, "notary", {
      provider: "xai",
      model: "grok-4.5",
      thinking: "high",
    });
    config = setPersistentSeatEngine(config, "notary", "opus");
    await savePublicCliConfig(config, home);

    config = clearPersistentSeatConfig(await loadPublicCliConfig(home), "notary");
    await savePublicCliConfig(config, home);
    const reloaded = await loadPublicCliConfig(home);

    // Model axis cleared; engine residual remains.
    assert.deepEqual(reloaded.seats.notary, { engine: "opus" });

    const direct = resolveEffectiveSeat(reloaded, "notary", CODEX_CREDS);
    assert.equal(direct.source, "inherit-gatekeeper");
    assert.deepEqual(direct.selection, {
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "low",
    });
    assert.equal(direct.engine, "opus");
    assert.equal(direct.engineSource, "persistent");

    // Clearing engine from engine-only residual must drop the empty row
    // (never write parse-rejected {} to disk).
    config = setPersistentSeatEngine(reloaded, "notary", undefined);
    await savePublicCliConfig(config, home);
    const emptied = await loadPublicCliConfig(home);
    assert.equal(emptied.seats.notary, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(emptied.seats, "notary"), false);
  });
});

// #453: engine-only residual ownership is notary/inspector at the persist boundary.
test("#453 non-notary engine-only residual is rejected on persist boundary", async () => {
  await withTempHome(async (home) => {
    await assert.rejects(
      () => savePublicCliConfig({ seats: { judge: { engine: "opus" } } }, home),
      Error,
    );
  });
});

// #592: shared public-cli.json may carry seat keys a newer CLI wrote that this
// build does not know. Read path skips them; known seats still resolve.
test("load skips unknown seat keys without failing the shared config", async () => {
  await withTempHome(async (home) => {
    const path = publicCliConfigPath(home);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify(
        {
          seats: {
            judge: {
              provider: "openai-codex",
              model: "gpt-5.6-sol",
              thinking: "high",
            },
            // Seat key no build of this package ever ships — stands in for a
            // newer-line row (e.g. countersign before this build knew it).
            "future-seat-from-newer-cli": {
              provider: "openai-codex",
              model: "gpt-5.6-sol",
              thinking: "high",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const loaded = await loadPublicCliConfig(home);
    assert.deepEqual(loaded.seats.judge, {
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "high",
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(loaded.seats, "future-seat-from-newer-cli"),
      false,
    );

    const credentials: CredentialProviders = {
      "openai-codex": true,
      xai: false,
    };
    const effective = resolveEffectiveSeat(loaded, "judge", credentials);
    assert.equal(effective.source, "persistent");
    assert.deepEqual(effective.selection, {
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "high",
    });

    // Unknown key must not appear among effective seats this CLI owns.
    const all = effectiveSeatConfigurations(loaded, credentials);
    assert.equal(
      all.some((entry) => (entry.seat as string) === "future-seat-from-newer-cli"),
      false,
    );
    assert.equal(all.find((entry) => entry.seat === "judge")?.source, "persistent");
  });
});

// #592 write-path: unknown seat rows must survive load→set→save the same way
// #422 keeps sibling top-level keys — shared-file neighbor lines must not be
// silently erased by any config write from this build.
test("unknown seat rows survive set→save without entering resolve/enum", async () => {
  await withTempHome(async (home) => {
    const path = publicCliConfigPath(home);
    await mkdir(dirname(path), { recursive: true });
    const foreignRow = {
      provider: "openai-codex",
      model: "gpt-future",
      thinking: "high",
      // Extra field a newer line may write; must round-trip byte-faithful as JSON value.
      futureAxis: "keep-me",
    };
    await writeFile(
      path,
      `${JSON.stringify(
        {
          seats: {
            judge: {
              provider: "openai-codex",
              model: "gpt-5.6-sol",
              thinking: "high",
            },
            "future-seat-from-newer-cli": foreignRow,
          },
          autoResumeLimit: 4,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    let config = await loadPublicCliConfig(home);
    // Read consumption still skips unknown seats from the owned seats map.
    assert.equal(
      Object.prototype.hasOwnProperty.call(config.seats, "future-seat-from-newer-cli"),
      false,
    );

    // Real write path used by `config set`: mutate a known seat, then save.
    config = setPersistentSeatConfig(config, "judge", {
      provider: "xai",
      model: "grok-4.5",
      thinking: "medium",
    });
    await savePublicCliConfig(config, home);

    const raw = JSON.parse(await readFile(path, "utf8")) as {
      seats: Record<string, unknown>;
      autoResumeLimit?: number;
      unknownSeats?: unknown;
    };
    // Disk shape stays seats-only for foreign rows — no parallel top-level dump.
    assert.equal(Object.prototype.hasOwnProperty.call(raw, "unknownSeats"), false);
    assert.deepEqual(raw.seats["future-seat-from-newer-cli"], foreignRow);
    assert.deepEqual(raw.seats.judge, {
      provider: "xai",
      model: "grok-4.5",
      thinking: "medium",
    });
    // #422 sibling must still survive the same write.
    assert.equal(raw.autoResumeLimit, 4);

    const reloaded = await loadPublicCliConfig(home);
    assert.equal(
      Object.prototype.hasOwnProperty.call(reloaded.seats, "future-seat-from-newer-cli"),
      false,
    );
    const credentials: CredentialProviders = { "openai-codex": true, xai: true };
    assert.equal(
      effectiveSeatConfigurations(reloaded, credentials).some(
        (entry) => (entry.seat as string) === "future-seat-from-newer-cli",
      ),
      false,
    );
    assert.equal(
      resolveEffectiveSeat(reloaded, "judge", credentials).source,
      "persistent",
    );
  });
});

