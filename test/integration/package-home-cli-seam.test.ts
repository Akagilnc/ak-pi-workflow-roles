/**
 * #604 acceptance: production CLI home does not follow process.env.HOME.
 * Real entry (runAkRole) + disk observation — mid-size integration seam.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runAkRole } from "../../src/public-cli/cli.ts";
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
    rmSync(fakeTmpHome, { recursive: true, force: true });
  }
});

/**
 * F1/F2: arbitrary-UID / no-passwd profile must not break home-free help, and a
 * home-needing command must settle non-zero through the public entry (not throw).
 * Reuses child + CJS --require trunk; no parallel helper; no free-text lock.
 */
test("unavailable user profile: help succeeds; home-needing command settles non-zero", async () => {
  const root = mkdtempSync(join(tmpdir(), "ak-no-passwd-cli-"));
  const preloadPath = join(root, "no-passwd.cjs");
  writeFileSync(
    preloadPath,
    [
      '"use strict";',
      'const os = require("node:os");',
      "Object.defineProperty(os, \"userInfo\", {",
      "  configurable: true,",
      "  writable: true,",
      "  value() {",
      "    const err = new Error(\"no passwd entry\");",
      "    err.code = \"ERR_SYSTEM_ERROR\";",
      "    throw err;",
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  const requireFlag = `--require=${JSON.stringify(preloadPath)}`;
  const priorNodeOptions = process.env.NODE_OPTIONS ?? "";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS:
      priorNodeOptions.length > 0 ? `${requireFlag} ${priorNodeOptions}` : requireFlag,
  };

  async function publicEntry(
    argvJson: string,
  ): Promise<{ exitCode: number; threw: boolean }> {
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
          `const env = { packageRoot: ${JSON.stringify(PACKAGE_ROOT)}, io };`,
          "let threw = false;",
          "let exitCode = null;",
          "try {",
          `  const r = await runAkRole(${argvJson}, env);`,
          "  exitCode = r.exitCode;",
          "} catch {",
          "  threw = true;",
          "}",
          "console.log(JSON.stringify({ exitCode, threw }));",
        ].join("\n"),
      ],
      {
        cwd: process.cwd(),
        env,
        timeoutMs: 20_000,
        owner: "package-home-cli-no-passwd",
      },
    );
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout.trim()) as {
      exitCode: number;
      threw: boolean;
    };
  }

  try {
    const help = await publicEntry(JSON.stringify(["help"]));
    assert.equal(help.threw, false);
    assert.equal(help.exitCode, 0);

    const roles = await publicEntry(JSON.stringify(["roles"]));
    assert.equal(roles.threw, false);
    assert.notEqual(roles.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
