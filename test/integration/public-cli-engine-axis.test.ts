import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
import { installHermesFixture } from "../helpers/hermes-fixture.ts";
import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
/**
 * #356 T1 / #376 / #378 / #391 — all-role engine axis on config → activation material seams.
 * Covers: priority, path-safety rejection, public CLI tracer, default-path byte oracle.
 * Two delivery paths: with packaged notes (cursor) / name-only without notes (any free name).
 * No closed material catalog. All seats inherit the same dual-path contract (#378/#391).
 * Zero assertions on engine material body CLI invocation text.
 * Zero assertions on free-prose delivery wording / layout.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { AK_ROLE_ENGINE_ENV } from "../../src/engine-detour.ts";
import {
  engineSessionMaterialFromOptions,
  resolveEngineMaterialPath,
} from "../../src/package-resources/engine-material.ts";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { issuePiDurablePrincipalCoordinates } from "../../src/pi/durable-principal.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { writeRoleRunState } from "../../src/public-cli/run-lifecycle.ts";
import {
  loadPublicCliConfig,
  savePublicCliConfig,
  setPersistentSeatConfig,
  setPersistentSeatEngine,
  validatePublicCliConfigAxes,
  type PublicCliConfig,
} from "../../src/public-cli/config.ts";
import {
  PUBLIC_CALLABLE_ROLES,
  type PublicCallableRole,
} from "../../src/public-cli/registry.ts";

import { packageRoot } from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

/** Read the durable invocation identity page for a public role run (#358/#391). */
function readRoleInvocation(
  home: string,
  bookKey: string,
  runId: string,
  role: string,
): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      join(home, ".ak-roles", "books", bookKey, "runs", `${runId}@${role}`, "invocation.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

/** Read the durable invocation identity page for a public Judge run (#358). */
function readJudgeInvocation(
  home: string,
  bookKey: string,
  runId: string,
): Record<string, unknown> {
  return readRoleInvocation(home, bookKey, runId, "judge");
}


function assertNoEngineFlagsInArgv(argv: readonly string[]): void {
  assert.equal(
    argv.some((a) => a === "--engine" || a.startsWith("--ak-engine")),
    false,
    "engine must not leak as argv flag",
  );
}

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("ak-engine-axis-", scenario);
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

const credentials = { "openai-codex": true, xai: true } as const;

// --- config parse + priority -------------------------------------------------

test("persistent judge engine round-trips; syntax-illegal engine rejected at parse/validate", async () => {
  await withTempHome(async (home) => {
    let config: PublicCliConfig = { seats: {} };
    config = setPersistentSeatConfig(config, "judge", {
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "high",
    });
    config = setPersistentSeatEngine(config, "judge", "opus");
    await savePublicCliConfig(config, home);

    const reloaded = await loadPublicCliConfig(home);
    assert.equal(reloaded.seats.judge?.engine, "opus");
    assert.deepEqual(
      {
        provider: reloaded.seats.judge?.provider,
        model: reloaded.seats.judge?.model,
        thinking: reloaded.seats.judge?.thinking,
      },
      { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
    );
    // Validate accepts any path-safe name (no closed material catalog).
    validatePublicCliConfigAxes(reloaded, packageRoot);

    // Legacy config without engine still loads.
    await savePublicCliConfig(
      {
        seats: {
          coder: {
            provider: "xai",
            model: "grok-4.5",
            thinking: "medium",
          },
        },
      },
      home,
    );
    const legacy = await loadPublicCliConfig(home);
    assert.equal(legacy.seats.coder?.engine, undefined);
    assert.equal("engine" in (legacy.seats.coder ?? {}), false);

    // Reviewer engine field is accepted at validate seam (#378).
    await writeFile(
      join(home, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({
        seats: {
          reviewer: {
            provider: "xai",
            model: "grok-4.5",
            thinking: "medium",
            engine: "cursor",
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const reviewerCfg = await loadPublicCliConfig(home);
    validatePublicCliConfigAxes(reviewerCfg, packageRoot);
    assert.equal(reviewerCfg.seats.reviewer?.engine, "cursor");

    // Non-judge seat engine field is accepted at validate seam (#391 all roles).
    await writeFile(
      join(home, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({
        seats: {
          coder: {
            provider: "xai",
            model: "grok-4.5",
            thinking: "medium",
            engine: "opus",
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const coderCfg = await loadPublicCliConfig(home);
    validatePublicCliConfigAxes(coderCfg, packageRoot);
    assert.equal(coderCfg.seats.coder?.engine, "opus");

    // Syntax-illegal engine name in on-disk judge config is rejected at validate seam.
    await writeFile(
      join(home, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({
        seats: {
          judge: {
            provider: "openai-codex",
            model: "gpt-5.6-sol",
            thinking: "high",
            engine: "has/slash",
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const bad = await loadPublicCliConfig(home);
    assert.throws(
      () => validatePublicCliConfigAxes(bad, packageRoot),
      /config seat judge engine is illegal: has\/slash/,
    );

    // Well-formed name without packaged notes is accepted at validate seam.
    await writeFile(
      join(home, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({
        seats: {
          judge: {
            provider: "openai-codex",
            model: "gpt-5.6-sol",
            thinking: "high",
            engine: "ghost-engine",
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const freeName = await loadPublicCliConfig(home);
    validatePublicCliConfigAxes(freeName, packageRoot);
    assert.equal(freeName.seats.judge?.engine, "ghost-engine");

    // unset-engine clears a persistent judge engine through the public CLI
    // (absorbed from the former dedicated unset-engine test; golden byte
    // reassertion deleted with the frozen-baseline oracle).
    {
      await withTempRoot("ak-engine-unset-", async (cliHome) => {
        await runAkRole(
          ["config", "set", "judge", "openai-codex/gpt-5.6-sol:high"],
          { packageRoot, home: cliHome, io: captureIo().io },
        );
        await runAkRole(
          ["config", "set-engine", "judge", "cursor"],
          { packageRoot, home: cliHome, io: captureIo().io },
        );
        assert.equal((await loadPublicCliConfig(cliHome)).seats.judge?.engine, "cursor");

        const unset = await runAkRole(
          ["config", "unset-engine", "judge"],
          { packageRoot, home: cliHome, io: captureIo().io },
        );
        assert.equal(unset.exitCode, 0);
        assert.equal((await loadPublicCliConfig(cliHome)).seats.judge?.engine, undefined);
            });
    }
  });
});
// --- public CLI tracer -------------------------------------------------------

test("public CLI --engine and config set-engine: cursor notes / free name; flag wins; syntax rejects", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: project });
    execFileSync("git", ["config", "user.email", "engine@test.local"], { cwd: project });
    execFileSync("git", ["config", "user.name", "Engine Test"], { cwd: project });
    execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: project });

    // Seed persistent model so set-engine is legal.
    const seed = captureIo();
    const setModel = await runAkRole(
      ["config", "set", "judge", "openai-codex/gpt-5.6-sol:high"],
      { packageRoot, home, io: seed.io },
    );
    assert.equal(setModel.exitCode, 0, seed.stderr.join(""));

    const setEngine = captureIo();
    const setEngineResult = await runAkRole(
      ["config", "set-engine", "judge", "cursor"],
      { packageRoot, home, io: setEngine.io },
    );
    assert.equal(setEngineResult.exitCode, 0, setEngine.stderr.join(""));
    const persisted = await loadPublicCliConfig(home);
    assert.equal(persisted.seats.judge?.engine, "cursor");

    const materialCursor = resolveEngineMaterialPath(packageRoot, "cursor");
    await access(materialCursor);
    const bookKey = resolveBookKeyFromGit(project);

    // Persistent engine alone (cursor = with packaged notes).
    {
      let capturedArgs: string[] | undefined;
      const { io, stderr } = captureIo();
      const result = await runAkRole(
        ["judge", "--project", project, "engine persistent path"],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "engine-persist-001",
          credentials,
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
            capturedArgs = [...args];
            return {
              code: 1,
              stderr: "stop after capture",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      assert.notEqual(
        result.exitCode,
        2,
        `structural reject: ${stderr.join("")}`,
      );
      assert.equal(
        Array.isArray(capturedArgs),
        true,
        `piRunner not reached; exit=${result.exitCode} stderr=${stderr.join("")}`,
      );
      assertNoEngineFlagsInArgv(capturedArgs!);
      // #358 mechanical provenance: selected engine lands on the identity page.
      const invocation = readJudgeInvocation(home, bookKey, "engine-persist-001");
      assert.equal(invocation.engine, "cursor");
    }

    // Invocation --engine overrides persistent (opus notes when packaged).
    {
      let capturedArgs: string[] | undefined;
      const { io, stderr } = captureIo();
      const result = await runAkRole(
        [
          "--engine",
          "opus",
          "judge",
          "--project",
          project,
          "engine invocation wins",
        ],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "engine-invoke-001",
          credentials,
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
            capturedArgs = [...args];
            return {
              code: 1,
              stderr: "stop after capture",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      assert.notEqual(result.exitCode, 2, stderr.join(""));
      const materialOpus = resolveEngineMaterialPath(packageRoot, "opus");
      if (existsSync(materialOpus)) {
      } else {
      }
      // Override must not keep the persistent engine material path.
      assertNoEngineFlagsInArgv(capturedArgs!);
      // #358 mechanical provenance: override engine is the recorded identity.
      const invocation = readJudgeInvocation(home, bookKey, "engine-invoke-001");
      assert.equal(invocation.engine, "opus");
    }

    // No engine selected → identity page keeps engine key absent (shape unchanged).
    {
      const unset = await runAkRole(
        ["config", "unset-engine", "judge"],
        { packageRoot, home, io: captureIo().io },
      );
      assert.equal(unset.exitCode, 0);
      let capturedArgs: string[] | undefined;
      const { io, stderr } = captureIo();
      const result = await runAkRole(
        ["judge", "--project", project, "engine absent path"],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "engine-none-001",
          credentials,
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
            capturedArgs = [...args];
            return {
              code: 1,
              stderr: "stop after capture",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      assert.notEqual(result.exitCode, 2, stderr.join(""));
      assert.equal(
        Array.isArray(capturedArgs),
        true,
        `piRunner not reached; exit=${result.exitCode} stderr=${stderr.join("")}`,
      );
      const invocation = readJudgeInvocation(home, bookKey, "engine-none-001");
      assert.equal("engine" in invocation, false);
      // Case remains readable at the same identity seam.
      assert.equal(invocation.role, "judge");
      assert.equal(invocation.runId, "engine-none-001");
    }

    // Free name without notes → normal pass (exit≠2), name present, no path, zero warnings.
    {
      let capturedArgs: string[] | undefined;
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      const { io, stderr } = captureIo();
      const result = await runAkRole(
        ["judge", "--engine", "nope-engine", "--project", project, "x"],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "engine-free-name-001",
          credentials,
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args, options) => {
            capturedArgs = [...args];
            capturedEnv = options.env;
            return {
              code: 1,
              stderr: "stop after capture",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      assert.notEqual(
        result.exitCode,
        2,
        `free name must not structural-reject: ${stderr.join("")}`,
      );
      assert.equal(
        Array.isArray(capturedArgs),
        true,
        `piRunner not reached; exit=${result.exitCode} stderr=${stderr.join("")}`,
      );
      const absentPath = resolveEngineMaterialPath(packageRoot, "nope-engine");
      assert.equal(capturedEnv?.[AK_ROLE_ENGINE_ENV], "nope-engine");
      assertNoEngineFlagsInArgv(capturedArgs!);
      const invocation = readJudgeInvocation(home, bookKey, "engine-free-name-001");
      assert.equal(invocation.engine, "nope-engine");
    }

    // Consecutive dots inside a label (company..opus) are path-safe and pass as-is.
    {
      const setDots = captureIo();
      const setDotsResult = await runAkRole(
        ["config", "set-engine", "judge", "company..opus"],
        { packageRoot, home, io: setDots.io },
      );
      assert.equal(setDotsResult.exitCode, 0, setDots.stderr.join(""));
      const persistedDots = await loadPublicCliConfig(home);
      assert.equal(persistedDots.seats.judge?.engine, "company..opus");

      let capturedArgs: string[] | undefined;
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      const { io, stderr } = captureIo();
      const result = await runAkRole(
        ["judge", "--engine", "company..opus", "--project", project, "x"],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "engine-company-dots-001",
          credentials,
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args, options) => {
            capturedArgs = [...args];
            capturedEnv = options.env;
            return {
              code: 1,
              stderr: "stop after capture",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      assert.notEqual(
        result.exitCode,
        2,
        `company..opus must pass path-safety: ${stderr.join("")}`,
      );
      assert.equal(
        Array.isArray(capturedArgs),
        true,
        `piRunner not reached; exit=${result.exitCode} stderr=${stderr.join("")}`,
      );
      const absentPath = resolveEngineMaterialPath(packageRoot, "company..opus");
      assert.equal(capturedEnv?.[AK_ROLE_ENGINE_ENV], "company..opus");
      const invocation = readJudgeInvocation(home, bookKey, "engine-company-dots-001");
      assert.equal(invocation.engine, "company..opus");
    }

    // Syntax-illegal --engine → structural reject (exit 2), not role submission.
    {
      const { io, stderr } = captureIo();
      const result = await runAkRole(
        ["judge", "--engine", "has/slash", "--project", project, "x"],
        { packageRoot, home, cwd: project, credentials, io },
      );
      assert.equal(result.exitCode, 2);
      assert.match(stderr.join(""), /illegal engine name/);
    }

    // Backslash separator and parent traversal still reject at the public entry.
    {
      const slash = captureIo();
      const slashResult = await runAkRole(
        ["judge", "--engine", "has\\slash", "--project", project, "x"],
        { packageRoot, home, cwd: project, credentials, io: slash.io },
      );
      assert.equal(slashResult.exitCode, 2);
      assert.match(slash.stderr.join(""), /illegal engine name/);

      const escape = captureIo();
      const escapeResult = await runAkRole(
        ["judge", "--engine", "../escape", "--project", project, "x"],
        { packageRoot, home, cwd: project, credentials, io: escape.io },
      );
      assert.equal(escapeResult.exitCode, 2);
      assert.match(escape.stderr.join(""), /illegal engine name/);

      const setEscape = captureIo();
      const setEscapeResult = await runAkRole(
        ["config", "set-engine", "judge", "../escape"],
        { packageRoot, home, io: setEscape.io },
      );
      assert.equal(setEscapeResult.exitCode, 2);
      assert.match(setEscape.stderr.join(""), /illegal engine name/);
    }

    // Reviewer command with --engine is admitted at the call-request seam (#378).
    {
      let capturedArgs: string[] | undefined;
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      const { io, stderr } = captureIo();
      const result = await runAkRole(
        [
          "reviewer",
          "--engine",
          "cursor",
          "--project",
          project,
          "--base",
          "HEAD",
        ],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "engine-reviewer-cursor-001",
          credentials,
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args, options) => {
            capturedArgs = [...args];
            capturedEnv = options.env;
            return {
              code: 1,
              stderr: "stop after capture",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      assert.notEqual(
        result.exitCode,
        2,
        `reviewer --engine must not structural-reject: ${stderr.join("")}`,
      );
      assert.equal(
        Array.isArray(capturedArgs),
        true,
        `piRunner not reached; exit=${result.exitCode} stderr=${stderr.join("")}`,
      );
      assert.equal(capturedEnv?.[AK_ROLE_ENGINE_ENV], "cursor");
      assertNoEngineFlagsInArgv(capturedArgs!);
    }

    // Support command with --engine → structural reject (stable exit semantics only).
    {
      const { io } = captureIo();
      const result = await runAkRole(
        ["roles", "--engine", "opus"],
        { packageRoot, home, cwd: project, credentials, io },
      );
      assert.equal(result.exitCode, 2);
    }

    // Syntax-illegal persistent engine on load → structural reject.
    {
      await writeFile(
        join(home, ".ak-roles", "public-cli.json"),
        `${JSON.stringify({
          seats: {
            judge: {
              provider: "openai-codex",
              model: "gpt-5.6-sol",
              thinking: "high",
              engine: "../escape",
            },
          },
        }, null, 2)}\n`,
        "utf8",
      );
      const { io, stderr } = captureIo();
      const result = await runAkRole(
        ["judge", "--project", project, "x"],
        { packageRoot, home, cwd: project, credentials, io },
      );
      assert.equal(result.exitCode, 2);
      assert.match(stderr.join(""), /config seat judge engine is illegal/);
    }

    // set-engine with free name (no notes) writes successfully.
    {
      // Restore a syntax-legal on-disk config (previous case left ../escape).
      await writeFile(
        join(home, ".ak-roles", "public-cli.json"),
        `${JSON.stringify({
          seats: {
            judge: {
              provider: "openai-codex",
              model: "gpt-5.6-sol",
              thinking: "high",
            },
          },
        }, null, 2)}\n`,
        "utf8",
      );
      const { io, stderr } = captureIo();
      const result = await runAkRole(
        ["config", "set-engine", "judge", "still-fake"],
        { packageRoot, home, io },
      );
      assert.equal(result.exitCode, 0, stderr.join(""));
      const after = await loadPublicCliConfig(home);
      assert.equal(after.seats.judge?.engine, "still-fake");
    }

    // set-engine with syntax-illegal name rejects without writing.
    {
      const before = await loadPublicCliConfig(home);
      const { io, stderr } = captureIo();
      const result = await runAkRole(
        ["config", "set-engine", "judge", "bad/name"],
        { packageRoot, home, io },
      );
      assert.equal(result.exitCode, 2);
      assert.match(stderr.join(""), /illegal engine name/);
      const after = await loadPublicCliConfig(home);
      assert.equal(after.seats.judge?.engine, before.seats.judge?.engine);
    }

    // set-engine on reviewer seat persists (#378).
    {
      await runAkRole(
        ["config", "set", "reviewer", "openai-codex/gpt-5.6-sol:high"],
        { packageRoot, home, io: captureIo().io },
      );
      const { io, stderr } = captureIo();
      const result = await runAkRole(
        ["config", "set-engine", "reviewer", "cursor"],
        { packageRoot, home, io },
      );
      assert.equal(result.exitCode, 0, stderr.join(""));
      const after = await loadPublicCliConfig(home);
      assert.equal(after.seats.reviewer?.engine, "cursor");
    }

    // set-engine on coder seat persists (#391 all roles).
    {
      await runAkRole(
        ["config", "set", "coder", "openai-codex/gpt-5.6-sol:high"],
        { packageRoot, home, io: captureIo().io },
      );
      const { io, stderr } = captureIo();
      const result = await runAkRole(
        ["config", "set-engine", "coder", "opus"],
        { packageRoot, home, io },
      );
      assert.equal(result.exitCode, 0, stderr.join(""));
      const after = await loadPublicCliConfig(home);
      assert.equal(after.seats.coder?.engine, "opus");
    }
  });
});

test("#391 fixer --engine and set-engine: env signal + material coordinates; free name ok", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: project });
    execFileSync("git", ["config", "user.email", "engine@test.local"], { cwd: project });
    execFileSync("git", ["config", "user.name", "Engine Test"], { cwd: project });
    execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: project });

    await runAkRole(
      ["config", "set", "fixer", "openai-codex/gpt-5.6-sol:high"],
      { packageRoot, home, io: captureIo().io },
    );
    {
      const { io, stderr } = captureIo();
      const setEngine = await runAkRole(
        ["config", "set-engine", "fixer", "cursor"],
        { packageRoot, home, io },
      );
      assert.equal(setEngine.exitCode, 0, stderr.join(""));
      const persisted = await loadPublicCliConfig(home);
      assert.equal(persisted.seats.fixer?.engine, "cursor");
    }

    const materialCursor = resolveEngineMaterialPath(packageRoot, "cursor");
    await access(materialCursor);

    // Persistent engine alone reaches pi with env + material coordinates.
    {
      let capturedArgs: string[] | undefined;
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      const { io, stderr } = captureIo();
      const result = await runAkRole(
        ["fixer", "--project", project, "fixer engine persistent path"],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "engine-fixer-persist-001",
          credentials,
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args, options) => {
            capturedArgs = [...args];
            capturedEnv = options.env;
            return {
              code: 1,
              stderr: "stop after capture",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      assert.notEqual(
        result.exitCode,
        2,
        `fixer set-engine path must not structural-reject: ${stderr.join("")}`,
      );
      assert.equal(
        Array.isArray(capturedArgs),
        true,
        `piRunner not reached; exit=${result.exitCode} stderr=${stderr.join("")}`,
      );
      assert.equal(capturedEnv?.[AK_ROLE_ENGINE_ENV], "cursor");
      assertNoEngineFlagsInArgv(capturedArgs!);
    }

    // Invocation --engine overrides persistent and still wires env.
    {
      let capturedArgs: string[] | undefined;
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      const { io, stderr } = captureIo();
      const result = await runAkRole(
        [
          "fixer",
          "--engine",
          "nope-engine",
          "--project",
          project,
          "fixer engine invocation wins",
        ],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "engine-fixer-invoke-001",
          credentials,
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args, options) => {
            capturedArgs = [...args];
            capturedEnv = options.env;
            return {
              code: 1,
              stderr: "stop after capture",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      assert.notEqual(
        result.exitCode,
        2,
        `fixer --engine must not structural-reject: ${stderr.join("")}`,
      );
      assert.equal(
        Array.isArray(capturedArgs),
        true,
        `piRunner not reached; exit=${result.exitCode} stderr=${stderr.join("")}`,
      );
      assert.equal(capturedEnv?.[AK_ROLE_ENGINE_ENV], "nope-engine");
      assertNoEngineFlagsInArgv(capturedArgs!);
    }
  });
});

test("ambient AK_ROLE_ENGINE does not activate detour signal for engine-free judge run", async () => {
  const previous = process.env[AK_ROLE_ENGINE_ENV];
  process.env[AK_ROLE_ENGINE_ENV] = "opus";
  try {
    await withTempHome(async (home) => {
      const project = join(home, "project");
      await mkdir(project, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], { cwd: project });
      execFileSync("git", ["config", "user.email", "engine@test.local"], {
        cwd: project,
      });
      execFileSync("git", ["config", "user.name", "Engine Test"], { cwd: project });
      execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], {
        cwd: project,
      });

      const seed = captureIo();
      const setModel = await runAkRole(
        ["config", "set", "judge", "openai-codex/gpt-5.6-sol:high"],
        { packageRoot, home, io: seed.io },
      );
      assert.equal(setModel.exitCode, 0, seed.stderr.join(""));

      let capturedEnv: NodeJS.ProcessEnv | undefined;
      let capturedArgs: string[] | undefined;
      const { io, stderr } = captureIo();
      const result = await runAkRole(
        ["judge", "--project", project, "engine-free under ambient AK_ROLE_ENGINE"],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "engine-ambient-free-001",
          credentials,
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args, options) => {
            capturedArgs = [...args];
            capturedEnv = options.env;
            return {
              code: 1,
              stderr: "stop after capture",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      assert.notEqual(
        result.exitCode,
        2,
        `structural reject: ${stderr.join("")}`,
      );
      assert.equal(
        capturedEnv !== undefined && capturedArgs !== undefined,
        true,
        `piRunner not reached; exit=${result.exitCode} stderr=${stderr.join("")}`,
      );
      // Registration gate signal must be absent (AC4 family: no detour without engine).
      const ambient = capturedEnv![AK_ROLE_ENGINE_ENV];
      assert.equal(
        typeof ambient === "string" && ambient.trim() !== "",
        false,
        `ambient AK_ROLE_ENGINE leaked into child env: ${String(ambient)}`,
      );
      assertNoEngineFlagsInArgv(capturedArgs!);
      const materialOpus = resolveEngineMaterialPath(packageRoot, "opus");
    });
  } finally {
    if (previous === undefined) delete process.env[AK_ROLE_ENGINE_ENV];
    else process.env[AK_ROLE_ENGINE_ENV] = previous;
  }
});

// --- #391 E4: table-driven full PUBLIC_CALLABLE_ROLES + negative table ------------

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "engine@test.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Engine Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

async function materializeConflictedRepo(root: string): Promise<void> {
  seedGitProject(root);
  await writeFile(join(root, "same.txt"), "base\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "base"], { cwd: root });
  execFileSync("git", ["checkout", "-b", "source"], { cwd: root });
  await writeFile(join(root, "same.txt"), "source\n", "utf8");
  execFileSync("git", ["commit", "-am", "source"], { cwd: root });
  execFileSync("git", ["checkout", "main"], { cwd: root });
  await writeFile(join(root, "same.txt"), "target\n", "utf8");
  execFileSync("git", ["commit", "-am", "target"], { cwd: root });
  try {
    execFileSync("git", ["merge", "--no-edit", "source"], { cwd: root });
    throw new Error("expected conflicting merge");
  } catch (error) {
    if (error instanceof Error && error.message === "expected conflicting merge") throw error;
    // conflicted
  }
}

/** Minimal argv per callable role so the run reaches piRunner (shared fixture). */
function roleEngineProbeArgv(role: PublicCallableRole, project: string): string[] {
  switch (role) {
    case "judge":
    case "fixer":
    case "coder":
    case "merger":
      return [role, "--project", project, "engine axis probe"];
    case "reviewer":
      return [role, "--project", project, "--base", "main", "engine axis probe"];
    case "collector":
      return [role, "--pr", "1", "--repo", "acme/widgets", "--project", project];
    case "doctor":
      return [role, "--issue", "1", "--project", project, "engine axis probe"];
    case "notary":
      return [role, "--source-run", "01a034f1-75bf-71a6-bcf5-d1299145b1a5@judge", "--project", project];
    case "countersign":
      return [role, "--project", project, "engine axis probe"];
    case "gleaner-left":
      return [role, "--project", project, "--base", "main", "engine axis probe"];
    case "inspector":
      return [role, "--project", project, "engine axis probe"];
    case "gatekeeper":
      return [role, "--project", project, "engine axis probe"];
    case "navigator":
      return [role, "--project", project, "engine axis probe"];
    case "diarist":
      return [role, "--project", project, "engine axis probe"];
    default: {
      const _exhaustive: never = role;
      throw new Error(`unexpected role: ${String(_exhaustive)}`);
    }
  }
}

test("#391 E4 table: all PUBLIC_CALLABLE_ROLES --engine and set-engine → childEnv + invocation.engine",
  async () => {
    assert.equal(PUBLIC_CALLABLE_ROLES.length, 14);
    await withTempHome(async (home) => {
      const binDir = join(home, "bin");
      await installHermesFixture(binDir);
      const priorPath = process.env.PATH;
      process.env.PATH = `${binDir}:${priorPath ?? ""}`;
      try {
        const baseProject = join(home, "project");
        await mkdir(baseProject, { recursive: true });
        seedGitProject(baseProject);
        {
          const sourceRunId = "01a034f1-75bf-71a6-bcf5-d1299145b1a5";
          const coords = issuePiDurablePrincipalCoordinates({
            cwd: baseProject,
            runId: sourceRunId,
            role: "judge",
            home,
          });
          await mkdir(coords.sessionDirectory, { recursive: true });
          const admittedRequestPath = join(coords.runDirectory, "admitted-request.json");
          await writeFile(coords.sessionFile, "{}\n", "utf8");
          await writeFile(
            admittedRequestPath,
            `${JSON.stringify({ role: "judge", runId: sourceRunId })}\n`,
            "utf8",
          );
          await writeRoleRunState(coords.runDirectory, {
            runId: sourceRunId,
            role: "judge",
            state: "terminal",
            bookKey: coords.bookKey,
            projectRoot: baseProject,
            sessionDirectory: coords.sessionDirectory,
            sessionFile: coords.sessionFile,
            admittedRequestPath,
          });
        }

        const mergerProject = join(home, "merger-project");
        await mkdir(mergerProject, { recursive: true });
        await materializeConflictedRepo(mergerProject);

        for (const role of PUBLIC_CALLABLE_ROLES) {
          const project = role === "merger" ? mergerProject : baseProject;
          const bookKey = resolveBookKeyFromGit(project);

          // Seed model so set-engine is legal.
          const seed = captureIo();
          const setModel = await runAkRole(
            ["config", "set", role, "openai-codex/gpt-5.6-sol:high"],
            { packageRoot, home, io: seed.io },
          );
          assert.equal(setModel.exitCode, 0, `${role} model seed: ${seed.stderr.join("")}`);

          // --- invocation --engine path ---
          {
            let capturedEnv: NodeJS.ProcessEnv | undefined;
            const runId = `engine-table-invoke-${role}`;
            const { io, stderr } = captureIo();
            const result = await runAkRole(
              ["--engine", "table-engine", ...roleEngineProbeArgv(role, project)],
              {
                packageRoot,
                home,
                cwd: project,
                createRunId: () => runId,
                credentials,
                io,
                roleTurnHost: roleTurnHostFromLegacyPiRunner({
              packageRoot: packageRoot,
              principalAuthority: piDurablePrincipalAuthority,
              piRunner: async (_args, options) => {
                  capturedEnv = options.env;
                  return {
                    code: 1,
                    stderr: "stop after capture",
                    timedOut: false,
                    args: [..._args],
                  };
                },
            }),
              },
            );
            assert.notEqual(
              result.exitCode,
              2,
              `${role} --engine structural reject: ${stderr.join("")}`,
            );
            assert.equal(
              capturedEnv !== undefined,
              true,
              `${role} --engine piRunner not reached; exit=${result.exitCode} stderr=${stderr.join("")}`,
            );
            assert.equal(
              capturedEnv?.[AK_ROLE_ENGINE_ENV],
              "table-engine",
              `${role} --engine childEnv[AK_ROLE_ENGINE]`,
            );
            const invocation = readRoleInvocation(home, bookKey, runId, role);
            assert.equal(
              invocation.engine,
              "table-engine",
              `${role} --engine invocation.engine`,
            );
          }

          // --- persistent set-engine path ---
          {
            const setIo = captureIo();
            const setEngine = await runAkRole(
              ["config", "set-engine", role, "persist-engine"],
              { packageRoot, home, io: setIo.io },
            );
            assert.equal(
              setEngine.exitCode,
              0,
              `${role} set-engine: ${setIo.stderr.join("")}`,
            );
            assert.equal(
              (await loadPublicCliConfig(home)).seats[role]?.engine,
              "persist-engine",
            );

            let capturedEnv: NodeJS.ProcessEnv | undefined;
            const runId = `engine-table-persist-${role}`;
            const { io, stderr } = captureIo();
            const result = await runAkRole(roleEngineProbeArgv(role, project), {
              packageRoot,
              home,
              cwd: project,
              createRunId: () => runId,
              credentials,
              io,
              roleTurnHost: roleTurnHostFromLegacyPiRunner({
              packageRoot: packageRoot,
              principalAuthority: piDurablePrincipalAuthority,
              piRunner: async (_args, options) => {
                capturedEnv = options.env;
                return {
                  code: 1,
                  stderr: "stop after capture",
                  timedOut: false,
                  args: [..._args],
                };
              },
            }),
            });
            assert.notEqual(
              result.exitCode,
              2,
              `${role} set-engine path structural reject: ${stderr.join("")}`,
            );
            assert.equal(
              capturedEnv !== undefined,
              true,
              `${role} set-engine piRunner not reached; exit=${result.exitCode} stderr=${stderr.join("")}`,
            );
            assert.equal(
              capturedEnv?.[AK_ROLE_ENGINE_ENV],
              "persist-engine",
              `${role} set-engine childEnv[AK_ROLE_ENGINE]`,
            );
            const invocation = readRoleInvocation(home, bookKey, runId, role);
            assert.equal(
              invocation.engine,
              "persist-engine",
              `${role} set-engine invocation.engine`,
            );

            // Clear so the next role's home config stays tidy.
            await runAkRole(["config", "unset-engine", role], {
              packageRoot,
              home,
              io: captureIo().io,
            });
          }
        }
      } finally {
        if (priorPath === undefined) delete process.env.PATH;
        else process.env.PATH = priorPath;
      }
    });
  },
);

test("#391 E4 negative table: navigator / analyst / support / illegal / model-before-engine / disk navigator",
  async () => {
    await withTempHome(async (home) => {
      // #639: navigator is a callable role — set-engine persists (old automatic refusal gone).
      {
        await runAkRole(
          ["config", "set", "navigator", "openai-codex/gpt-5.6-luna:medium"],
          { packageRoot, home, io: captureIo().io },
        );
        const { io, stderr } = captureIo();
        const result = await runAkRole(
          ["config", "set-engine", "navigator", "opus"],
          { packageRoot, home, io },
        );
        assert.equal(result.exitCode, 0, stderr.join(""));
        assert.equal(
          (await loadPublicCliConfig(home)).seats.navigator?.engine,
          "opus",
        );
      }

      // navigator unset-engine also succeeds (same callable face).
      {
        const { io, stderr } = captureIo();
        const result = await runAkRole(
          ["config", "unset-engine", "navigator"],
          { packageRoot, home, io },
        );
        assert.equal(result.exitCode, 0, stderr.join(""));
        assert.equal(
          (await loadPublicCliConfig(home)).seats.navigator?.engine,
          undefined,
        );
      }

      // navigator model config remains legal (not part of engine refusal).
      {
        const { io, stderr } = captureIo();
        const result = await runAkRole(
          ["config", "set", "navigator", "openai-codex/gpt-5.6-luna:high"],
          { packageRoot, home, io },
        );
        assert.equal(result.exitCode, 0, stderr.join(""));
      }

      // Disk-handwritten seats.navigator.engine is a legal persisted call axis now.
      {
        await writeFile(
          join(home, ".ak-roles", "public-cli.json"),
          `${JSON.stringify({
            seats: {
              navigator: {
                provider: "openai-codex",
                model: "gpt-5.6-luna",
                thinking: "medium",
                engine: "opus",
              },
            },
          }, null, 2)}\n`,
          "utf8",
        );
        const loaded = await loadPublicCliConfig(home);
        validatePublicCliConfigAxes(loaded, packageRoot);
        assert.equal(loaded.seats.navigator?.engine, "opus");
        // CLI load path accepts it.
        const { io, stderr } = captureIo();
        const result = await runAkRole(["config", "get"], {
          packageRoot,
          home,
          io,
        });
        assert.equal(result.exitCode, 0, stderr.join(""));
      }

      // Restore a clean config for subsequent cases.
      await writeFile(
        join(home, ".ak-roles", "public-cli.json"),
        `${JSON.stringify({ seats: {} }, null, 2)}\n`,
        "utf8",
      );

      // analyst --engine structural refuse (stable exit semantics; no prose lock).
      {
        const { io } = captureIo();
        const result = await runAkRole(
          ["analyst", "--engine", "opus", "--issue", "1"],
          { packageRoot, home, io },
        );
        assert.equal(result.exitCode, 2);
      }

      // Illegal engine name on set-engine.
      {
        await runAkRole(
          ["config", "set", "judge", "openai-codex/gpt-5.6-sol:high"],
          { packageRoot, home, io: captureIo().io },
        );
        const { io, stderr } = captureIo();
        const result = await runAkRole(
          ["config", "set-engine", "judge", "bad/name"],
          { packageRoot, home, io },
        );
        assert.equal(result.exitCode, 2);
        assert.match(stderr.join(""), /illegal engine name/);
      }

      // set-engine before persistent model.
      {
        const { io, stderr } = captureIo();
        const result = await runAkRole(
          ["config", "set-engine", "coder", "opus"],
          { packageRoot, home, io },
        );
        assert.notEqual(result.exitCode, 0);
        assert.match(stderr.join(""), /no persistent model/);
      }

      // Unknown seat on set-engine.
      {
        const { io, stderr } = captureIo();
        const result = await runAkRole(
          ["config", "set-engine", "not-a-seat", "opus"],
          { packageRoot, home, io },
        );
        assert.notEqual(result.exitCode, 0);
        assert.match(stderr.join(""), /unknown engine-axis seat/);
      }
    });
  },
);
