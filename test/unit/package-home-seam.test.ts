/**
 * Small seam: package home topology path math (#604 / #631).
 * Explicit-path derivation only — real passwd/user-profile queries live in
 * test/integration/test-user-profile-preload.test.ts (same host-profile class).
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  ActivationLedgerError,
  homeFromRunDirectory,
  resolveActivationLedgerHome,
  resolveActivationLedgerHomeForPath,
  tryHomeFromAkRolesPath,
} from "../../src/activation-ledger-topology.ts";

test("resolveActivationLedgerHome with explicit absolute home ignores process.env.HOME", () => {
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = "/tmp/ak-fake-home-must-not-win";
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
    assert.throws(
      () => homeFromRunDirectory(nonAkRolesDir),
      (error: unknown) =>
        error instanceof ActivationLedgerError && error.code === "AK_ACTIVATION_LEDGER",
    );
    // non-ledger → real profile default is integration (test-user-profile-preload).

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
