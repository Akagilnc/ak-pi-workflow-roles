/**
 * Shared fixtures for Navigator attendance coverage (#420 整改拆分).
 * Extracted verbatim from test/contract/navigator-attendance.test.ts — no behavior change.
 */
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createNavigatorAttendance, NAVIGATOR_PREPARE_TOOL_NAME, type NavigatorCandidate, type NavigatorPreparationSession } from "../../src/navigator-attendance.ts";

export function context() {
  return {
    sessionManager: {
      getSessionId: () => "invocation",
    },
    cwd: "/repo",
  } as never;
}

export function candidate(overrides: Partial<NavigatorCandidate> = {}) {
  const base: NavigatorCandidate = {
    id: "small-fix",
    matches: { role: "coder", phase: "apply" as const, kind: "accepted" as const, statuses: ["completed", "refused"] },
    route: [{ role: "coder" as const, phase: "apply" as const }, { role: "reviewer" as const, phase: null }, { role: "judge" as const, phase: null }],
    next: { role: "reviewer" as const, phase: null },
    reason: "The implementation is ready for an independent review.",
  };
  return {
    candidates: [{
      ...base,
      ...overrides,
      matches: { ...base.matches!, ...(overrides.matches ?? {}) },
    }],
  };
}

export async function cleanupTempDir(root: string, primaryFailure?: unknown): Promise<void> {
  try {
    await rm(root, { recursive: true, force: true });
  } catch (cleanupFailure) {
    if (primaryFailure === undefined) throw cleanupFailure;
    throw new AggregateError([primaryFailure, cleanupFailure], "Test failed and cleanup failed", { cause: primaryFailure });
  }
}

export function sessionHarness() {
  const entries: unknown[] = [];
  const modelSettings: Array<{ model: string; thinkingLevel: string }> = [];
  let tool: any;
  let prompts = 0;
  let releasePrompt: (() => void) | undefined;
  const rejectedPrepareReasons: string[] = [];
  const transportFailures: string[] = [];
  let providerFailure: { source: "transport"; cause: "transport" } | undefined;
  const session: NavigatorPreparationSession = {
    async prompt(_text) {
      prompts += 1;
      providerFailure = undefined;
      const rejected = rejectedPrepareReasons.shift();
      if (rejected !== undefined) {
        const id = `rejected-prepare-${prompts}`;
        entries.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: NAVIGATOR_PREPARE_TOOL_NAME, arguments: undefined }] } });
        entries.push({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: NAVIGATOR_PREPARE_TOOL_NAME, isError: true, content: [{ type: "text", text: rejected }] } });
        throw new Error(rejected);
      }
      const transport = transportFailures.shift();
      if (transport !== undefined) {
        providerFailure = { source: "transport", cause: "transport" };
        throw new Error(transport);
      }
      await new Promise<void>((resolve) => { releasePrompt = resolve; });
    },
    appendEntry(_type, data) { entries.push({ type: "custom", customType: _type, data }); },
    entries: () => entries,
    providerFailure: () => providerFailure,
    async setModel(model, thinkingLevel) { modelSettings.push({ model, thinkingLevel }); },
    recordPointer: () => "/fixture/navigator-record",
    dispose() {},
  };
  return {
    factory: async ({ tool: nextTool }: { tool: any }) => { tool = nextTool; return session; },
    tool: () => tool,
    release: () => releasePrompt?.(),
    prompts: () => prompts,
    rejectPrepare(...reasons: string[]) { rejectedPrepareReasons.push(...reasons); },
    failTransport(...reasons: string[]) { transportFailures.push(...reasons); },
    /** Production-retained typed context fact (ak-navigator-context), not a prompt metadata channel. */
    retainedContext: () => {
      const entry = [...entries].reverse().find((item: any) => item?.customType === "ak-navigator-context");
      return (entry as { data?: unknown } | undefined)?.data as any;
    },
    entries,
    modelSettings,
  };
}

export async function attendance(path: string, harness: ReturnType<typeof sessionHarness>, events: any[], loadRoleHelp: (role: string) => Promise<string> = async (role) => `pi --ak-role ${role} --help`) {
  return createNavigatorAttendance({
    context: context(), role: "coder", phase: "apply", subjectKey: "/repo/.ak/work/issues/28",
    subject: "Fix issue 28", authority: "owner decision",
    loadSoul: async () => "route judgment",
    loadRoutePlaybook: async () => "arbitrary advisory prose",
    loadRoleHelp,
    createSession: harness.factory,
    modelSettingPath: path,
    onEvent: async (event) => { events.push(event); },
  });
}

/**
 * Complete settle. Unmatched speculative advice triggers one settlement-bound rebind
 * (stale-context repair, not next.role legality). Answer that rebind with the same batch
 * when the harness opens a second prompt; matched advice completes without it.
 */
export async function settleAnsweringRebind(
  nav: { settle(settlement: unknown): Promise<void> },
  harness: ReturnType<typeof sessionHarness>,
  settlement: unknown,
  rebindBatch: unknown,
  rebindToolCallId = "settlement-rebind",
): Promise<void> {
  const promptsBefore = harness.prompts();
  let settled = false;
  const settling = nav.settle(settlement).finally(() => { settled = true; });
  // Poll until settle finishes or a settlement-bound rebind opens another prompt.
  while (!settled && harness.prompts() <= promptsBefore) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (!settled) {
    while (harness.tool() === undefined && !settled) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (!settled) {
      await harness.tool().execute(rebindToolCallId, rebindBatch as never, undefined, undefined, {} as never);
      harness.release();
    }
  }
  await settling;
}
