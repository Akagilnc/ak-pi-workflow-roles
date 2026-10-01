import assert from "node:assert/strict";
import test from "node:test";

import type { RoleHost } from "../../src/host-contracts.ts";
import { PACKAGED_ROLE_REGISTRY } from "../../src/packaged-role-registry.ts";
import { registerFiledSubmissionTool } from "../../src/filed-submission.ts";
import {
  roleSubmissionDeclaration,
  roleSubmissionRoles,
} from "../../src/role-submission-declarations.ts";

function hostCapturingTools(): { host: RoleHost; tools: Map<string, { execute: Function; parameters: unknown; name: string; description: string }> } {
  const tools = new Map<string, { execute: Function; parameters: unknown; name: string; description: string }>();
  const host = {
    registerTool(tool: { name: string; description: string; parameters: unknown; execute: Function }) {
      tools.set(tool.name, tool);
    },
  } as RoleHost;
  return { host, tools };
}

test("every public role declares its submission tool once", () => {
  assert.deepEqual(
    [...roleSubmissionRoles()].sort(),
    PACKAGED_ROLE_REGISTRY.map((record) => record.role).sort(),
  );
  for (const record of PACKAGED_ROLE_REGISTRY) {
    const declaration = roleSubmissionDeclaration(record.role);
    assert.equal(declaration.name, record.outputTool);
    assert.equal(Array.isArray(declaration.statusWords), true);
  }
});

test("shared submission returns each original payload and does not reject shape", async () => {
  const { host, tools } = hostCapturingTools();
  const declaration = roleSubmissionDeclaration("merger");
  registerFiledSubmissionTool(host, declaration, { readyError: () => undefined });
  const tool = tools.get(declaration.name);
  assert.ok(tool);
  assert.equal(tool.parameters, declaration.parameters);
  const first = { status: "completed", report: "one" };
  const firstResult = await tool.execute("call-1", first, undefined, undefined, {});
  assert.equal(firstResult.terminate, true);
  assert.equal(firstResult.details, first);
  assert.deepEqual(firstResult.content, []);
  const second = { unexpected: true, status: "not-a-word" };
  const secondResult = await tool.execute("call-2", second, undefined, undefined, {});
  assert.equal(secondResult.details, second);
  assert.equal(secondResult.terminate, true);
});

test("shared submission still surfaces an established reminder", async () => {
  const { host, tools } = hostCapturingTools();
  const declaration = roleSubmissionDeclaration("coder");
  registerFiledSubmissionTool(host, declaration, {
    readyError: () => undefined,
    beforeAccept: async () => {
      throw new Error("commit reminder");
    },
  });
  const tool = tools.get(declaration.name);
  assert.ok(tool);
  await assert.rejects(
    () => tool.execute("call-1", { status: "completed" }, undefined, undefined, {}),
    /commit reminder/,
  );
});
