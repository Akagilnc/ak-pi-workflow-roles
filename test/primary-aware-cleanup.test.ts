import assert from "node:assert/strict";
import test from "node:test";

import { withPrimaryAwareCleanup } from "./helpers/primary-aware-cleanup.ts";

test("cleanup failure alone fails the test", async () => {
  const cleanup = new Error("cleanup-only");
  await assert.rejects(
    () =>
      withPrimaryAwareCleanup(
        async () => "ok",
        async () => {
          throw cleanup;
        },
      ),
    (error: unknown) => error === cleanup,
  );
});

test("primary failure wins while cleanup failure remains aggregated", async () => {
  const primary = new Error("primary");
  const cleanup = new Error("cleanup");
  await assert.rejects(
    () =>
      withPrimaryAwareCleanup(
        async () => {
          throw primary;
        },
        async () => {
          throw cleanup;
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], primary);
      assert.equal(error.errors[1], cleanup);
      assert.equal(error.cause, primary);
      return true;
    },
  );
});

test("successful body returns value when cleanup succeeds", async () => {
  const steps: string[] = [];
  const value = await withPrimaryAwareCleanup(
    async () => {
      steps.push("body");
      return 42;
    },
    async () => {
      steps.push("cleanup");
    },
  );
  assert.equal(value, 42);
  assert.deepEqual(steps, ["body", "cleanup"]);
});

test("primary failure propagates when cleanup succeeds", async () => {
  const primary = new Error("primary-only");
  await assert.rejects(
    () =>
      withPrimaryAwareCleanup(
        async () => {
          throw primary;
        },
        async () => {},
      ),
    (error: unknown) => error === primary,
  );
});

test("multiple cleanup failures aggregate when body succeeds", async () => {
  const first = new Error("first-cleanup");
  const second = new Error("second-cleanup");
  await assert.rejects(
    () =>
      withPrimaryAwareCleanup(
        async () => "ok",
        async () => {
          throw first;
        },
        async () => {
          throw second;
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [first, second]);
      return true;
    },
  );
});
