/**
 * #604 acceptance: production CLI home does not follow process.env.HOME.
 * Real entry (runAkRole) + disk observation — mid-size integration seam.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runAkRole } from "../../src/public-cli/cli.ts";
import { withTestUserProfileEnv } from "../helpers/public-cli-subprocess.ts";
import { runTestSubprocess } from "../helpers/test-subprocess.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI_MODULE = new URL("../../src/public-cli/cli.ts", import.meta.url).href;

test("HOME=<tmpdir> ak-role does not create .ak-roles under that tmpdir", async () => {
  const fakeTmpHome = mkdtempSync(join(tmpdir(), "ak-fake-cli-home-"));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = fakeTmpHome;
    const result = await runAkRole(["roles"], {
      packageRoot: PACKAGE_ROOT,
      io: {
        stdout: () => {},
        stderr: () => {},
      },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(existsSync(join(fakeTmpHome, ".ak-roles")), false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

/**
 * F2: unavailable user profile via sole test-user-profile preload mode.
 * One child at real runAkRole: home-free help succeeds; home-needing roles
 * settles non-zero; neither throws. Structured results only — no free-text lock.
 * Deadline matches sibling preload unit child (15s), not a one-off 20s.
 */
test("unavailable user profile: help succeeds; home-needing command settles non-zero", async () => {
  const env = withTestUserProfileEnv({ ...process.env }, { mode: "unavailable" });
  const result = await runTestSubprocess(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      [
        `import { runAkRole } from ${JSON.stringify(CLI_MODULE)};`,
        "const io = { stdout() {}, stderr() {} };",
        `const runEnv = { packageRoot: ${JSON.stringify(PACKAGE_ROOT)}, io };`,
        "async function once(argv) {",
        "  try {",
        "    const r = await runAkRole(argv, runEnv);",
        "    return { exitCode: r.exitCode, threw: false };",
        "  } catch {",
        "    return { exitCode: null, threw: true };",
        "  }",
        "}",
        'const help = await once(["help"]);',
        'const roles = await once(["roles"]);',
        "console.log(JSON.stringify({ help, roles }));",
      ].join("\n"),
    ],
    {
      cwd: process.cwd(),
      env,
      timeoutMs: 15_000,
      owner: "package-home-cli-no-passwd",
    },
  );
  assert.equal(result.code, 0, result.stderr);
  const body = JSON.parse(result.stdout.trim()) as {
    help: { exitCode: number | null; threw: boolean };
    roles: { exitCode: number | null; threw: boolean };
  };
  assert.equal(body.help.threw, false);
  assert.equal(body.help.exitCode, 0);
  assert.equal(body.roles.threw, false);
  assert.notEqual(body.roles.exitCode, 0);
});
