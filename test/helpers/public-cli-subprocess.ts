import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { isolatedTestProcessEnv } from "./test-process-fixtures.ts";
import {
  runTestSubprocess,
  type TestSubprocessResult,
} from "./test-subprocess.ts";

export type PublicCliSubprocessResult = TestSubprocessResult;

const USER_PROFILE_PRELOAD = fileURLToPath(
  new URL("../../scripts/test-user-profile-preload.cjs", import.meta.url),
);

/** Unavailable userInfo mode for the shared test-user-profile preload. */
export type UnavailableTestUserProfile = {
  mode: "unavailable";
  /** Test-only override so spaced preload paths exercise NODE_OPTIONS encoding. */
  preloadPath?: string;
};

/**
 * #604: assemble NODE_OPTIONS --require for the sole test-user-profile preload.
 * - string packageHome → redirect os.userInfo().homedir (cold-bin hermetic home).
 * - { mode: "unavailable" } → userInfo throws ERR_SYSTEM_ERROR.
 * Test-layer only; not a production env hook.
 */
export function withTestUserProfileEnv(
  env: NodeJS.ProcessEnv,
  packageHomeOrOptions: string | UnavailableTestUserProfile,
  /** Test-only override so spaced preload paths exercise NODE_OPTIONS encoding. */
  preloadPath: string = USER_PROFILE_PRELOAD,
): NodeJS.ProcessEnv {
  const resolvedPreload =
    typeof packageHomeOrOptions === "object"
      ? (packageHomeOrOptions.preloadPath ?? USER_PROFILE_PRELOAD)
      : preloadPath;
  // Single NODE_OPTIONS argv token: bare `--require $path` splits on spaces.
  const requireFlag = `--require=${JSON.stringify(resolvedPreload)}`;
  const nodeOptions = env.NODE_OPTIONS ?? "";
  const withRequire: NodeJS.ProcessEnv = {
    ...env,
    NODE_OPTIONS: nodeOptions.includes(resolvedPreload)
      ? nodeOptions
      : nodeOptions.length > 0
        ? `${requireFlag} ${nodeOptions}`
        : requireFlag,
  };
  if (typeof packageHomeOrOptions !== "string") {
    return {
      ...withRequire,
      AK_TEST_USER_PROFILE_MODE: "unavailable",
    };
  }
  return {
    ...withRequire,
    AK_TEST_USER_PROFILE_HOME: packageHomeOrOptions,
  };
}

/** Shared graceful lifecycle for installed public-CLI subprocess tests. */
export async function runPublicCliSubprocess(
  bin: string,
  args: readonly string[],
  options: {
    home: string;
    agentDir: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /**
     * Harness deadline. `null` = no deadline (delegate without timeoutMs).
     * Omit / undefined keeps the historical 45s default.
     */
    timeoutMs?: number | null;
  },
): Promise<PublicCliSubprocessResult> {
  const mergedEnv = withTestUserProfileEnv(
    isolatedTestProcessEnv({
      env: { ...process.env, ...options.env },
      home: options.home,
      agentDir: options.agentDir,
    }),
    options.home,
  );
  return runTestSubprocess(bin, args, {
    cwd: options.cwd ?? options.home,
    env: {
      ...mergedEnv,
      PATH: `${dirname(bin)}:${mergedEnv.PATH ?? ""}`,
    },
    ...(options.timeoutMs === null
      ? {}
      : { timeoutMs: options.timeoutMs ?? 45_000 }),
    owner: "runPublicCliSubprocess",
  });
}
