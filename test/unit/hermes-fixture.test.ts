/**
 * Shared PATH hermes/gh fixture — fail-loud config/input paths only.
 * Process-level: spawn the installed executable; assert exit + stderr.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  installGhFixture,
  installHermesFixture,
} from "../helpers/hermes-fixture.ts";

async function runExe(
  exe: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(exe, [...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.setEncoding("utf8").on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function withBin<T>(run: (binDir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ak-hermes-fixture-"));
  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true });
  try {
    return await run(binDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("hermes fixture: staged query-file missing → non-zero + stderr", async () => {
  await withBin(async (binDir) => {
    await installHermesFixture(binDir);
    const missing = join(binDir, "no-such-staged.json");
    const result = await runExe(join(binDir, "hermes"), [
      "chat",
      "--query-file",
      missing,
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /staged query-file missing/);
  });
});

test("hermes fixture: staged query-file bad JSON → non-zero + stderr", async () => {
  await withBin(async (binDir) => {
    await installHermesFixture(binDir);
    const staged = join(binDir, "bad.json");
    await writeFile(staged, "{not-json", "utf8");
    const result = await runExe(join(binDir, "hermes"), [
      "chat",
      "--query-file",
      staged,
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /staged query-file is not JSON/);
  });
});

test("hermes fixture: configured control file missing → non-zero + stderr", async () => {
  await withBin(async (binDir) => {
    const control = join(binDir, "missing-control.json");
    await installHermesFixture(binDir, { controlFile: control });
    const result = await runExe(join(binDir, "hermes"), ["chat"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /control file missing or unreadable/);
  });
});

test("hermes fixture: configured control file bad JSON → non-zero + stderr", async () => {
  await withBin(async (binDir) => {
    const control = join(binDir, "bad-control.json");
    await writeFile(control, "not-json", "utf8");
    await installHermesFixture(binDir, { controlFile: control });
    const result = await runExe(join(binDir, "hermes"), ["chat"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /control file is not JSON/);
  });
});

test("gh fixture: configured control file missing → non-zero + stderr (same loader)", async () => {
  await withBin(async (binDir) => {
    const control = join(binDir, "missing-gh-control.json");
    await installGhFixture(binDir, { controlFile: control });
    const result = await runExe(join(binDir, "gh"), [
      "api",
      "--include",
      "repos/o/r/issues/1",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /control file missing or unreadable/);
  });
});

test("hermes fixture: happy resolver default still exits 0 with true-unbound", async () => {
  await withBin(async (binDir) => {
    await installHermesFixture(binDir);
    const result = await runExe(join(binDir, "hermes"), ["chat"]);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), { assertion: "true-unbound" });
  });
});
