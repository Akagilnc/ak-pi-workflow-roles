/**
 * #632 — countersign → Notary gate is pointer-only (kind routing; no body material).
 * Ticket/source-run self-fetch lives with the officer dossier tool, not gate argv.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "../../src/countersign-contracts.ts";
import { createCountersignRoleRuntime } from "../../src/role-runtime.ts";

type GateCall = { readonly kind: string; readonly subject: unknown };

async function submitThroughGate(): Promise<{ readonly gateCalls: GateCall[] }> {
  const tools = new Map<string, { name: string; execute: Function }>();
  const gateCalls: GateCall[] = [];
  const roleHost = {
    registerTool(tool: { name: string; execute: Function }) {
      tools.set(tool.name, tool);
    },
    on() {},
    getAllTools() {
      return [{ name: COUNTERSIGN_OUTPUT_TOOL_NAME }];
    },
    getFlag() {
      return undefined;
    },
    async requireGatekeeperPass(options: {
      subject: { kind: string };
    }) {
      gateCalls.push({
        kind: options.subject.kind,
        subject: options.subject,
      });
    },
  };
  await createCountersignRoleRuntime(
    roleHost as never,
    { loadSoul: async () => "LAW" },
    {
      failInfrastructure(): never {
        throw new Error("fail");
      },
      bindSubmissionNonPass() {},
    },
  ).activate();

  await tools.get(COUNTERSIGN_OUTPUT_TOOL_NAME)!.execute(
    "call-1",
    { countersignStatus: "converged" },
    undefined,
    undefined,
    {
      cwd: "/tmp",
      mode: "json",
      model: undefined,
      sessionManager: {} as never,
      abort() {},
    },
  );
  return { gateCalls };
}

test("countersign gate summons Notary with kind only — no verdict/ticket body", async () => {
  const { gateCalls } = await submitThroughGate();
  assert.equal(gateCalls.length, 1);
  assert.equal(gateCalls[0]!.kind, "countersign_verdict");
  assert.deepEqual(gateCalls[0]!.subject, { kind: "countersign_verdict" });
  assert.equal(
    Object.prototype.hasOwnProperty.call(gateCalls[0]!.subject as object, "material"),
    false,
  );
});
