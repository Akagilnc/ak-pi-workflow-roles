import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) {
    const cleanupFailure =
      failures.length === 1 ? failures[0]
      : new AggregateError(failures, "Test cleanup failed", { cause: failures[0] });
    if (primaryFailure !== undefined) {
      throw new AggregateError([primaryFailure, cleanupFailure], "Test failed and cleanup failed", { cause: primaryFailure });
    }
    throw cleanupFailure;
  }
  if (!succeeded) throw primaryFailure;
  return value;
}

/** #685: temp under system tmpdir; leave residue. */
export async function withTempRoot<T>(prefix: string, body: (root: string) => Promise<T>): Promise<T> {
  return body(await mkdtemp(join(tmpdir(), prefix)));
}
