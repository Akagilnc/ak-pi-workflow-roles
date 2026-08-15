/**
 * #357 T2 — engine-generic detour executor predicates and spawn seam.
 * Zero per-engine branches; zero CLI material-prose pins.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AK_ROLE_ENGINE_ENV,
  ENGINE_DETOUR_EMPTY_STDOUT_DIAGNOSTIC,
  ENGINE_DETOUR_TOOL_NAME,
  engineDetourFailureDiagnostic,
  engineNameFromEnv,
  isEngineDetourFailure,
  runEngineDetourOnce,
} from "../../src/engine-detour.ts";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ak-engine-detour-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, body, "utf8");
  await chmod(path, 0o755);
}

test("ENGINE_DETOUR_TOOL_NAME is stable package identity", () => {
  assert.equal(ENGINE_DETOUR_TOOL_NAME, "ak_engine_detour");
});

test("isEngineDetourFailure: nonzero or trim-empty stdout", () => {
  assert.equal(isEngineDetourFailure({ code: 0, stdout: "ok\n" }), false);
  assert.equal(isEngineDetourFailure({ code: 1, stdout: "ok\n" }), true);
  assert.equal(isEngineDetourFailure({ code: 0, stdout: "" }), true);
  assert.equal(isEngineDetourFailure({ code: 0, stdout: "   \n\t  " }), true);
  assert.equal(isEngineDetourFailure({ code: 2, stdout: "" }), true);
});

test("engineDetourFailureDiagnostic prefers stderr 原样; empty fallbacks", () => {
  assert.equal(
    engineDetourFailureDiagnostic({
      stderr: "engine-marker-stderr\n",
      code: 1,
      stdout: "",
    }),
    "engine-marker-stderr\n",
  );
  assert.equal(
    engineDetourFailureDiagnostic({
      stderr: "",
      code: 0,
      stdout: "  \n",
    }),
    ENGINE_DETOUR_EMPTY_STDOUT_DIAGNOSTIC,
  );
  assert.equal(
    engineDetourFailureDiagnostic({
      stderr: "",
      code: 7,
      stdout: "partial",
    }),
    "engine detour exited with code 7",
  );
});

test("engineNameFromEnv reads presence/name signal only", () => {
  assert.equal(engineNameFromEnv({}), undefined);
  assert.equal(engineNameFromEnv({ [AK_ROLE_ENGINE_ENV]: "" }), undefined);
  assert.equal(engineNameFromEnv({ [AK_ROLE_ENGINE_ENV]: "   " }), undefined);
  assert.equal(engineNameFromEnv({ [AK_ROLE_ENGINE_ENV]: "kimi" }), "kimi");
  assert.equal(engineNameFromEnv({ [AK_ROLE_ENGINE_ENV]: "  kimi  " }), "kimi");
});

test("runEngineDetourOnce success returns stdout via PATH executable", async () => {
  await withTempDir(async (dir) => {
    const bin = join(dir, "bin");
    await mkdir(bin, { recursive: true });
    const canned = '{"judgeStatus":"converged"}\n';
    await writeExecutable(
      join(bin, "fake-engine"),
      `#!/bin/sh\nprintf '%s' '${canned}'\n`,
    );
    const result = await runEngineDetourOnce({
      argv: ["fake-engine"],
      cwd: dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, canned);
    assert.equal(isEngineDetourFailure(result), false);
  });
});

test("runEngineDetourOnce nonzero exit captures stderr", async () => {
  await withTempDir(async (dir) => {
    const bin = join(dir, "bin");
    await mkdir(bin, { recursive: true });
    await writeExecutable(
      join(bin, "fake-engine"),
      "#!/bin/sh\nprintf 'boom-stderr-marker' >&2\nexit 3\n",
    );
    const result = await runEngineDetourOnce({
      argv: ["fake-engine"],
      cwd: dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    assert.equal(result.code, 3);
    assert.equal(result.stderr, "boom-stderr-marker");
    assert.equal(isEngineDetourFailure(result), true);
    assert.equal(
      engineDetourFailureDiagnostic(result),
      "boom-stderr-marker",
    );
  });
});

test("runEngineDetourOnce whitespace-only stdout is failure", async () => {
  await withTempDir(async (dir) => {
    const bin = join(dir, "bin");
    await mkdir(bin, { recursive: true });
    await writeExecutable(
      join(bin, "fake-engine"),
      "#!/bin/sh\nprintf '  \\n\\t  '\nexit 0\n",
    );
    const result = await runEngineDetourOnce({
      argv: ["fake-engine"],
      cwd: dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    assert.equal(result.code, 0);
    assert.equal(isEngineDetourFailure(result), true);
    assert.equal(
      engineDetourFailureDiagnostic(result),
      ENGINE_DETOUR_EMPTY_STDOUT_DIAGNOSTIC,
    );
  });
});

test("runEngineDetourOnce rejects empty argv", async () => {
  await assert.rejects(
    () => runEngineDetourOnce({ argv: [], cwd: process.cwd() }),
    /non-empty/,
  );
});
