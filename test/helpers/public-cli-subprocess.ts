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

/**
 * #604: point production packageMachineHome (os.userInfo().homedir) at a temp
 * user profile for this child process only. Test-layer NODE_OPTIONS --require;
 * not a production env hook.
 */
export function withTestUserProfileEnv(
  env: NodeJS.ProcessEnv,
  packageHome: string,
  /** Test-only override so spaced preload paths exercise NODE_OPTIONS encoding. */
  preloadPath: string = USER_PROFILE_PRELOAD,
): NodeJS.ProcessEnv {
  // Single NODE_OPTIONS argv token: bare `--require $path` splits on spaces.
  const requireFlag = `--require=${JSON.stringify(preloadPath)}`;
  const nodeOptions = env.NODE_OPTIONS ?? "";
  return {
    ...env,
    AK_TEST_USER_PROFILE_HOME: packageHome,
    NODE_OPTIONS: nodeOptions.includes(preloadPath)
      ? nodeOptions
      : nodeOptions.length > 0
        ? `${requireFlag} ${nodeOptions}`
        : requireFlag,
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
