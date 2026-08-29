import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  assertWritableTestAgentDir,
  realMachineAgentDir,
  TestAgentDirError,
} from "../helpers/test-agent-dir-guard.ts";

function hasCode(code: TestAgentDirError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof TestAgentDirError && error.code === code;
}

test("models.json fixture requires an explicit agentDir", () => {
  assert.throws(
    () => assertWritableTestAgentDir(undefined),
    hasCode("AK_TEST_AGENT_DIR_REQUIRED"),
  );
});

test("models.json fixture rejects the machine agentDir tree", () => {
  assert.throws(
    () => assertWritableTestAgentDir(realMachineAgentDir()),
    hasCode("AK_TEST_AGENT_DIR_MACHINE"),
  );
  assert.throws(
    () => assertWritableTestAgentDir(join(realMachineAgentDir(), "nested")),
    hasCode("AK_TEST_AGENT_DIR_MACHINE"),
  );
});
