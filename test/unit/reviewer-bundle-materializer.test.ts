import assert from "node:assert/strict";
import test from "node:test";
import { materializeMechanicalBundle } from "../../src/reviewer-bundle-materializer.ts";

test("mechanical bundle materialization is removed", async () => {
  await assert.rejects(
    () => materializeMechanicalBundle(),
    /Mechanical bundle materialization was removed/,
  );
});
