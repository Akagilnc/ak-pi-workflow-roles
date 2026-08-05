import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  ActivationBarrierError,
  createRoleRuntimeExtension,
  type ActivationTraceRecord,
} from "../../src/role-runtime.ts";
import { PACKAGED_ROLE_REGISTRY } from "../../src/packaged-role-registry.ts";
import {
  activationBookKeyFor,
  activationExtensionContext,
  readAcceptedActivationFacts,
  withActivationHome,
} from "../helpers/pi-test-harness.ts";

const originalExitCode = process.exitCode;
afterEach(() => { process.exitCode = originalExitCode; });

type CapturedExtensionHandler = (
  event: Record<string, unknown>,
  ctx: ExtensionContext,
) => unknown;

function captureExtensionHandlers(
  install: (pi: ExtensionAPI) => void,
  options: {
    getFlag?: (name: string) => unknown;
  } = {},
): {
  handlers: Map<string, CapturedExtensionHandler[]>;
} {
  const handlers = new Map<string, CapturedExtensionHandler[]>();
  const tools = new Map<string, { name: string }>();
  let activeTools: string[] = [];
  const pi = {
    registerFlag() {},
    registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
    setActiveTools(names: string[]) { activeTools = [...names]; },
    getActiveTools() { return [...activeTools]; },
    getAllTools() { return [...tools.values()]; },
    getCommands() { return []; },
    getFlag(name: string) { return options.getFlag?.(name); },
    on(name: string, handler: CapturedExtensionHandler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  install(pi);
  return { handlers };
}

test("every registered whole-activation rejection terminates nonzero with a named cause before a model turn", async () => {
  await withActivationHome({ prefix: "ak-act-reject-" }, async ({ home }) => {
    for (const entry of PACKAGED_ROLE_REGISTRY) {
      process.exitCode = undefined;
      const traces: ActivationTraceRecord[] = [];
      let aborts = 0;
      let providerTurns = 0;
      const rejection = new TypeError(`${entry.role} activation rejected`);
      const reject = async (): Promise<never> => { throw rejection; };
      const flags: Record<string, unknown> = {
        "ak-role": entry.role,
        "ak-doctor-case": "/lawful/case",
        "ak-merger-input": "/lawful/merger.json",
      };
      const { handlers } = captureExtensionHandlers(
        (pi) => createRoleRuntimeExtension({
          loadJudgeSoul: reject,
          loadFixerSoul: reject,
          loadCoderSoul: reject,
          loadReviewerSoul: reject,
          loadCollectorSoul: reject,
          loadDoctorSoul: reject,
          loadMergerSoul: reject,
          createMergerGitState: () => ({ activeMerge: reject, completedMerge: reject }),
          transcriptFromContext: () => "",
          auditSoulCompliance: async () => ({ status: "pass" }),
          activationClock: () => "2025-01-01T00:00:00.000Z",
          activationTraceWriter: (record) => { traces.push(record); },
        })(pi),
        { getFlag: (name) => flags[name] },
      );
      const ctx = activationExtensionContext({
        cwd: home,
        abort() { aborts++; },
      });
      const start = handlers.get("session_start")?.[0];
      assert.ok(start);
      await assert.rejects(async () => start({ reason: "startup" }, ctx), rejection);

      await assert.rejects(async () => {
        for (const before of handlers.get("before_agent_start") ?? []) await before({}, ctx);
        providerTurns++;
      }, (error: unknown) => error instanceof ActivationBarrierError);
      assert.equal(providerTurns, 0, `${entry.role} reached the provider`);
      assert.equal(aborts, 2);
      assert.equal(process.exitCode, 1);
      assert.equal(
        readAcceptedActivationFacts(home, activationBookKeyFor(home)).length,
        0,
        `${entry.role} wrote an accepted-activation fact on rejection`,
      );
      const failed = traces.find((trace) => trace.status === "failed");
      assert.ok(failed && failed.status === "failed");
      assert.equal(failed.cause.identity, "TypeError");
      assert.equal(failed.cause.name, "TypeError");
      assert.equal(failed.cause.message, `${entry.role} activation rejected`);
      if (typeof failed.cause.evidenceId !== "string") throw new Error("missing activation evidence id");
      assert.match(failed.cause.evidenceId, /^activation-cause-/);
    }
  });
});
