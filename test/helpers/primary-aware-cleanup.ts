import { mkdtemp, rm } from "node:fs/promises";
import { testTmpdir } from "./worktree-temp.ts";
import { join } from "node:path";

/**
 * Run a test body, then cleanups, without letting teardown erase the primary failure.
 *
 * Adjudicated cleanup-race rule:
 * - cleanup failure alone fails the test
 * - primary failure wins as AggregateError.cause / errors[0]; cleanup is still reported
 */
export async function withPrimaryAwareCleanup<T>(
  body: () => Promise<T>,
  ...cleanups: Array<() => Promise<void>>
): Promise<T> {
  let primaryFailure: unknown;
  let value!: T;
  let succeeded = false;
  try {
    value = await body();
    succeeded = true;
  } catch (error) {
    primaryFailure = error;
  }

  const failures: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    const cleanupFailure =
      failures.length === 1
        ? failures[0]
        : new AggregateError(failures, "Test cleanup failed", { cause: failures[0] });
    if (primaryFailure !== undefined) {
      throw new AggregateError(
        [primaryFailure, cleanupFailure],
        "Test failed and cleanup failed",
        { cause: primaryFailure },
      );
    }
    throw cleanupFailure;
  }

  if (!succeeded) throw primaryFailure;
  return value;
}

/**
 * Create a temp root, run body, delete the root. Cleanup failure does not
 * erase a primary body failure (via withPrimaryAwareCleanup).
 */
export async function withTempRoot<T>(
  prefix: string,
  body: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(testTmpdir(), prefix));
  return withPrimaryAwareCleanup(
    () => body(root),
    async () => {
      await rm(root, { recursive: true, force: true });
    },
  );
}
