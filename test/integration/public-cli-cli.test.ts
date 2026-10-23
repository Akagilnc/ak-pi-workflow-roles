import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readCurrentSection } from "../helpers/run-dossier-fixture.ts";
import { access, readFile, realpath, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { Value } from "typebox/value";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { roleRuntimeDependenciesWithoutNavigator as createRoleRuntimeDependencies } from "../helpers/role-turn-host-fixture.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import { materializeConflictedRepo } from "../helpers/merger-conflict-fixture.ts";
import { sessionDirectoryOf, sessionFileOf } from "../../src/role-run-placement.ts";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import {
  activationBookDirectory,
  resolveActivationLedgerHome,
} from "../../src/activation-ledger-topology.ts";
import {
  buildExplicitInternalActivationArgs,
  resolveInternalRoleEntrypoint,
  runAkRole,
} from "../../src/public-cli/cli.ts";
import {
  loadPublicCliConfig,
  type CredentialProviders,
} from "../../src/public-cli/config.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { INSPECTOR_OUTPUT_TOOL_NAME } from "../../src/inspector-contracts.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import {
  createMinimalHost,
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";
import { withTempHome } from "../helpers/environment-fixtures.ts";
import { objectPayloads} from "../helpers/terminal-payload.ts";


test("Inspector public runner preserves typed converged/continue/escalate, and non-three-state reply", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project);
    seedGitProject(project);
    const attachment = join(project, "material.txt");
    await writeFile(attachment, "frozen review material", "utf8");

    // One nested unknown key on the affected accepted path (#696 sample, not schema).
    const freeExtra = { nested: { ok: true } } as const;
    for (const [index, row] of [
      { status: "converged", exitCode: 0, findings: ["converged-finding"] },
      { status: "continue", exitCode: 0, findings: ["continue-finding"] },
      { status: "escalate", exitCode: 0, findings: ["escalate-finding"] },
      // #757 / ADR 0055: non-three-state is not shape-rejected — reply stays
      // accepted; seat-local unreadable reask may exhaust before present.
      { status: "unknown", exitCode: 0, findings: "unaltered" as unknown },
    ].entries()) {
      const runId = `inspector-public-${index}`;
      const details = row.status === "converged"
        ? { status: row.status, findings: row.findings, freeExtra }
        : { status: row.status, findings: row.findings };
      const result = await runAkRole([
          "inspector", "--model", "test/caller-seat:high",
          "--project", project,
          "--attach", attachment,
          "Review this material.",
        ],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => runId,
          io: captureIo().io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: scriptedTerminatingToolSession({
              role: "inspector",
              toolName: INSPECTOR_OUTPUT_TOOL_NAME,
              details,
            }),
          }),
        },
      );

      assert.equal(result.exitCode, row.exitCode);
      assert.ok(result.terminal);
      const outcome = result.terminal.roleOutcome;
      // #753 escalate-thrown-verbatim: escalate seals accepted + raw receipt —
      // no audit_escalation rewrite, no fabricated reason when absent.
      assert.equal(outcome.kind, "accepted");
      if (outcome.kind !== "accepted") throw new Error("expected accepted Inspector output");
      assert.equal((objectPayloads(outcome)[0] ?? {}).status, row.status);
      assert.deepEqual((objectPayloads(outcome)[0] ?? {}).findings, row.findings);
      if (row.status === "converged") {
        assert.deepEqual((objectPayloads(outcome)[0] ?? {}).freeExtra, freeExtra);
      }
      if (row.status === "escalate") {
        assert.equal((objectPayloads(outcome)[0] ?? {}).reason, undefined);
      }
    }
  });
});

// CLI config writes are observed through the stored document, not TSV presentation.
test("CLI config commands persist and local roles reads do not rewrite disk", async () => {
  await withTempHome(async (home) => {
    // Fresh home: roles exits zero. Bulk config set is visible via config bytes.
    const fresh = await runAkRole(["roles"], {
      packageRoot,
      home,
      credentials: { "openai-codex": true, xai: false },
      io: captureIo().io,
    });
    assert.equal(fresh.exitCode, 0);

    // Later CLI calls reload the stored config bytes.
    const setResult = await runAkRole(
      [
        "config",
        "set",
        "judge",
        "xai/grok-4.5:high",
        "navigator",
        "openai-codex/gpt-5.6-luna:medium",
      ],
      { packageRoot, home, io: captureIo().io },
    );
    assert.equal(setResult.exitCode, 0);
    const persisted = await loadPublicCliConfig(home);
    assert.deepEqual(persisted.seats.judge, {
      provider: "xai",
      model: "grok-4.5",
      thinking: "high",
    });
    assert.deepEqual(persisted.seats.navigator, {
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      thinking: "medium",
    });

    const rolesResult = await runAkRole(["roles"], {
      packageRoot,
      home,
      credentials: { "openai-codex": true, xai: true },
      io: captureIo().io,
    });
    assert.equal(rolesResult.exitCode, 0);

    // A roles read with invocation-local flags never persists them.
    const before = await readFile(join(home, ".ak-roles", "public-cli.json"), "utf8");
    const overrideResult = await runAkRole(
      ["roles", "--model", "openai-codex/gpt-5.6-sol", "--thinking", "high"],
      {
        packageRoot,
        home,
        credentials: { "openai-codex": true, xai: true },
        io: captureIo().io,
      },
    );
    assert.equal(overrideResult.exitCode, 0);
    const after = await readFile(join(home, ".ak-roles", "public-cli.json"), "utf8");
    assert.equal(after, before);

    // #384: persistent config set keeps a bare provider/model bare, and an
    // explicit :thinking suffix stays intact through the same seam.
    const bareSet = await runAkRole(
      ["config", "set", "coder", "kimi-coding/k3-256k"],
      { packageRoot, home, io: captureIo().io },
    );
    assert.equal(bareSet.exitCode, 0);
    const barePersisted = (await loadPublicCliConfig(home)).seats.coder;
    assert.deepEqual(barePersisted && { provider: barePersisted.provider, model: barePersisted.model }, {
      provider: "kimi-coding",
      model: "k3-256k",
    });
    assert.equal(barePersisted?.thinking, undefined);

    // The stored bare row is the effective model a later seat call dispatches.
    const project = join(home, "work");
    await mkdir(project);
    seedGitProject(project);
    let bareDispatched: unknown;
    await runAkRole(["coder", "plan", "--project", project, "Plan with the stored bare model."], {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true, xai: true },
      createRunId: () => "cli-config-bare-dispatch",
      io: captureIo().io,
      roleTurnHost: createMinimalHost((request) => {
        bareDispatched = request.model;
        return Promise.resolve({ code: 1, stderr: "stop", timedOut: false });
      }),
    });
    assert.deepEqual(bareDispatched, { provider: "kimi-coding", model: "k3-256k" });

    // #683: an empty suffix is opaque thinking, stored as-is rather than dropped.
    const emptySuffix = await runAkRole(
      ["config", "set", "coder", "kimi-coding/k3-256k:"],
      { packageRoot, home, io: captureIo().io },
    );
    assert.equal(emptySuffix.exitCode, 0);
    assert.equal((await loadPublicCliConfig(home)).seats.coder?.thinking, "");

    const thinkingSet = await runAkRole(
      ["config", "set", "coder", "kimi-coding/k3-256k:high"],
      { packageRoot, home, io: captureIo().io },
    );
    assert.equal(thinkingSet.exitCode, 0);
    assert.deepEqual((await loadPublicCliConfig(home)).seats.coder, {
      provider: "kimi-coding",
      model: "k3-256k",
      thinking: "high",
    });

    // #453: gate seats are configurable; unset restores absence.
    const gateSet = await runAkRole(
      [
        "config",
        "set",
        "gatekeeper",
        "xai/grok-4.5:high",
        "inspector",
        "openai-codex/gpt-5.6-sol:medium",
      ],
      { packageRoot, home, io: captureIo().io },
    );
    assert.equal(gateSet.exitCode, 0);
    const gatePersisted = await loadPublicCliConfig(home);
    assert.deepEqual(gatePersisted.seats.gatekeeper, {
      provider: "xai",
      model: "grok-4.5",
      thinking: "high",
    });
    assert.deepEqual(gatePersisted.seats.inspector, {
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "medium",
    });

    const rolesAfter = await runAkRole(["roles"], {
      packageRoot,
      home,
      credentials: { "openai-codex": true, xai: true },
      io: captureIo().io,
    });
    assert.equal(rolesAfter.exitCode, 0);

    const unsetInspector = await runAkRole(["config", "unset", "inspector"], {
      packageRoot,
      home,
      io: captureIo().io,
    });
    assert.equal(unsetInspector.exitCode, 0);
    assert.equal((await loadPublicCliConfig(home)).seats.inspector, undefined);
    assert.deepEqual((await loadPublicCliConfig(home)).seats.gatekeeper, {
      provider: "xai",
      model: "grok-4.5",
      thinking: "high",
    });

    const unsetGate = await runAkRole(["config", "unset", "gatekeeper"], {
      packageRoot,
      home,
      io: captureIo().io,
    });
    assert.equal(unsetGate.exitCode, 0);
    assert.equal((await loadPublicCliConfig(home)).seats.gatekeeper, undefined);
  });
});

test("#620 inspector public entry injects gatekeeper inheritance into RoleTurnRequest.model", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project);
    seedGitProject(project);
    const attachment = join(project, "material.txt");
    await writeFile(attachment, "frozen review material", "utf8");
    const credentials: CredentialProviders = { "openai-codex": true, xai: true };

    assert.equal(
      (
        await runAkRole(
          ["config", "set", "gatekeeper", "openai-codex/gpt-5.6-sol:low"],
          { packageRoot, home, io: captureIo().io },
        )
      ).exitCode,
      0,
    );

    const captured: { current: RoleTurnRequest | undefined } = { current: undefined };
    const handed: { required?: unknown; hitsType?: unknown; schema?: unknown } = {};
    // No --model: #620 proves inherit-gatekeeper is the sole model source.
    await runAkRole(["inspector", "--project", project, "--attach", attachment, "Review this material."],
      {
        packageRoot,
        home,
        cwd: project,
        credentials,
        createRunId: () => "inspector-inherit-620",
        io: captureIo().io,
        roleTurnHost: createMinimalHost(async (request) => {
          captured.current = request;
          const prepared = await prepareRoleEnvelope({
            request,
            dependencies: createRoleRuntimeDependencies(packageRoot),
            socketPath: `/tmp/ak-inspector-schema-${randomUUID()}.sock`,
            sessionFile: piDurablePrincipalAuthority.decode(request.principal).sessionFile,
            principalAuthority: piDurablePrincipalAuthority,
          });
          try {
            // Observe only. Assert after the public entry returns; a throw inside the host is swallowed.
            handed.required = prepared.jsonSchema.required;
            handed.schema = prepared.jsonSchema;
            handed.hitsType = (prepared.jsonSchema.properties as {
              ticketComplexity?: { items?: { properties?: { hits?: { type?: unknown } } } };
            }).ticketComplexity?.items?.properties?.hits?.type;
          } finally {
            await prepared.dispose?.();
          }
          return { code: 1, stderr: "stop", timedOut: false };
        }),
      },
    );
    const required = handed.required;
    assert.equal(Array.isArray(required) && required.includes("suspect"), true);
    assert.equal(Array.isArray(required) && required.includes("ticketComplexity"), true);
    assert.equal(handed.hitsType, "array");
    assert.equal(Value.Check(handed.schema as never, {
      status: "converged",
      suspect: "ming/a.py:1",
      ticketComplexity: [{
        class: "同一业务规则只保留一个权威实现",
        hits: [],
        checked: "比对了 ming/a.py:1 与 ming/b.py:2",
      }],
    }), true);
    const inherited = captured.current!;
    assert.equal(inherited.activation.role, "inspector");
    assert.deepEqual(inherited.model, {
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "low",
    });
  });
});

test("#453 config unset clears gate model only; keeps notary engine; refuses non-gate", async () => {
  await withTempHome(async (home) => {
    const setModel = await runAkRole(
      ["config", "set", "notary", "xai/grok-4.5:high"],
      { packageRoot, home, io: captureIo().io },
    );
    assert.equal(setModel.exitCode, 0);
    const setEngine = await runAkRole(
      ["config", "set-engine", "notary", "opus"],
      { packageRoot, home, io: captureIo().io },
    );
    assert.equal(setEngine.exitCode, 0);

    const unset = await runAkRole(["config", "unset", "notary"], {
      packageRoot,
      home,
      io: captureIo().io,
    });
    assert.equal(unset.exitCode, 0);
    // Public surface: model gone, engine residual remains. Resolve semantics stay unit.
    assert.deepEqual((await loadPublicCliConfig(home)).seats.notary, {
      engine: "opus",
    });

    // Non-gate seat with a real row: refused unset must leave it untouched.
    const withJudge = await runAkRole(
      ["config", "set", "judge", "openai-codex/gpt-5.6-sol:high"],
      { packageRoot, home, io: captureIo().io },
    );
    assert.equal(withJudge.exitCode, 0);
    const refused = await runAkRole(["config", "unset", "judge"], {
      packageRoot,
      home,
      io: captureIo().io,
    });
    assert.notEqual(refused.exitCode, 0);
    assert.deepEqual((await loadPublicCliConfig(home)).seats.judge, {
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "high",
    });
  });
});

test("explicit internal activation args point at the package entrypoint file", async () => {
  const entry = await realpath(resolveInternalRoleEntrypoint(packageRoot));
  await access(entry);
  const args = buildExplicitInternalActivationArgs(entry, [
    "--ak-role",
    "judge",
    "--help",
  ]);
  assert.deepEqual(args.slice(0, 3), ["--no-extensions", "-e", entry]);
  assert.equal(args.includes("--ak-role"), true);
});

test("public runs write one identity-bound invocation ledger for every role", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    await materializeConflictedRepo(project);

    const bookKey = resolveBookKeyFromGit(project);
    const ledgerHome = resolveActivationLedgerHome(home);
    const piRunner = async (args: readonly string[]) => ({
      code: 1,
      stderr: "public ledger tracer",
      timedOut: false,
      args: [...args],
    });
    const cases = [
      { role: "judge", runId: "public-judge-001", args: ["judge", "--model", "test/caller-seat:high", "--project", project, "judge task"] },
      { role: "coder", runId: "public-coder-001", args: ["coder", "--model", "test/caller-seat:high", "--project", project, "coder task"] },
      { role: "fixer", runId: "public-fixer-001", args: ["fixer", "--model", "test/caller-seat:high", "--project", project, "fixer task"] },
      { role: "reviewer", runId: "public-reviewer-001", args: ["reviewer", "--model", "test/caller-seat:high", "--project", project, "--base", "HEAD", "--lens", "completeness", "--authority-ref", "CLAUDE.md", "reviewer task"] },
      { role: "collector", runId: "public-collector-001", args: ["collector", "--model", "test/caller-seat:high", "--project", project, "--pr", "177", "--repo", "acme/widgets"] },
      { role: "doctor", runId: "public-doctor-001", args: ["doctor", "--model", "test/caller-seat:high", "--project", project, "--issue", "177"] },
      { role: "merger", runId: "public-merger-001", args: ["merger", "--model", "test/caller-seat:high", "--project", project, "merger task"] },
    ] as const;

    for (const scenario of cases) {
      await runAkRole(scenario.args, {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => scenario.runId,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner,
        }),
        io: captureIo().io,
      });

      const runDirectory = join(
        activationBookDirectory(ledgerHome, bookKey),
        "unbound",
        "runs",
        `${scenario.runId}@${scenario.role}`,
      );
      const ledger = readCurrentSection(runDirectory, "invocation");
      assert.equal(ledger.role, scenario.role);
      assert.equal(ledger.runId, scenario.runId);
      assert.equal(ledger.bookKey, bookKey);
      assert.equal(ledger.projectRoot, project);
      assert.equal(ledger.runDirectory, runDirectory);
      assert.equal(ledger.sessionDirectory, sessionDirectoryOf(runDirectory));
      assert.equal(ledger.sessionFile, sessionFileOf(runDirectory));
    }
  });
});

test("unknown command exits nonzero without touching config", async () => {
  await withTempHome(async (home) => {
    await mkdir(join(home, ".ak-roles"), { recursive: true });
    await writeFile(
      join(home, ".ak-roles", "public-cli.json"),
      JSON.stringify({ seats: {} }),
      "utf8",
    );
    const before = await readFile(join(home, ".ak-roles", "public-cli.json"), "utf8");
    const { io, stderr } = captureIo();
    const result = await runAkRole(["not-a-command"], {
      packageRoot,
      home,
      io,
    });
    assert.equal(result.exitCode, 2);
    assert.equal(stderr.join("").length > 0, true);
    const after = await readFile(join(home, ".ak-roles", "public-cli.json"), "utf8");
    assert.equal(after, before);
  });
});


