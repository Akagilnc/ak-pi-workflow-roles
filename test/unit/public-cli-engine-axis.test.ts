/**
 * #356 T1 — engine axis on existing per-seat config → activation material seams.
 * Covers: priority, illegal rejection, public CLI tracer, default-path byte oracle.
 * Zero assertions on engine material body CLI invocation text.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  COLLECTOR_FIXED_KICKOFF,
} from "../../src/collector-config.ts";
import {
  resolveEngineMaterialPath,
} from "../../src/package-resources/engine-material.ts";
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
import { assertLegalEngineName } from "../../src/package-resources/engine-material.ts";
import {
  buildCollectorActivationExtraArgs,
  type CollectorRunEnv,
} from "../../src/public-cli/collector-run.ts";
import {
  buildCoderActivationExtraArgs,
} from "../../src/public-cli/coder-run.ts";
import {
  buildJudgeActivationExtraArgs,
} from "../../src/public-cli/judge-run.ts";
import {
  buildCollectorTransportPrompt,
  buildCoderTransportPrompt,
  buildJudgeTransportPrompt,
  type AdmittedCoderInvocation,
  type AdmittedCollectorInvocation,
  type AdmittedJudgeInvocation,
} from "../../src/public-cli/invocation.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

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

function judgeAdmitted(overrides: Partial<AdmittedJudgeInvocation> = {}): AdmittedJudgeInvocation {
  return {
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
    ...overrides,
  };
}

function coderAdmitted(): AdmittedCoderInvocation {
  return {
    role: "coder",
    runId: "run-engine-oracle",
    bookKey: "book",
    projectRoot: "/project",
    phase: "apply",
    instruction: "Implement the slice.",
    instructionEmpty: false,
    attachments: [],
    runDirectory: "/runs/r",
    sessionDirectory: "/runs/r/session",
    sessionFile: "/runs/r/session/session.jsonl",
    admittedRequestPath: "/runs/r/admitted-request.json",
    taskPath: "/runs/r/task.md",
  };
}

function collectorAdmitted(): AdmittedCollectorInvocation {
  return {
    role: "collector",
    runId: "run-engine-oracle",
    bookKey: "book",
    projectRoot: "/project",
    instruction: "",
    instructionEmpty: true,
    attachments: [],
    runDirectory: "/runs/r",
    sessionDirectory: "/runs/r/session",
    sessionFile: "/runs/r/session/session.jsonl",
    admittedRequestPath: "/runs/r/admitted-request.json",
    prNumber: 42,
    repository: {
      display: "acme/widgets",
      canonical: "acme/widgets",
      owner: "acme",
      repo: "widgets",
    },
    manifestDigest: "abc",
  };
}

// --- config parse + priority -------------------------------------------------

test("persistent seat engine round-trips; illegal engine rejected at parse/validate", async () => {
  await withTempHome(async (home) => {
    let config: PublicCliConfig = { seats: {} };
    config = setPersistentSeatConfig(config, "judge", {
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "high",
    });
    config = setPersistentSeatEngine(config, "judge", "kimi");
    await savePublicCliConfig(config, home);

    const reloaded = await loadPublicCliConfig(home);
    assert.equal(reloaded.seats.judge?.engine, "kimi");
    assert.deepEqual(
      {
        provider: reloaded.seats.judge?.provider,
        model: reloaded.seats.judge?.model,
        thinking: reloaded.seats.judge?.thinking,
      },
      { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
    );
    // Validate accepts legal names against package materials.
    validatePublicCliConfigEngines(reloaded, packageRoot, assertLegalEngineName);

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

    // Illegal engine name in on-disk config is rejected at validate seam.
    await writeFile(
      join(home, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({
        seats: {
          judge: {
            provider: "openai-codex",
            model: "gpt-5.6-sol",
            thinking: "high",
            engine: "not-a-real-engine",
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const bad = await loadPublicCliConfig(home);
    assert.throws(
      () => validatePublicCliConfigEngines(bad, packageRoot, assertLegalEngineName),
      /config seat judge engine is unknown: not-a-real-engine/,
    );
  });
});

test("engine priority: invocation > persistent > unconfigured", () => {
  const config = setPersistentSeatEngine(
    setPersistentSeatConfig(
      { seats: {} },
      "fixer",
      { provider: "xai", model: "grok-4.5", thinking: "high" },
    ),
    "fixer",
    "cursor",
  );

  const fromPersistent = resolveEffectiveSeat(config, "fixer", credentials);
  assert.equal(fromPersistent.engine, "cursor");
  assert.equal(fromPersistent.engineSource, "persistent");
  assert.equal(fromPersistent.source, "persistent");

  const fromInvocation = resolveEffectiveSeat(config, "fixer", credentials, {
    engine: "kimi",
  });
  assert.equal(fromInvocation.engine, "kimi");
  assert.equal(fromInvocation.engineSource, "invocation");
  // Model still from persistent when only engine is overridden.
  assert.equal(fromInvocation.source, "persistent");
  assert.deepEqual(fromInvocation.selection, {
    provider: "xai",
    model: "grok-4.5",
    thinking: "high",
  });

  const bare = resolveEffectiveSeat({ seats: {} }, "fixer", credentials);
  assert.equal(bare.engine, undefined);
  assert.equal(bare.engineSource, "unconfigured");
});

// --- default-path byte oracle (baseline 3aec6621 shape) ----------------------

test("default path byte oracle: no-engine activation argv + transport prompt stable", () => {
  const judge = judgeAdmitted();
  const judgePrompt = buildJudgeTransportPrompt(judge);
  assert.equal(judgePrompt, "Decide the matter.");
  const judgeArgs = buildJudgeActivationExtraArgs(judge, {});
  assert.deepEqual(judgeArgs, [
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session",
    judge.sessionFile,
    "--session-dir",
    judge.sessionDirectory,
    "--ak-role",
    "judge",
    "--mode",
    "json",
    "Decide the matter.",
  ]);

  const coder = coderAdmitted();
  const coderPrompt = buildCoderTransportPrompt(coder);
  assert.equal(coderPrompt, "Implement the slice.");
  const coderArgs = buildCoderActivationExtraArgs(coder, { packageRoot });
  // Prompt tail must remain the bare instruction (no engine section).
  assert.equal(coderArgs.at(-1), "Implement the slice.");
  assert.equal(coderArgs.includes("--provider"), false);

  const collector = collectorAdmitted();
  const collectorPrompt = buildCollectorTransportPrompt(collector);
  assert.equal(collectorPrompt, COLLECTOR_FIXED_KICKOFF);
  const collectorArgs = buildCollectorActivationExtraArgs(collector, {});
  assert.equal(collectorArgs.at(-1), COLLECTOR_FIXED_KICKOFF);
});

test("engine material delivery changes prompt stably; argv gains no engine flags", () => {
  const judge = judgeAdmitted();
  const without = buildJudgeActivationExtraArgs(judge, { packageRoot });
  const withEngine = buildJudgeActivationExtraArgs(judge, {
    packageRoot,
    engine: "kimi",
  });
  assert.notEqual(without.at(-1), withEngine.at(-1));
  const prompt = withEngine.at(-1)!;
  const materialPath = resolveEngineMaterialPath(packageRoot, "kimi");
  assert.match(prompt, /Engine method material/);
  assert.match(prompt, /- engine: kimi/);
  assert.equal(prompt.includes(materialPath), true);
  // No new pi / ak-engine flag surface.
  assert.equal(withEngine.some((a) => a === "--engine" || a.startsWith("--ak-engine")), false);
  // Model argv path unchanged when model omitted.
  assert.equal(withEngine.includes("--provider"), false);
});

// --- public CLI tracer -------------------------------------------------------

test("public CLI --engine and config set-engine both deliver material; flag wins; illegal rejects", async () => {
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
    const materialKimi = resolveEngineMaterialPath(packageRoot, "kimi");
    await access(materialCursor);
    await access(materialKimi);

    // Persistent engine alone.
    {
      let capturedPrompt: string | undefined;
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
            capturedPrompt = String(args.at(-1) ?? "");
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
        typeof capturedPrompt,
        "string",
        `piRunner not reached; exit=${result.exitCode} stderr=${stderr.join("")}`,
      );
      assert.equal(capturedPrompt!.includes("- engine: cursor"), true);
      assert.equal(capturedPrompt!.includes(materialCursor), true);
    }

    // Invocation --engine overrides persistent.
    {
      let capturedPrompt: string | undefined;
      const { io, stderr } = captureIo();
      const result = await runAkRole(
        [
          "--engine",
          "kimi",
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
            capturedPrompt = String(args.at(-1) ?? "");
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
      assert.equal(capturedPrompt!.includes("- engine: kimi"), true);
      assert.equal(capturedPrompt!.includes(materialKimi), true);
      assert.equal(capturedPrompt!.includes("- engine: cursor"), false);
    }

    // Illegal --engine → structural reject (exit 2), not role submission.
    {
      const { io, stderr } = captureIo();
      const result = await runAkRole(
        ["judge", "--engine", "nope-engine", "--project", project, "x"],
        { packageRoot, home, cwd: project, credentials, io },
      );
      assert.equal(result.exitCode, 2);
      assert.match(stderr.join(""), /unknown engine: nope-engine/);
    }

    // Illegal persistent engine on load → structural reject.
    {
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
      const { io, stderr } = captureIo();
      const result = await runAkRole(
        ["judge", "--project", project, "x"],
        { packageRoot, home, cwd: project, credentials, io },
      );
      assert.equal(result.exitCode, 2);
      assert.match(stderr.join(""), /config seat judge engine is unknown: ghost-engine/);
    }

    // set-engine with unknown name rejects without writing.
    {
      // restore legal config first
      await runAkRole(
        ["config", "set", "judge", "openai-codex/gpt-5.6-sol:high"],
        { packageRoot, home, io: captureIo().io },
      );
      const { io, stderr } = captureIo();
      const result = await runAkRole(
        ["config", "set-engine", "judge", "still-fake"],
        { packageRoot, home, io },
      );
      assert.equal(result.exitCode, 2);
      assert.match(stderr.join(""), /unknown engine: still-fake/);
    }
  });
});

test("unset-engine clears persistent engine; no-engine path keeps collector kickoff exact", async () => {
  await withTempHome(async (home) => {
    await runAkRole(
      ["config", "set", "collector", "openai-codex/gpt-5.6-sol:high"],
      { packageRoot, home, io: captureIo().io },
    );
    await runAkRole(
      ["config", "set-engine", "collector", "codex"],
      { packageRoot, home, io: captureIo().io },
    );
    assert.equal((await loadPublicCliConfig(home)).seats.collector?.engine, "codex");

    const unset = await runAkRole(
      ["config", "unset-engine", "collector"],
      { packageRoot, home, io: captureIo().io },
    );
    assert.equal(unset.exitCode, 0);
    const after = await loadPublicCliConfig(home);
    assert.equal(after.seats.collector?.engine, undefined);

    // Transport oracle: collector without engine remains exact fixed kickoff.
    assert.equal(
      buildCollectorTransportPrompt(collectorAdmitted()),
      COLLECTOR_FIXED_KICKOFF,
    );
  });
});

// Silence unused type import if Tree-shaken away in some runners.
void (null as unknown as CollectorRunEnv);
