import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import {
  defaultExplicitInternalPiRunner,
  runExplicitInternalActivation,
} from "../../src/public-cli/explicit-internal.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { isolatedTestProcessEnv, writeVersionAwarePiShim } from "../helpers/test-process-fixtures.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-public-cli-explicit-internal-"));
  try {
    return await scenario(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function writeExecutableStub(path: string, source: string): Promise<void> {
  await writeVersionAwarePiShim(path, source);
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

test("default runner preserves unexpected executable filesystem failures", async () => {
  await withTempHome(async (home) => {
    const loop = join(home, "pi-loop");
    await symlink(loop, loop);
    await assert.rejects(
      defaultExplicitInternalPiRunner([], {
        cwd: home,
        env: isolatedTestProcessEnv({ env: { PATH: home, PI_BINARY: loop }, home, agentDir: join(home, ".pi", "agent") }),
      }),
      (error: NodeJS.ErrnoException) => error.code === "ELOOP" && !error.message.includes("Pi executable not found"),
    );
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

    const resultPromise = defaultExplicitInternalPiRunner(["--help"], {
      cwd: home,
      env: isolatedTestProcessEnv({ env: { ...process.env, PI_BINARY: stub }, home, agentDir: join(home, ".pi", "agent") }),
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
    await mkdir(sessionDir, { recursive: true });
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

    const resultPromise = runExplicitInternalActivation({
      packageRoot,
      extraArgs: ["--session-dir", sessionDir, "--help"],
      cwd: home,
      home,
      agentDir: join(home, ".pi", "agent"),
      timeoutMs: 750,
      env: { PI_BINARY: stub },
    });
    await waitForFile(ready, resultPromise);
    t.mock.timers.tick(750);
    const result = await resultPromise;

    assert.equal(result.timedOut, true);
    assert.notEqual(result.code, 0);
    assert.equal(await readFile(signalFile, "utf8"), "SIGTERM");
    assert.equal((await readFile(join(sessionDir, "session.jsonl"), "utf8")), sessionLine);
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

    const result = await defaultExplicitInternalPiRunner(["x"], {
      cwd: home,
      env: isolatedTestProcessEnv({ env: { ...process.env, AK_ROLE_RUN_DIR: parentRun, PI_BINARY: stub }, home, agentDir: join(home, ".pi", "agent") }),
    });

    assert.equal(result.code, 0);
    assert.equal(await readFile(invocation, "utf8"), "parent-identity");
    assert.equal(Object.hasOwn(result, "stdout"), false);
    assert.ok(result.stderr.includes("stderr-ok"));
  });
});
