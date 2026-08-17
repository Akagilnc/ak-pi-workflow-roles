/**
 * #356 T1 / #376 — Judge-only engine axis on config → activation material seams.
 * Covers: priority, path-safety rejection, public CLI tracer, default-path byte oracle.
 * Two delivery paths: with packaged notes (cursor) / name-only without notes (opus when
 * notes absent from a root, or any free name). No closed material catalog.
 * Zero assertions on engine material body CLI invocation text.
 * Zero assertions on free-prose delivery wording / layout.
 * Non-Judge seats deliberately have no engine selection/passthrough/material.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AK_ROLE_ENGINE_ENV } from "../../src/engine-detour.ts";
import {
  resolveEngineMaterialPath,
} from "../../src/package-resources/engine-material.ts";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import {
  loadPublicCliConfig,
  resolveEffectiveSeat,
  savePublicCliConfig,
  setPersistentSeatConfig,
  setPersistentSeatEngine,
  validatePublicCliConfigEngines,
  type PublicCliConfig,
} from "../../src/public-cli/config.ts";
import {
  buildJudgeActivationExtraArgs,
} from "../../src/public-cli/judge-run.ts";
import {
  buildJudgeTransportPrompt,
  type AdmittedJudgeInvocation,
} from "../../src/public-cli/invocation.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

/** Read the durable invocation identity page for a public Judge run (#358). */
function readJudgeInvocation(
  home: string,
  bookKey: string,
  runId: string,
): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      join(home, ".ak-roles", "books", bookKey, "runs", `${runId}@judge`, "invocation.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

/** Frozen baseline golden: Judge activation argv + session initial material @ 3aec6621. */
const BASELINE_GOLDEN_PATH = join(
  packageRoot,
  "test/fixtures/engine-axis-baseline/default-path-no-engine.json",
);

type BaselineGolden = {
  provenance: {
    baseline: string;
    note: string;
    command: string;
    generator?: string;
  };
  inputs: {
    judge: AdmittedJudgeInvocation;
    packageRoot: string;
  };
  outputs: {
    judge: { transportPrompt: string; activationArgv: string[] };
  };
};

function loadBaselineGolden(): BaselineGolden {
  return JSON.parse(readFileSync(BASELINE_GOLDEN_PATH, "utf8")) as BaselineGolden;
}

/** Byte-stable JSON form used for argv/prompt oracle comparison. */
function stableBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function assertBytesEqual(actual: unknown, expected: unknown, label: string): void {
  const a = stableBytes(actual);
  const e = stableBytes(expected);
  assert.equal(
    a.equals(e),
    true,
    `${label} byte mismatch\n actual=${a.toString("utf8")}\n expect=${e.toString("utf8")}`,
  );
}

/** With-notes coordinates: name + absolute material path. No prose/layout pins. */
function assertEngineCoordinatesWithMaterial(
  prompt: string,
  engineName: string,
  materialPath: string,
): void {
  assert.equal(prompt.includes(engineName), true, `engine name missing: ${engineName}`);
  assert.equal(
    prompt.includes(materialPath),
    true,
    `material absolute path missing: ${materialPath}`,
  );
}

/** Name-only coordinates: name present, no material path, no read-bytes header, no warning. */
function assertEngineCoordinatesNameOnly(
  prompt: string,
  engineName: string,
  absentMaterialPath: string | undefined,
  stderrText: string,
): void {
  assert.equal(prompt.includes(engineName), true, `engine name missing: ${engineName}`);
  if (absentMaterialPath !== undefined) {
    assert.equal(
      prompt.includes(absentMaterialPath),
      false,
      `name-only path must not carry material path: ${absentMaterialPath}`,
    );
  }
  assert.equal(
    prompt.includes("Engine method material (read these bytes"),
    false,
    "name-only path must not emit read-these-bytes material header",
  );
  assert.equal(
    /warn/i.test(stderrText),
    false,
    `name-only path must not warn-bomb: ${stderrText}`,
  );
}

function assertNoEngineFlagsInArgv(argv: readonly string[]): void {
  assert.equal(
    argv.some((a) => a === "--engine" || a.startsWith("--ak-engine")),
    false,
    "engine must not leak as argv flag",
  );
}

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-engine-axis-"));
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
    validatePublicCliConfigEngines(reloaded, packageRoot);

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

    // Non-judge engine field is refused at validate seam (MVP judge-only).
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
    const nonJudge = await loadPublicCliConfig(home);
    assert.throws(
      () => validatePublicCliConfigEngines(nonJudge, packageRoot),
      /config seat coder engine is not allowed; engine axis is judge-only/,
    );

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
      () => validatePublicCliConfigEngines(bad, packageRoot),
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
    validatePublicCliConfigEngines(freeName, packageRoot);
    assert.equal(freeName.seats.judge?.engine, "ghost-engine");
  });
});

test("engine priority: invocation > persistent > unconfigured (judge only)", () => {
  const config = setPersistentSeatEngine(
    setPersistentSeatConfig(
      { seats: {} },
      "judge",
      { provider: "xai", model: "grok-4.5", thinking: "high" },
    ),
    "judge",
    "cursor",
  );

  const fromPersistent = resolveEffectiveSeat(config, "judge", credentials);
  assert.equal(fromPersistent.engine, "cursor");
  assert.equal(fromPersistent.engineSource, "persistent");
  assert.equal(fromPersistent.source, "persistent");

  const fromInvocation = resolveEffectiveSeat(config, "judge", credentials, {
    engine: "opus",
  });
  assert.equal(fromInvocation.engine, "opus");
  assert.equal(fromInvocation.engineSource, "invocation");
  // Model still from persistent when only engine is overridden.
  assert.equal(fromInvocation.source, "persistent");
  assert.deepEqual(fromInvocation.selection, {
    provider: "xai",
    model: "grok-4.5",
    thinking: "high",
  });

  const bare = resolveEffectiveSeat({ seats: {} }, "judge", credentials);
  assert.equal(bare.engine, undefined);
  assert.equal(bare.engineSource, "unconfigured");

  // Non-judge seats never attach engine even if invocation carries one.
  const fixer = resolveEffectiveSeat({ seats: {} }, "fixer", credentials, {
    engine: "opus",
  });
  assert.equal(fixer.engine, undefined);
  assert.equal(fixer.engineSource, "unconfigured");
});

// --- default-path byte oracle (frozen baseline 3aec6621 golden) --------------

test("default path byte oracle: no-engine judge activation argv + transport prompt match frozen baseline", () => {
  const golden = loadBaselineGolden();
  assert.equal(golden.provenance.baseline, "3aec6621");

  const { judge } = golden.inputs;

  // Construction-head builders under the same frozen inputs must match golden bytes.
  assertBytesEqual(
    buildJudgeTransportPrompt(judge),
    golden.outputs.judge.transportPrompt,
    "judge transport prompt",
  );
  assertBytesEqual(
    buildJudgeActivationExtraArgs(judge, {}),
    golden.outputs.judge.activationArgv,
    "judge activation argv",
  );
});

test("engine material delivery: cursor with-notes coordinates; argv gains no engine flags", () => {
  const judge: AdmittedJudgeInvocation = {
    role: "judge",
    runId: "run-engine-oracle",
    bookKey: "book",
    projectRoot: "/project",
    instruction: "Decide the matter.",
    instructionEmpty: false,
    attachments: [],
    runDirectory: "/runs/r",
    sessionDirectory: "/runs/r/session",
    sessionFile: "/runs/r/session/session.jsonl",
    admittedRequestPath: "/runs/r/admitted-request.json",
  };
  const without = buildJudgeActivationExtraArgs(judge, { packageRoot });
  const withEngine = buildJudgeActivationExtraArgs(judge, {
    packageRoot,
    engine: "cursor",
  });
  assert.notEqual(without.at(-1), withEngine.at(-1));
  const prompt = withEngine.at(-1)!;
  const materialPath = resolveEngineMaterialPath(packageRoot, "cursor");
  assert.equal(existsSync(materialPath), true, "cursor notes must be packaged");
  assertEngineCoordinatesWithMaterial(prompt, "cursor", materialPath);
  assertNoEngineFlagsInArgv(withEngine);
  // Model argv path unchanged when model omitted.
  assert.equal(withEngine.includes("--provider"), false);
});

test("engine name-only delivery: free name without notes carries name, no path", () => {
  const judge: AdmittedJudgeInvocation = {
    role: "judge",
    runId: "run-engine-name-only",
    bookKey: "book",
    projectRoot: "/project",
    instruction: "Decide the matter.",
    instructionEmpty: false,
    attachments: [],
    runDirectory: "/runs/r",
    sessionDirectory: "/runs/r/session",
    sessionFile: "/runs/r/session/session.jsonl",
    admittedRequestPath: "/runs/r/admitted-request.json",
  };
  // Use a well-formed name that has no packaged notes file.
  const freeName = "nope-engine";
  const withEngine = buildJudgeActivationExtraArgs(judge, {
    packageRoot,
    engine: freeName,
  });
  const prompt = withEngine.at(-1)!;
  const absentPath = resolveEngineMaterialPath(packageRoot, freeName);
  assert.equal(existsSync(absentPath), false, "fixture assumes no notes for free name");
  assertEngineCoordinatesNameOnly(prompt, freeName, absentPath, "");
  assertNoEngineFlagsInArgv(withEngine);
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
          piRunner: async (args) => {
            capturedArgs = [...args];
            return {
              code: 1,
              stderr: "stop after capture",
              timedOut: false,
              args: [...args],
            };
          },
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
      const capturedPrompt = String(capturedArgs!.at(-1) ?? "");
      assertEngineCoordinatesWithMaterial(capturedPrompt, "cursor", materialCursor);
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
          piRunner: async (args) => {
            capturedArgs = [...args];
            return {
              code: 1,
              stderr: "stop after capture",
              timedOut: false,
              args: [...args],
            };
          },
        },
      );
      assert.notEqual(result.exitCode, 2, stderr.join(""));
      const capturedPrompt = String(capturedArgs!.at(-1) ?? "");
      const materialOpus = resolveEngineMaterialPath(packageRoot, "opus");
      if (existsSync(materialOpus)) {
        assertEngineCoordinatesWithMaterial(capturedPrompt, "opus", materialOpus);
      } else {
        assertEngineCoordinatesNameOnly(
          capturedPrompt,
          "opus",
          materialOpus,
          stderr.join(""),
        );
      }
      // Override must not keep the persistent engine material path.
      assert.equal(capturedPrompt.includes(materialCursor), false);
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
          piRunner: async (args) => {
            capturedArgs = [...args];
            return {
              code: 1,
              stderr: "stop after capture",
              timedOut: false,
              args: [...args],
            };
          },
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
      const capturedPrompt = String(capturedArgs!.at(-1) ?? "");
      const absentPath = resolveEngineMaterialPath(packageRoot, "nope-engine");
      assertEngineCoordinatesNameOnly(
        capturedPrompt,
        "nope-engine",
        absentPath,
        stderr.join(""),
      );
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
      const capturedPrompt = String(capturedArgs!.at(-1) ?? "");
      const absentPath = resolveEngineMaterialPath(packageRoot, "company..opus");
      assertEngineCoordinatesNameOnly(
        capturedPrompt,
        "company..opus",
        absentPath,
        stderr.join(""),
      );
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

    // Non-judge command with --engine → structural reject (MVP judge-only).
    {
      const { io, stderr } = captureIo();
      const result = await runAkRole(
        ["coder", "--engine", "opus", "--project", project, "x"],
        { packageRoot, home, cwd: project, credentials, io },
      );
      assert.equal(result.exitCode, 2);
      assert.match(stderr.join(""), /engine axis is judge-only; refused command coder/);
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

    // set-engine on non-judge seat rejects.
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
      assert.equal(result.exitCode, 2);
      assert.match(stderr.join(""), /engine axis is judge-only; refused seat coder/);
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
      assert.equal(
        String(capturedArgs!.at(-1) ?? "").includes(materialOpus),
        false,
        "engine-free run must not deliver ambient engine material",
      );
    });
  } finally {
    if (previous === undefined) delete process.env[AK_ROLE_ENGINE_ENV];
    else process.env[AK_ROLE_ENGINE_ENV] = previous;
  }
});

test("unset-engine clears persistent judge engine; no-engine path keeps default-path oracle", async () => {
  await withTempHome(async (home) => {
    await runAkRole(
      ["config", "set", "judge", "openai-codex/gpt-5.6-sol:high"],
      { packageRoot, home, io: captureIo().io },
    );
    await runAkRole(
      ["config", "set-engine", "judge", "cursor"],
      { packageRoot, home, io: captureIo().io },
    );
    assert.equal((await loadPublicCliConfig(home)).seats.judge?.engine, "cursor");

    const unset = await runAkRole(
      ["config", "unset-engine", "judge"],
      { packageRoot, home, io: captureIo().io },
    );
    assert.equal(unset.exitCode, 0);
    const after = await loadPublicCliConfig(home);
    assert.equal(after.seats.judge?.engine, undefined);

    // Transport oracle: judge without engine remains exact frozen default-path bytes.
    const golden = loadBaselineGolden();
    assertBytesEqual(
      buildJudgeTransportPrompt(golden.inputs.judge),
      golden.outputs.judge.transportPrompt,
      "judge transport after unset-engine path",
    );
  });
});
