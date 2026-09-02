import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  homeFromRunDirectory,
  packageMachineHome,
  resolveActivationLedgerHome,
} from "../../src/activation-ledger-topology.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";

const REAL_PASSWD_HOME = resolve(userInfo().homedir);
const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

test("packageMachineHome resolves passwd/user-profile homedir, never process.env.HOME", () => {
  const fakeTmpHome = mkdtempSync(join(tmpdir(), "ak-fake-home-"));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = fakeTmpHome;
    assert.equal(packageMachineHome(), REAL_PASSWD_HOME);
    assert.notEqual(packageMachineHome(), fakeTmpHome);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(fakeTmpHome, { recursive: true, force: true });
  }
});

test("resolveActivationLedgerHome default uses packageMachineHome, ignoring process.env.HOME", () => {
  const fakeTmpHome = mkdtempSync(join(tmpdir(), "ak-fake-home-"));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = fakeTmpHome;
    const defaultLedgerHome = resolveActivationLedgerHome();
    assert.equal(defaultLedgerHome, resolve(REAL_PASSWD_HOME, ".ak-roles"));
    assert.notEqual(defaultLedgerHome, resolve(fakeTmpHome, ".ak-roles"));

    // Explicit injection still works
    const customHome = resolve(fakeTmpHome, "injected");
    assert.equal(
      resolveActivationLedgerHome(() => customHome),
      resolve(customHome, ".ak-roles"),
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(fakeTmpHome, { recursive: true, force: true });
  }
});

test("homeFromRunDirectory extracts home from .ak-roles path and throws otherwise (no HOME fallback)", () => {
  const fakeTmpHome = mkdtempSync(join(tmpdir(), "ak-fake-home-"));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = fakeTmpHome;

    const normalRunDir = "/custom/home/path/.ak-roles/books/my-repo/runs/0123@coder";
    assert.equal(homeFromRunDirectory(normalRunDir), "/custom/home/path");

    const nonAkRolesDir = "/some/random/dir/not/in/ledger";
    assert.throws(
      () => homeFromRunDirectory(nonAkRolesDir),
      /cannot resolve home from runDirectory/,
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(fakeTmpHome, { recursive: true, force: true });
  }
});

test("acceptance: HOME=<tmpdir> ak-role operations do not create .ak-roles in tmpdir", async () => {
  const fakeTmpHome = mkdtempSync(join(tmpdir(), "ak-fake-cli-home-"));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = fakeTmpHome;

    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await runAkRole(["roles"], {
      packageRoot: PACKAGE_ROOT,
      io: {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      },
    });

    assert.equal(result.exitCode, 0);
    // fakeTmpHome must NOT have .ak-roles created in it
    assert.equal(existsSync(join(fakeTmpHome, ".ak-roles")), false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(fakeTmpHome, { recursive: true, force: true });
  }
});
