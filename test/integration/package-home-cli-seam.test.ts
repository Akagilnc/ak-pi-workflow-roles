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

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

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
