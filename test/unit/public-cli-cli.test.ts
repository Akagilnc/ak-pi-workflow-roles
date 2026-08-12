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
import { PUBLIC_CALLABLE_ROLES, PUBLIC_CONFIGURABLE_SEATS } from "../../src/public-cli/registry.ts";
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

test("roles lists seven callable seats plus automatic Navigator with effective models", async () => {
  await withTempHome(async (home) => {
    const { io, stdout } = captureIo();
    const result = await runAkRole(["roles"], {
      packageRoot,
      home,
      credentials: { "openai-codex": true, xai: false },
      io,
    });
    assert.equal(result.exitCode, 0);
    const text = stdout.join("");
    // Contract: every configurable seat appears once; kind markers present.
    for (const seat of PUBLIC_CONFIGURABLE_SEATS) {
      assert.match(text, new RegExp(`^${seat}\\t`, "m"));
    }
    assert.match(text, /^navigator\tautomatic\t/m);
    assert.match(text, /^judge\tcallable\tstartup\topenai-codex\/gpt-5\.6-sol:high$/m);
    assert.equal(text.includes("auditor"), false);
  });
});

test("config set bulk write is visible to a subsequent roles process; local override does not persist", async () => {
  await withTempHome(async (home) => {
    const first = captureIo();
    const setResult = await runAkRole(
      [
        "config",
        "set",
        "judge",
        "xai/grok-4.5:high",
        "navigator",
        "openai-codex/gpt-5.6-luna:medium",
      ],
      { packageRoot, home, io: first.io },
    );
    assert.equal(setResult.exitCode, 0);

    const second = captureIo();
    const rolesResult = await runAkRole(["roles"], {
      packageRoot,
      home,
      credentials: { "openai-codex": true, xai: true },
      io: second.io,
    });
    assert.equal(rolesResult.exitCode, 0);
    const rolesText = second.stdout.join("");
    assert.match(rolesText, /^judge\tcallable\tpersistent\txai\/grok-4\.5:high$/m);
    assert.match(
      rolesText,
      /^navigator\tautomatic\tpersistent\topenai-codex\/gpt-5\.6-luna:medium$/m,
    );

    const before = await readFile(join(home, ".ak-roles", "public-cli.json"), "utf8");
    const third = captureIo();
    const overrideResult = await runAkRole(
      ["roles", "--model", "openai-codex/gpt-5.6-sol", "--thinking", "high"],
      {
        packageRoot,
        home,
        credentials: { "openai-codex": true, xai: true },
        io: third.io,
      },
    );
    assert.equal(overrideResult.exitCode, 0);
    assert.match(
      third.stdout.join(""),
      /^judge\tcallable\tinvocation\topenai-codex\/gpt-5\.6-sol:high$/m,
    );
    const after = await readFile(join(home, ".ak-roles", "public-cli.json"), "utf8");
    assert.equal(after, before);
  });
});

test("explicit internal activation args point at the package entrypoint file", async () => {
  const entry = resolveInternalRoleEntrypoint(packageRoot);
  await access(entry);
  const args = buildExplicitInternalActivationArgs(packageRoot, [
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
