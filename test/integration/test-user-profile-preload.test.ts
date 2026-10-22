/** Production profile/ledger entrypoints, with child preloads owned by the fixture module. */
import assert from "node:assert/strict";
import { copyFileSync, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, test as base } from "vitest";
import {
  testExeca as execa,
  environmentFixtures,
  isolatedTestProcessEnv,
  withTestUserProfileEnv,
} from "../helpers/environment-fixtures.ts";
import {
  packageMachineHome,
  resolveActivationLedgerHome,
  resolveActivationLedgerHomeForPath,
} from "../../src/activation-ledger-topology.ts";

const PROFILE_HOME = resolve(userInfo().homedir);
const REAL_MACHINE_HOME = resolve(process.env.AK_TEST_REAL_MACHINE_HOME ?? PROFILE_HOME);
const PRELOAD = fileURLToPath(new URL("../../scripts/test-user-profile-preload.cjs", import.meta.url));

const scenarios = [
  {
    name: "packageMachineHome and default ledger home follow real profile, ignore process.env.HOME",
    async run(home: string) {
      const previousHome = process.env.HOME;
      try {
        process.env.HOME = home;
        assert.equal(packageMachineHome(), PROFILE_HOME);
        assert.equal(resolveActivationLedgerHome(), resolve(PROFILE_HOME, ".ak-roles"));
        assert.equal(
          resolveActivationLedgerHomeForPath("/some/random/dir/not/in/ledger"),
          resolve(PROFILE_HOME, ".ak-roles"),
        );
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
    },
  },
  {
    name: "withTestUserProfileEnv child: package home = temp; realMachineHome stays operator",
    async run(home: string) {
      // A spaced preload path must survive NODE_OPTIONS tokenization.
      const preloadPath = join(home, "pre load.cjs");
      const profileHome = join(home, "profile home");
      await mkdir(profileHome);
      copyFileSync(PRELOAD, preloadPath);
      const env = withTestUserProfileEnv(
        isolatedTestProcessEnv({ env: { ...process.env, NODE_OPTIONS: "--unhandled-rejections=strict" }, home }),
        profileHome,
        preloadPath,
      );
      assert.equal(env.AK_TEST_USER_PROFILE_HOME, profileHome);
      const result = await execa(process.execPath, [
        "--import", "tsx", "--input-type=module", "-e",
        [
          `import { packageMachineHome } from ${JSON.stringify(new URL("../../src/activation-ledger-topology.ts", import.meta.url).href)};`,
          `import { realMachineHome } from ${JSON.stringify(new URL("../helpers/test-agent-dir-guard.ts", import.meta.url).href)};`,
          'import { createRequire } from "node:module";',
          `console.log(JSON.stringify({
            preloadLoaded: Object.hasOwn(createRequire(import.meta.url).cache, ${JSON.stringify(preloadPath)}),
            packageHome: packageMachineHome(),
            realHome: realMachineHome(),
            preserved: process.env.AK_TEST_REAL_MACHINE_HOME,
            strictRejections: process.env.NODE_OPTIONS.includes("--unhandled-rejections=strict"),
          }));`,
        ].join("\n"),
      ], {
        cwd: process.cwd(), env, timeout: 15_000,
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.signal, undefined);
      assert.equal(result.timedOut, false);
      const body = JSON.parse(result.stdout);
      assert.equal(body.preloadLoaded, true);
      assert.equal(body.packageHome, profileHome);
      assert.equal(body.realHome, REAL_MACHINE_HOME);
      assert.equal(body.preserved, REAL_MACHINE_HOME);
      assert.equal(body.strictRejections, true);
    },
  },
  {
    name: "unavailable mode: userInfo / packageMachineHome throw ERR_SYSTEM_ERROR",
    async run(home: string) {
      const env = withTestUserProfileEnv(isolatedTestProcessEnv({ home }), { mode: "unavailable" });
      assert.equal(env.AK_TEST_USER_PROFILE_MODE, "unavailable");
      const result = await execa(process.execPath, [
        "--import", "tsx", "--input-type=module", "-e",
        [
          'import { userInfo } from "node:os";',
          `import { packageMachineHome } from ${JSON.stringify(new URL("../../src/activation-ledger-topology.ts", import.meta.url).href)};`,
          "function codeOf(fn) {",
          "  try { fn(); return null; }",
          '  catch (e) { return e && typeof e === "object" && "code" in e ? e.code : null; }',
          "}",
          "console.log(JSON.stringify({",
          "  userInfoCode: codeOf(() => userInfo()),",
          "  packageHomeCode: codeOf(() => packageMachineHome()),",
          "}));",
        ].join("\n"),
      ], {
        cwd: process.cwd(), env, timeout: 15_000,
      });
      assert.equal(result.exitCode, 0, result.stderr);
      const body = JSON.parse(result.stdout);
      assert.equal(body.userInfoCode, "ERR_SYSTEM_ERROR");
      assert.equal(body.packageHomeCode, "ERR_SYSTEM_ERROR");
    },
  },
];

const homes: string[] = [];
function verifyCleanup() {
  assert.equal(new Set(homes).size, homes.length);
  for (const home of homes) assert.equal(existsSync(home), false);
}

const test = base.extend(environmentFixtures);
for (const scenario of scenarios) {
  test(scenario.name, async ({ home }) => {
    homes.push(home);
    await scenario.run(home);
  });
}
afterAll(verifyCleanup);
