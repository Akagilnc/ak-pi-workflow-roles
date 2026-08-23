import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import {
  activationBookDirectory,
  resolveActivationLedgerHome,
} from "../../src/activation-ledger-topology.ts";
import {
  buildExplicitInternalActivationArgs,
  helpDocument,
  resolveInternalRoleEntrypoint,
  runAkRole,
} from "../../src/public-cli/cli.ts";
import { PUBLIC_CALLABLE_ROLES } from "../../src/public-cli/registry.ts";
import { loadPublicCliConfig, publicCliConfigPath, resolveEffectiveSeat, type CredentialProviders } from "../../src/public-cli/config.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-public-cli-cli-"));
  try {
    return await scenario(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => {
        stdout.push(text);
      },
      stderr: (text: string) => {
        stderr.push(text);
      },
    },
  };
}

test("help document capabilities match typed registry without depending on layout", () => {
  const doc = helpDocument();
  assert.equal(doc.executable, "ak-role");
  const names = doc.capabilities.map((c) => c.name);
  assert.equal(names.includes("roles"), true);
  assert.equal(names.includes("config"), true);
  assert.equal(names.includes("help"), true);
  for (const role of PUBLIC_CALLABLE_ROLES) {
    assert.equal(names.includes(role), true);
  }
  assert.equal((names as readonly string[]).includes("navigator"), false);
});

// Config persistence round-trip on the typed seat face (#420 整改：原四条呈现案
// 并一——TSV 行型正则把列序/措辞变承重结构违 ADR 0052，改咬 loadPublicCliConfig /
// resolveEffectiveSeat / public-cli.json 字节 / 退出码；进程级可见性契约保留)。
test("config persistence round-trips across processes on the typed seat face", async () => {
  await withTempHome(async (home) => {
    // Fresh home: roles exits zero and every configurable seat enumerates from
    // typed defaults — judge's startup default comes from available credentials.
    const fresh = await runAkRole(["roles"], {
      packageRoot,
      home,
      credentials: { "openai-codex": true, xai: false },
      io: captureIo().io,
    });
    assert.equal(fresh.exitCode, 0);
    const codexOnly: CredentialProviders = { "openai-codex": true, xai: false };
    const judgeDefault = resolveEffectiveSeat(await loadPublicCliConfig(home), "judge", codexOnly);
    assert.equal(judgeDefault.source, "startup");
    assert.deepEqual(judgeDefault.selection, {
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "high",
    });

    // Bulk config set is visible to a subsequent process via the config bytes.
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

    // Local invocation override wins for the process but never persists.
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
    const invocationEffective = resolveEffectiveSeat(
      await loadPublicCliConfig(home),
      "judge",
      { "openai-codex": true, xai: true },
      { model: "openai-codex/gpt-5.6-sol", thinking: "high" },
    );
    assert.equal(invocationEffective.source, "invocation");
    assert.deepEqual(invocationEffective.selection, {
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "high",
    });
    const after = await readFile(join(home, ".ak-roles", "public-cli.json"), "utf8");
    assert.equal(after, before);

    // #346: bare --model provider/model without :thinking is legal and records
    // no invented thinking suffix.
    const bareRoles = await runAkRole(
      ["roles", "--model", "kimi-coding/k3-256k"],
      {
        packageRoot,
        home,
        credentials: { "openai-codex": true, xai: false },
        io: captureIo().io,
      },
    );
    assert.equal(bareRoles.exitCode, 0);
    const bareEffective = resolveEffectiveSeat(
      await loadPublicCliConfig(home),
      "coder",
      { "openai-codex": true, xai: false },
      { model: "kimi-coding/k3-256k" },
    );
    assert.equal(bareEffective.source, "invocation");
    assert.deepEqual(bareEffective.selection, {
      provider: "kimi-coding",
      model: "k3-256k",
    });

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

test("every public callable role is a completed path (no deferred slice)", async () => {
  await withTempHome(async (home) => {
    for (const role of PUBLIC_CALLABLE_ROLES) {
      const { io, stderr, stdout } = captureIo();
      // Malformed structure where the adapter owns a closed grammar; otherwise a
      // nonblank instruction that must not hit deferred-slice stubs.
      const argv =
        role === "collector"
          ? ["collector", "--pr", "0"]
          : role === "doctor"
            ? ["doctor", "--issue", "0"]
            : role === "merger"
              ? ["merger", "   "]
              : [role, "exercise completed public path"];
      const result = await runAkRole(argv, {
        packageRoot,
        home,
        io,
        piRunner: async (args) => ({
          code: 1,
          stderr: "forced runner stop",
          timedOut: false,
          args: [...args],
        }),
      });
      assert.notEqual(result.exitCode, 0, role);
      assert.equal(
        stderr.join("").includes("not available in this install slice"),
        false,
        role,
      );
      assert.equal(
        stdout.join("").includes("not available in this install slice"),
        false,
        role,
      );
    }
  });
});

test("public runs write one identity-bound invocation ledger for every role", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: project });
    execFileSync("git", ["config", "user.email", "cli@test.local"], { cwd: project });
    execFileSync("git", ["config", "user.name", "CLI Test"], { cwd: project });
    execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: project });
    await writeFile(join(project, "conflict.txt"), "base\n", "utf8");
    execFileSync("git", ["add", "conflict.txt"], { cwd: project });
    execFileSync("git", ["commit", "-m", "base conflict fixture"], { cwd: project });
    execFileSync("git", ["checkout", "-b", "ledger-side"], { cwd: project });
    await writeFile(join(project, "conflict.txt"), "side\n", "utf8");
    execFileSync("git", ["commit", "-am", "side conflict fixture"], { cwd: project });
    execFileSync("git", ["checkout", "main"], { cwd: project });
    await writeFile(join(project, "conflict.txt"), "main\n", "utf8");
    execFileSync("git", ["commit", "-am", "main conflict fixture"], { cwd: project });
    try {
      execFileSync("git", ["merge", "ledger-side"], { cwd: project, stdio: "ignore" });
    } catch {
      // The unresolved conflict is the real production prerequisite for Merger admission.
    }

    const bookKey = resolveBookKeyFromGit(project);
    const ledgerHome = resolveActivationLedgerHome(() => home);
    const piRunner = async (args: readonly string[]) => ({
      code: 1,
      stderr: "public ledger tracer",
      timedOut: false,
      args: [...args],
    });
    const cases = [
      { role: "judge", runId: "public-judge-001", args: ["judge", "--project", project, "judge task"] },
      { role: "coder", runId: "public-coder-001", args: ["coder", "--project", project, "coder task"] },
      { role: "fixer", runId: "public-fixer-001", args: ["fixer", "--project", project, "fixer task"] },
      { role: "reviewer", runId: "public-reviewer-001", args: ["reviewer", "--project", project, "--base", "HEAD", "reviewer task"] },
      { role: "collector", runId: "public-collector-001", args: ["collector", "--project", project, "--pr", "177", "--repo", "acme/widgets"] },
      { role: "doctor", runId: "public-doctor-001", args: ["doctor", "--project", project, "--issue", "177"] },
      { role: "merger", runId: "public-merger-001", args: ["merger", "--project", project, "merger task"] },
    ] as const;

    for (const scenario of cases) {
      await runAkRole(scenario.args, {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => scenario.runId,
        piRunner,
        io: captureIo().io,
      });

      const runDirectory = join(
        activationBookDirectory(ledgerHome, bookKey),
        "runs",
        `${scenario.runId}@${scenario.role}`,
      );
      const ledger = JSON.parse(
        await readFile(join(runDirectory, "invocation.json"), "utf8"),
      ) as Record<string, unknown>;
      assert.equal(ledger.role, scenario.role);
      assert.equal(ledger.runId, scenario.runId);
      assert.equal(ledger.bookKey, bookKey);
      assert.equal(ledger.projectRoot, project);
      assert.equal(ledger.runDirectory, runDirectory);
      assert.equal(ledger.sessionDirectory, join(runDirectory, "session"));
      assert.equal(ledger.sessionFile, join(runDirectory, "session", "session.jsonl"));
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


