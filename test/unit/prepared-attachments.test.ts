import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { withPreparedAttachments } from "../../src/public-cli/invocation.ts";

async function cleanupFailureCase(primary?: Error): Promise<unknown> {
  const root = await mkdtemp(join(tmpdir(), "ak-role-cleanup-contract-"));
  const source = join(root, "attachment.txt");
  await writeFile(source, "frozen bytes");
  let stagingDirectory: string | undefined;
  try {
    return await withPreparedAttachments([source], async ([prepared]) => {
      stagingDirectory = dirname(prepared!.snapshotPath);
      await chmod(stagingDirectory, 0o000);
      if (primary !== undefined) throw primary;
      return undefined;
    });
  } catch (error) {
    return error;
  } finally {
    if (stagingDirectory !== undefined) {
      await chmod(stagingDirectory, 0o700);
      await rm(stagingDirectory, { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  }
}

test("prepared attachment cleanup propagates alone and preserves both failure causes", async () => {
  const cleanupOnly = await cleanupFailureCase();
  assert(cleanupOnly instanceof Error);
  assert.equal((cleanupOnly as NodeJS.ErrnoException).code, "EACCES");

  const primary = new Error("lookup failed");
  const combined = await cleanupFailureCase(primary);
  assert(combined instanceof AggregateError);
  assert.equal(combined.cause, primary);
  assert.equal(combined.errors[0], primary);
  assert.notEqual(combined.errors[1], primary);
  assert.equal((combined.errors[1] as NodeJS.ErrnoException).code, "EACCES");
});
