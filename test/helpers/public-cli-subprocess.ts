import { dirname } from "node:path";

import { isolatedTestProcessEnv } from "./test-process-fixtures.ts";
import {
  runTestSubprocess,
  type TestSubprocessResult,
} from "./test-subprocess.ts";

export type PublicCliSubprocessResult = TestSubprocessResult;

/** Shared graceful lifecycle for installed public-CLI subprocess tests. */
export async function runPublicCliSubprocess(
  bin: string,
  args: readonly string[],
  options: {
    home: string;
    agentDir: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
): Promise<PublicCliSubprocessResult> {
  const mergedEnv = isolatedTestProcessEnv({
    env: { ...process.env, ...options.env },
    home: options.home,
    agentDir: options.agentDir,
  });
  return runTestSubprocess(bin, args, {
    cwd: options.cwd ?? options.home,
    env: {
      ...mergedEnv,
      PATH: `${dirname(bin)}:${mergedEnv.PATH ?? ""}`,
    },
    timeoutMs: options.timeoutMs ?? 45_000,
    owner: "runPublicCliSubprocess",
  });
}
