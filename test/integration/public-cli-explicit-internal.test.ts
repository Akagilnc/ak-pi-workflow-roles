import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
/**
 * Pi adapter seam — controlled session + close-once three paths (#526 acceptance B).
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import test from "node:test";

import { ExplicitInternalActivationError } from "../../src/host-contracts.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import {
  createDefaultPiSpawnRunner,
  createPiRoleTurnHost,
  type LaunchedPiIdentity,
} from "../../src/pi/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";

import { packageRoot, seedGitRepository } from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { isolatedTestProcessEnv, writeVersionAwarePiShim } from "../helpers/test-process-fixtures.ts";


async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("ak-public-cli-explicit-internal-", async (home) => {
    seedGitRepository(home);
    return await scenario(home);
  });
}

async function writeExecutableStub(path: string, source: string): Promise<void> {
  await writeVersionAwarePiShim(
    path,
    source.replace(/^#!\/usr\/bin\/env node/, `#!${process.execPath}`),
  );
}

/** Isolation masks AK_ROLE_RUN_DIR; overlay it when identity capture is under test. */
function spawnEnv(options: {
  env: NodeJS.ProcessEnv;
  home: string;
  agentDir: string;
  runDirectory?: string;
}): NodeJS.ProcessEnv {
  const env = isolatedTestProcessEnv({
    env: options.env,
    home: options.home,
    agentDir: options.agentDir,
  });
  if (options.runDirectory !== undefined) env.AK_ROLE_RUN_DIR = options.runDirectory;
  return env;
}

async function waitForFile(
  path: string,
  childResult?: Promise<unknown>,
): Promise<void> {
  for (let checks = 0; checks < 100_000; checks += 1) {
    try {
      await readFile(path, "utf8");
      return;
    } catch {
      await Promise.race([
        new Promise<void>((resolve) => setImmediate(resolve)),
        childResult?.then(() => {
          throw new Error(`child exited before readiness marker: ${path}`);
        }),
      ]);
    }
  }
  throw new Error(`readiness marker not observed: ${path}`);
}

const sessionLine = `${JSON.stringify({
  type: "message",
  message: {
    role: "toolResult",
    toolName: JUDGE_OUTPUT_TOOL_NAME,
    isError: false,
    details: { judgeStatus: "converged", note: "pre-timeout lawful verdict" },
  },
})}\n`;

/** Capture Pi identity via the production recording callback (result no longer carries it). */
function spawnRunnerWithIdentityCapture(): {
  runner: ReturnType<typeof createDefaultPiSpawnRunner>;
  lastIdentity: () => LaunchedPiIdentity | undefined;
} {
  let last: LaunchedPiIdentity | undefined;
  const runner = createDefaultPiSpawnRunner({
    recordLaunchedPiIdentity: async (_runDirectory, identity) => {
      last = identity;
    },
  });
  return { runner, lastIdentity: () => last };
}

function minimalTurnRequest(home: string, runDirectory: string): RoleTurnRequest {
  const principal = piDurablePrincipalAuthority.issue({
    cwd: home,
    runId: "explicit-internal-test",
    role: "judge",
    home,
  });
  return {
    principal,
    activation: { role: "judge" },
    methods: [],
    continuation: { kind: "initial", prompt: "probe" },
    cwd: home,
    home,
    agentDir: join(home, ".pi", "agent"),
    runDirectory,
  };
}

test("default runner preserves unexpected executable filesystem failures", async () => {
  await withTempHome(async (home) => {
    const loop = join(home, "pi-loop");
    await symlink(loop, loop);
    const { runner } = spawnRunnerWithIdentityCapture();
    await assert.rejects(
      runner([], {
        cwd: home,
        env: spawnEnv({ env: { PATH: home, PI_BINARY: loop }, home, agentDir: join(home, ".pi", "agent") }),
      }),
      (error: unknown) =>
        error instanceof ExplicitInternalActivationError &&
        error.knownCause === "activation" &&
        (error.cause as NodeJS.ErrnoException | undefined)?.code === "ELOOP" &&
        !error.message.includes("Pi executable not found"),
    );
  });
});

test("default runner resolves PI_BINARY and PATH with the child cwd semantics", async () => {
  await withTempHome(async (home) => {
    const childCwd = join(home, "child");
    const bin = join(childCwd, "bin");
    await mkdir(bin, { recursive: true });
    const pi = join(bin, "pi");
    await writeExecutableStub(pi, `#!${process.execPath}\nprocess.exit(0);\n`);
    const runDirectory = join(home, "run");
    await mkdir(runDirectory, { recursive: true });

    const cases = [
      { name: "relative PI_BINARY", command: "bin/pi", path: "/no/such/path", expected: pi },
      { name: "relative PATH entry", command: "pi", path: "bin", expected: pi },
      { name: "empty PATH entry", command: "pi", path: `${delimiter}missing`, expected: join(childCwd, "pi") },
    ] as const;
    await symlink(pi, join(childCwd, "pi"));
    for (const scenario of cases) {
      const { runner, lastIdentity } = spawnRunnerWithIdentityCapture();
      const result = await runner([], {
        cwd: childCwd,
        env: spawnEnv({
          env: {
            PATH: scenario.path,
            PI_BINARY: scenario.command,
          },
          home,
          agentDir: join(home, ".pi", "agent"),
          runDirectory,
        }),
      });
      assert.equal(result.code, 0, scenario.name);
      assert.equal(lastIdentity()?.executable, await realpath(scenario.expected), scenario.name);
      assert.equal(lastIdentity()?.version, "test-pi-1.0.0", scenario.name);
    }

    if (process.platform !== "win32") {
      const { runner, lastIdentity } = spawnRunnerWithIdentityCapture();
      const result = await runner(["-c", "true"], {
        cwd: childCwd,
        env: spawnEnv({
          env: { PI_BINARY: "bash" },
          home,
          agentDir: join(home, ".pi", "agent"),
          runDirectory,
        }),
      });
      assert.equal(result.code, 0, "missing PATH uses Node's platform default");
      assert.match(lastIdentity()?.version ?? "", /bash/i);
    }
  });
});

test("default runner waits for child readiness without an implicit timeout", async () => {
  await withTempHome(async (home) => {
    const ready = join(home, "ready");
    const release = join(home, "release");
    const marker = join(home, "survived");
    const signal = join(home, "signal");
    const stub = join(home, "ready-child.mjs");
    await writeExecutableStub(
      stub,
      `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(ready)}, "ready");
const timer = setInterval(() => {
  if (existsSync(${JSON.stringify(release)})) {
    clearInterval(timer);
    writeFileSync(${JSON.stringify(marker)}, "alive");
    process.exit(0);
  }
}, 1);
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(signal)}, "SIGTERM");
  process.exit(143);
});
`,
    );

    const { runner } = spawnRunnerWithIdentityCapture();
    const resultPromise = runner(["--help"], {
      cwd: home,
      env: spawnEnv({ env: { ...process.env, PI_BINARY: stub }, home, agentDir: join(home, ".pi", "agent") }),
    });
    await waitForFile(ready, resultPromise);
    await writeFile(release, "release", "utf8");
    const result = await resultPromise;

    assert.equal(result.timedOut, false);
    assert.equal(result.code, 0);
    assert.equal(await readFile(marker, "utf8"), "alive");
    await assert.rejects(readFile(signal, "utf8"));
  });
});

test("explicit short budget sends only SIGTERM after readiness and preserves prior session output", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await withTempHome(async (home) => {
    const signalFile = join(home, "signal");
    const ready = join(home, "ready");
    const sessionDir = join(home, "session");
    const stub = join(home, "term-child.mjs");
    const runDirectory = join(home, "run");
    await mkdir(sessionDir, { recursive: true });
    await mkdir(runDirectory, { recursive: true });
    await writeExecutableStub(
      stub,
      `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const index = args.indexOf("--session-dir");
const sessionDir = index >= 0 ? args[index + 1] : ${JSON.stringify(sessionDir)};
mkdirSync(sessionDir, { recursive: true });
writeFileSync(join(sessionDir, "session.jsonl"), ${JSON.stringify(sessionLine)}, "utf8");
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(signalFile)}, "SIGTERM");
  process.exit(143);
});
process.on("SIGINT", () => {
  writeFileSync(${JSON.stringify(signalFile)}, "SIGINT");
  process.exit(130);
});
writeFileSync(${JSON.stringify(ready)}, "ready");
setInterval(() => {}, 1000);
`,
    );

    const host = createPiRoleTurnHost({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      timeoutMs: 750,
      spawnRunner: createDefaultPiSpawnRunner({}),
    });
    // Force PI_BINARY via env on the host by wrapping spawn
    const baseSpawn = createDefaultPiSpawnRunner({});
    const hostWithStub = createPiRoleTurnHost({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      timeoutMs: 750,
      spawnRunner: async (args, options) =>
        baseSpawn(args, {
          ...options,
          env: { ...options.env, PI_BINARY: stub },
        }),
    });

    const principal = piDurablePrincipalAuthority.issue({
      cwd: home,
      runId: "timeout-test",
      role: "judge",
      home,
    });
    // Use the issued principal's real session dir so argv session-dir matches stub write
    const coords = piDurablePrincipalAuthority.decode(principal);
    await mkdir(coords.sessionDirectory, { recursive: true });

    const resultPromise = hostWithStub.executeTurn({
      principal,
      activation: { role: "judge" },
      methods: [],
      continuation: { kind: "initial", prompt: "help-probe" },
      cwd: home,
      home,
      agentDir: join(home, ".pi", "agent"),
      runDirectory,
      timeoutMs: 750,
    });
    await waitForFile(ready, resultPromise);
    t.mock.timers.tick(750);
    const result = await resultPromise;

    assert.equal(result.timedOut, true);
    assert.notEqual(result.code, 0);
    assert.equal(await readFile(signalFile, "utf8"), "SIGTERM");
    assert.equal(
      await readFile(join(coords.sessionDirectory, "session.jsonl"), "utf8"),
      sessionLine,
    );
  });
});

test("turn host canonicalizes an aliased role entry once for argv", async () => {
  await withTempHome(async (home) => {
    const packageAlias = join(home, "package-alias");
    const runDirectory = join(home, "run");
    await symlink(packageRoot, packageAlias);
    await mkdir(runDirectory);

    let launchedArgs: readonly string[] = [];
    const host = createPiRoleTurnHost({
      packageRoot: packageAlias,
      principalAuthority: piDurablePrincipalAuthority,
      spawnRunner: async (args) => {
        launchedArgs = args;
        return { code: 0, stderr: "", timedOut: false };
      },
    });
    await host.executeTurn(minimalTurnRequest(home, runDirectory));

    const selectedEntry = launchedArgs[launchedArgs.indexOf("-e") + 1];
    assert.equal(selectedEntry, await realpath(join(packageAlias, "extensions", "role-runtime.ts")));
  });
});

test("turn host masks ambient ledger and machine Pi home after env remerge", async () => {
  await withTempHome(async (home) => {
    const machineRun = join(home, "machine-run");
    const machineAgent = join(home, "machine-agent");
    const testAgent = join(home, "test-agent");
    const invocation = join(machineRun, "invocation.json");
    const machineMarker = join(machineAgent, "marker");
    const observed = join(home, "observed.json");
    await mkdir(machineRun, { recursive: true });
    await mkdir(machineAgent, { recursive: true });
    await writeFile(invocation, "outer-invocation", "utf8");
    await writeFile(machineMarker, "machine-home", "utf8");
    const stub = join(home, "env-child.mjs");
    await writeExecutableStub(stub, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ run: process.env.AK_ROLE_RUN_DIR, agent: process.env.PI_CODING_AGENT_DIR }));
process.exit(0);
`);

    const previousRun = process.env.AK_ROLE_RUN_DIR;
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    process.env.AK_ROLE_RUN_DIR = machineRun;
    process.env.PI_CODING_AGENT_DIR = machineAgent;
    try {
      const baseSpawn = createDefaultPiSpawnRunner({});
      const host = createPiRoleTurnHost({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        spawnRunner: async (args, options) =>
          baseSpawn(args, {
            ...options,
            env: { ...options.env, PI_BINARY: stub },
          }),
      });
      const runDirectory = join(home, "test-run");
      await mkdir(runDirectory, { recursive: true });
      const result = await host.executeTurn({
        ...minimalTurnRequest(home, runDirectory),
        agentDir: testAgent,
      });
      assert.equal(result.code, 0);
    } finally {
      if (previousRun === undefined) delete process.env.AK_ROLE_RUN_DIR;
      else process.env.AK_ROLE_RUN_DIR = previousRun;
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgent;
    }

    assert.deepEqual(JSON.parse(await readFile(observed, "utf8")), {
      run: join(home, "test-run"),
      agent: testAgent,
    });
    assert.equal(await readFile(invocation, "utf8"), "outer-invocation");
    assert.equal(await readFile(machineMarker, "utf8"), "machine-home");
  });
});

test("parent discards child stdout without inheriting the parent role ledger", async () => {
  await withTempHome(async (home) => {
    const parentRun = join(home, "parent-run");
    const invocation = join(parentRun, "invocation.json");
    await mkdir(parentRun, { recursive: true });
    await writeFile(invocation, "parent-identity", "utf8");
    const stub = join(home, "flood-stdout.mjs");
    await writeExecutableStub(
      stub,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const chunk = "X".repeat(64 * 1024);
if (process.env.AK_ROLE_RUN_DIR) writeFileSync(join(process.env.AK_ROLE_RUN_DIR, "invocation.json"), "overwritten", "utf8");
for (let i = 0; i < 200; i++) process.stdout.write(chunk);
process.stderr.write("stderr-ok");
process.exit(0);
`,
    );

    const { runner } = spawnRunnerWithIdentityCapture();
    const result = await runner(["x"], {
      cwd: home,
      env: spawnEnv({
        env: { ...process.env, AK_ROLE_RUN_DIR: parentRun, PI_BINARY: stub },
        home,
        agentDir: join(home, ".pi", "agent"),
      }),
    });

    assert.equal(result.code, 0);
    assert.equal(await readFile(invocation, "utf8"), "parent-identity");
    assert.equal(Object.hasOwn(result, "stdout"), false);
    assert.ok(result.stderr.includes("stderr-ok"));
  });
});

test("close settles once on natural return, execution error, and SIGTERM timeout", async (t) => {
  await withTempHome(async (home) => {
    // Natural return
    {
      const stub = join(home, "natural.mjs");
      await writeExecutableStub(stub, `#!/usr/bin/env node\nprocess.stderr.write("ok");\nprocess.exit(0);\n`);
      const { runner } = spawnRunnerWithIdentityCapture();
      const result = await runner([], {
        cwd: home,
        env: spawnEnv({ env: { PI_BINARY: stub }, home, agentDir: join(home, "a") }),
      });
      assert.equal(result.timedOut, false);
      assert.equal(result.code, 0);
      assert.equal(result.stderr, "ok");
    }
    // Pre-spawn activation failure has no child close and must reject with the
    // host-contract typed activation error; zero close is possible without a child.
    // The typed rejection originates from the resolution owner BEFORE spawn(), so
    // no close event can own settlement (any spawn/close settlement would carry a
    // raw error identity instead of the typed activation error).
    {
      const { runner } = spawnRunnerWithIdentityCapture();
      await assert.rejects(
        runner([], {
          cwd: home,
          env: spawnEnv({
            env: { PI_BINARY: join(home, "missing-binary") },
            home,
            agentDir: join(home, "a"),
          }),
        }),
        (error: unknown) => {
          // Typed activation failure, not an arbitrary Error, and never a child close.
          return error instanceof ExplicitInternalActivationError
            && error.knownCause === "activation";
        },
      );
    }
    // Spawned execution error: a real child that crashes (SIGABRT) settles
    // exactly once through close, resolved with its true outcome shape (null
    // exit code) rather than rejected — a child execution failure is a child
    // outcome, not a host re-attachment.
    {
      const stub = join(home, "spawned-error.mjs");
      await writeExecutableStub(stub, `#!/usr/bin/env node\nprocess.abort();\n`);
      const { runner } = spawnRunnerWithIdentityCapture();
      const value = await runner([], {
        cwd: home,
        env: spawnEnv({ env: { PI_BINARY: stub }, home, agentDir: join(home, "a") }),
      });
      assert.equal(value.timedOut, false);
      assert.notEqual(value.code, 0);
    }
    // SIGTERM timeout
    {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const ready = join(home, "to-ready");
      const signal = join(home, "to-signal");
      const stub = join(home, "timeout.mjs");
      await writeExecutableStub(
        stub,
        `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(signal)}, "SIGTERM"); process.exit(143); });
writeFileSync(${JSON.stringify(ready)}, "ready");
setInterval(() => {}, 1000);
`,
      );
      const { runner } = spawnRunnerWithIdentityCapture();
      const resultPromise = runner([], {
        cwd: home,
        env: spawnEnv({ env: { PI_BINARY: stub }, home, agentDir: join(home, "a") }),
        timeoutMs: 500,
      });
      await waitForFile(ready, resultPromise);
      t.mock.timers.tick(500);
      const result = await resultPromise;
      assert.equal(result.timedOut, true);
      assert.equal(await readFile(signal, "utf8"), "SIGTERM");
      t.mock.timers.reset();
    }
  });
});
