/**
 * Small seam: package home topology ignores process.env.HOME (#604).
 * Pure path/default resolution only — CLI write-surface lives in integration.
 */
import assert from "node:assert/strict";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  ActivationLedgerError,
  homeFromRunDirectory,
  packageMachineHome,
  resolveActivationLedgerHome,
  resolveActivationLedgerHomeForPath,
  tryHomeFromAkRolesPath,
} from "../../src/activation-ledger-topology.ts";

const REAL_PASSWD_HOME = resolve(userInfo().homedir);

test("packageMachineHome resolves passwd/user-profile homedir, never process.env.HOME", () => {
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = "/tmp/ak-fake-home-must-not-win";
    assert.equal(packageMachineHome(), REAL_PASSWD_HOME);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("resolveActivationLedgerHome default uses packageMachineHome, ignoring process.env.HOME", () => {
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = "/tmp/ak-fake-home-must-not-win";
    assert.equal(resolveActivationLedgerHome(), resolve(REAL_PASSWD_HOME, ".ak-roles"));
    const customHome = "/custom/injected/home";
    assert.equal(resolveActivationLedgerHome(customHome), resolve(customHome, ".ak-roles"));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("tryHomeFromAkRolesPath / homeFromRunDirectory: derive or typed fail, no HOME fallback", () => {
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = "/tmp/ak-fake-home-must-not-win";

    const normalRunDir = "/custom/home/path/.ak-roles/books/my-repo/runs/0123@coder";
    assert.equal(tryHomeFromAkRolesPath(normalRunDir), "/custom/home/path");
    assert.equal(homeFromRunDirectory(normalRunDir), "/custom/home/path");
    assert.equal(
      resolveActivationLedgerHomeForPath(normalRunDir),
      resolve("/custom/home/path", ".ak-roles"),
    );

    const nonAkRolesDir = "/some/random/dir/not/in/ledger";
    assert.equal(tryHomeFromAkRolesPath(nonAkRolesDir), undefined);
    assert.equal(
      resolveActivationLedgerHomeForPath(nonAkRolesDir),
      resolve(REAL_PASSWD_HOME, ".ak-roles"),
    );
    assert.throws(
      () => homeFromRunDirectory(nonAkRolesDir),
      (error: unknown) =>
        error instanceof ActivationLedgerError && error.code === "AK_ACTIVATION_LEDGER",
    );

    // F5 regression: path containing .ak-roles as substring of directory name must NOT derive
    assert.equal(tryHomeFromAkRolesPath("/home/x.ak-roles-backup/foo"), undefined);
    assert.equal(tryHomeFromAkRolesPath("/home/.ak-roles-backup/foo"), undefined);
    assert.equal(tryHomeFromAkRolesPath("/home/backup.ak-roles/foo"), undefined);
    assert.equal(tryHomeFromAkRolesPath("/home/ak-roles/foo"), undefined);
    assert.throws(
      () => homeFromRunDirectory("/home/x.ak-roles-backup/foo"),
      ActivationLedgerError,
    );

    // True .ak-roles segment at end or middle
    assert.equal(tryHomeFromAkRolesPath("/custom/home/.ak-roles"), "/custom/home");
    assert.equal(tryHomeFromAkRolesPath("/custom/home/.ak-roles/"), "/custom/home");
    assert.equal(tryHomeFromAkRolesPath("/custom/home/.ak-roles/books"), "/custom/home");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
