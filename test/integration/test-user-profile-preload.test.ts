import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
/**
 * #604: test-process user-profile preload redirects os.userInfo().homedir
 * so cold bins never write the operator's real machine home. Production code
 * unchanged — preload is NODE_OPTIONS --require only.
 */
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  packageMachineHome,
  resolveActivationLedgerHome,
  resolveActivationLedgerHomeForPath,
} from "../../src/activation-ledger-topology.ts";
import { withTestUserProfileEnv } from "../helpers/public-cli-subprocess.ts";
import { runTestSubprocess } from "../helpers/test-subprocess.ts";

const REAL_PASSWD_HOME = resolve(userInfo().homedir);
const PRELOAD = fileURLToPath(
  new URL("../../scripts/test-user-profile-preload.cjs", import.meta.url),
);

/**
 * #604 / #631 host-profile class: real passwd/user-profile queries (not unit).
 * Absorbs former unit package-home-seam cases that called packageMachineHome()
 * or default ledger home — same external behavior, one medium seam.
 */
test("packageMachineHome and default ledger home follow real profile, ignore process.env.HOME", () => {
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = "/tmp/ak-fake-home-must-not-win";
    assert.equal(packageMachineHome(), REAL_PASSWD_HOME);
    assert.equal(resolveActivationLedgerHome(), resolve(REAL_PASSWD_HOME, ".ak-roles"));
    assert.equal(
      resolveActivationLedgerHomeForPath("/some/random/dir/not/in/ledger"),
      resolve(REAL_PASSWD_HOME, ".ak-roles"),
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("withTestUserProfileEnv child: package home = temp; realMachineHome stays operator", async () => {
  // Spaced temp preload path: bare `--require $path` truncates; encoding must keep it one token.
  await withTempRoot("ak test user profile ", async (spacedRoot) => {
  const preloadPath = join(spacedRoot, "pre load.cjs");
  const profileHome = mkdtempSync(join(spacedRoot, "profile "));
  const callerNodeOptions = "--unhandled-rejections=strict";

    copyFileSync(PRELOAD, preloadPath);
    const env = withTestUserProfileEnv(
      { ...process.env, NODE_OPTIONS: callerNodeOptions },
      profileHome,
      preloadPath,
    );
    assert.equal(env.AK_TEST_USER_PROFILE_HOME, profileHome);
    assert.ok(
      (env.NODE_OPTIONS ?? "").includes(preloadPath),
      `NODE_OPTIONS must require spaced preload, got ${env.NODE_OPTIONS}`,
    );
    assert.ok(
      (env.NODE_OPTIONS ?? "").includes(callerNodeOptions),
      `caller NODE_OPTIONS must be preserved, got ${env.NODE_OPTIONS}`,
    );

    const result = await runTestSubprocess(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        [
          `import { packageMachineHome } from ${JSON.stringify(
            new URL("../../src/activation-ledger-topology.ts", import.meta.url).href,
          )};`,
          `import { realMachineHome } from ${JSON.stringify(
            new URL("../helpers/test-agent-dir-guard.ts", import.meta.url).href,
          )};`,
          `console.log(JSON.stringify({
            packageHome: packageMachineHome(),
            realHome: realMachineHome(),
            preserved: process.env.AK_TEST_REAL_MACHINE_HOME,
          }));`,
        ].join(""),
      ],
      {
        cwd: process.cwd(),
        env,
        timeoutMs: 15_000,
        owner: "test-user-profile-preload",
      },
    );
    assert.equal(result.code, 0, result.stderr);
    const body = JSON.parse(result.stdout.trim()) as {
      packageHome: string;
      realHome: string;
      preserved: string;
    };
    assert.equal(body.packageHome, profileHome);
    assert.equal(body.realHome, REAL_PASSWD_HOME);
    assert.equal(body.preserved, REAL_PASSWD_HOME);
    });
});

test("unavailable mode: userInfo / packageMachineHome throw ERR_SYSTEM_ERROR", async () => {
  const env = withTestUserProfileEnv({ ...process.env }, { mode: "unavailable" });
  assert.equal(env.AK_TEST_USER_PROFILE_MODE, "unavailable");
  assert.ok(
    (env.NODE_OPTIONS ?? "").includes("test-user-profile-preload.cjs"),
    `NODE_OPTIONS must require shared preload, got ${env.NODE_OPTIONS}`,
  );

  const result = await runTestSubprocess(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      [
        "import { userInfo } from \"node:os\";",
        `import { packageMachineHome } from ${JSON.stringify(
          new URL("../../src/activation-ledger-topology.ts", import.meta.url).href,
        )};`,
        "function codeOf(fn) {",
        "  try { fn(); return null; }",
        "  catch (e) { return e && typeof e === \"object\" && \"code\" in e ? e.code : null; }",
        "}",
        "console.log(JSON.stringify({",
        "  userInfoCode: codeOf(() => userInfo()),",
        "  packageHomeCode: codeOf(() => packageMachineHome()),",
        "}));",
      ].join("\n"),
    ],
    {
      cwd: process.cwd(),
      env,
      timeoutMs: 15_000,
      owner: "test-user-profile-preload-unavailable",
    },
  );
  assert.equal(result.code, 0, result.stderr);
  const body = JSON.parse(result.stdout.trim()) as {
    userInfoCode: string | null;
    packageHomeCode: string | null;
  };
  assert.equal(body.userInfoCode, "ERR_SYSTEM_ERROR");
  assert.equal(body.packageHomeCode, "ERR_SYSTEM_ERROR");
});
