/**
 * #604: test-process user-profile preload redirects os.userInfo().homedir
 * so cold bins never write the operator's real machine home. Production code
 * unchanged — preload is NODE_OPTIONS --require only.
 */
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { packageMachineHome } from "../../src/activation-ledger-topology.ts";
import { withTestUserProfileEnv } from "../helpers/public-cli-subprocess.ts";
import { runTestSubprocess } from "../helpers/test-subprocess.ts";

const REAL_PASSWD_HOME = userInfo().homedir;
const PRELOAD = fileURLToPath(
  new URL("../../scripts/test-user-profile-preload.cjs", import.meta.url),
);

test("parent process packageMachineHome still follows real user profile", () => {
  assert.equal(packageMachineHome(), REAL_PASSWD_HOME);
});

test("withTestUserProfileEnv child: package home = temp; realMachineHome stays operator", async () => {
  // Spaced temp preload path: bare `--require $path` truncates; encoding must keep it one token.
  const spacedRoot = mkdtempSync(join(tmpdir(), "ak test user profile "));
  const preloadPath = join(spacedRoot, "pre load.cjs");
  const profileHome = mkdtempSync(join(spacedRoot, "profile "));
  const callerNodeOptions = "--unhandled-rejections=strict";
  try {
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
  } finally {
    rmSync(spacedRoot, { recursive: true, force: true });
  }
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
