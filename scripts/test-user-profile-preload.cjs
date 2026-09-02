/**
 * #604 test-process user-profile seam.
 *
 * Production packageMachineHome() reads os.userInfo().homedir and ignores $HOME.
 * Cold-bin tests must never write the operator's real machine home; they point a
 * temporary user profile at the hermetic home via AK_TEST_USER_PROFILE_HOME and
 * load this preload with NODE_OPTIONS=--require (test process layer only —
 * not a production hook).
 *
 * Modes (env, exclusive):
 * - AK_TEST_USER_PROFILE_HOME=<path> — redirect userInfo().homedir to that path.
 * - AK_TEST_USER_PROFILE_MODE=unavailable — userInfo throws ERR_SYSTEM_ERROR
 *   (arbitrary-UID / no-passwd regression).
 *
 * Before patching redirect mode, preserve the real passwd home in
 * AK_TEST_REAL_MACHINE_HOME so test-agent-dir-guard can still refuse writes to
 * the operator's ~/.pi/agent (that guard must not follow the temporary profile).
 *
 * Must stay CommonJS: --require runs before ESM named imports bind node:os, so
 * patching the CJS exports object rewrites userInfo for both CJS and ESM.
 */
"use strict";

const os = require("node:os");

if (process.env.AK_TEST_USER_PROFILE_MODE === "unavailable") {
  Object.defineProperty(os, "userInfo", {
    configurable: true,
    writable: true,
    value() {
      const err = new Error("user info unavailable");
      err.code = "ERR_SYSTEM_ERROR";
      throw err;
    },
  });
} else {
  const fakeHome = process.env.AK_TEST_USER_PROFILE_HOME;
  if (typeof fakeHome === "string" && fakeHome.length > 0) {
    if (
      typeof process.env.AK_TEST_REAL_MACHINE_HOME !== "string" ||
      process.env.AK_TEST_REAL_MACHINE_HOME.length === 0
    ) {
      process.env.AK_TEST_REAL_MACHINE_HOME = os.userInfo().homedir;
    }
    const original = os.userInfo;
    Object.defineProperty(os, "userInfo", {
      configurable: true,
      writable: true,
      value(options) {
        const info = original.call(os, options);
        return Object.assign({}, info, { homedir: fakeHome });
      },
    });
  }
}
