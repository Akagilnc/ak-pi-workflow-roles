/**
 * #590: grok-build production deps wire the four formerly Pi-only sub-legs
 * on the shared host-neutral institutional seam (no "not wired" throws).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { readJudgeAuditSubjects } from "../../src/dossier-resolution.ts";
import { createGrokRoleRuntimeDependencies } from "../../src/grok/production-host.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

test("createGrokRoleRuntimeDependencies wires judge/doctor audit, reviewer dispatch, and navigator", () => {
  const deps = createGrokRoleRuntimeDependencies(packageRoot);

  assert.equal(typeof deps.auditSoulCompliance, "function");
  assert.equal(typeof deps.auditDoctorCompliance, "function");
  assert.equal(typeof deps.runReviewerDispatch, "function");
  assert.equal(typeof deps.shutdownReviewerAgent, "function");
  assert.equal(typeof deps.createNavigatorAttendance, "function");
  assert.equal(typeof deps.loadNavigatorWorkContext, "function");
});

test("grok auditSoulCompliance does not throw the legacy not-wired stub", async () => {
  const deps = createGrokRoleRuntimeDependencies(packageRoot);
  const context = {
    cwd: process.cwd(),
    mode: "print",
    model: undefined,
    sessionManager: {
      getLeafEntry: () => undefined,
      getLeafId: () => null,
      getEntries: () => [],
      getSessionDir: () => "/tmp",
      getSessionFile: () => undefined,
    },
    abort() {},
  };

  await assert.rejects(
    () => deps.auditSoulCompliance({ context }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.equal(message.includes("not wired"), false, message);
      return true;
    },
  );
});

test("first-record-then-audit subjects resolve from host-neutral session books shape", () => {
  // Mirrors grok role-envelope booking: user assignment + assistant tool-call leaf.
  const entries = [
    { type: "message", message: { role: "user", content: "OWNER ASSIGNMENT" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "v1",
          name: JUDGE_OUTPUT_TOOL_NAME,
          arguments: { judgeStatus: "converged" },
        }],
      },
    },
  ];
  const subjects = readJudgeAuditSubjects({
    sessionManager: { getEntries: () => entries },
  });
  assert.equal(subjects.status, "ok");
});
