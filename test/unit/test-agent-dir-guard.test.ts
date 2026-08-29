import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  assertWritableTestAgentDir,
  realMachineAgentDir,
} from "../helpers/test-agent-dir-guard.ts";

test("models.json fixture requires an explicit agentDir", () => {
  assert.throws(
    () => assertWritableTestAgentDir(undefined),
    /explicitly provided/,
  );
});

test("models.json fixture rejects the machine agentDir tree", () => {
  assert.throws(
    () => assertWritableTestAgentDir(realMachineAgentDir()),
    /machine agentDir/,
  );
  assert.throws(
    () => assertWritableTestAgentDir(join(realMachineAgentDir(), "nested")),
    /machine agentDir/,
  );
});
