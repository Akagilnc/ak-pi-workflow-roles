/**
 * Shared fixtures for Navigator attendance coverage (#420 / #959).
 * #959: navigator speaks prose — fixtures submit free-form advice, not candidates.
 */
import { createNavigatorAttendance, NAVIGATOR_PREPARE_TOOL_NAME, type NavigatorPreparationSession } from "../../src/navigator-attendance.ts";
import { RECEIPT_DELIVERY_TURN_LIMIT, type NoReceiptLifecycleFacts } from "../../src/receipt-delivery-policy.ts";

export function context(home?: string) {
  return {
    sessionManager: {
      getSessionId: () => "invocation",
    },
    cwd: "/repo",
    // Explicit home only — callers write seat fixture under their own withTempRoot.
    ...(typeof home === "string" ? { home } : {}),
  } as never;
}

/** Prose advice batch for prepare tool.execute. */
export function proseAdvice(prose = "下一步送 reviewer 独立审阅实现。"): { prose: string } {
  return { prose };
}

/**
 * @deprecated #959 candidate shape retired — kept as alias that maps to prose so
 * older test call sites that still pass candidate-like objects via execute get
 * a prose body (navigatorProseFromUnknown stringifies free-form objects).
 */
export function candidate(overrides: Record<string, unknown> = {}) {
  if (typeof overrides.prose === "string") return { prose: overrides.prose };
  if (typeof overrides.reason === "string") return { prose: overrides.reason };
  return {
    prose: "The implementation is ready for an independent review.",
    ...overrides,
  };
}

export function sessionHarness() {
  const entries: unknown[] = [];
  const modelSettings: Array<{ model: string; thinkingLevel?: string }> = [];
  let tool: any;
  let prompts = 0;
  let releasePrompt: (() => void) | undefined;
  const rejectedPrepareReasons: string[] = [];
  const transportFailures: string[] = [];
  let providerFailure: { source: "transport"; cause: "transport" } | undefined;
  const sessionNoReceipts: NoReceiptLifecycleFacts[] = [];
  let noReceipt: NoReceiptLifecycleFacts | undefined;
  const session: NavigatorPreparationSession = {
    async prompt(_text) {
      prompts += 1;
      providerFailure = undefined;
      noReceipt = sessionNoReceipts.shift();
      // A session that settled without an accepted receipt returns its turn.
      if (noReceipt !== undefined) return;
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
    noReceipt: () => noReceipt,
    async setModel(model, thinkingLevel) {
      modelSettings.push(
        thinkingLevel === undefined ? { model } : { model, thinkingLevel },
      );
    },
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
    /** Next prompt settles the session itself without an accepted receipt (#675 nested no-receipt). */
    settleWithoutReceipt(...rejectedReasons: string[]) {
      sessionNoReceipts.push({
        terminalToolCalled: rejectedReasons.length > 0,
        rejectedReceipts: rejectedReasons.map((reason) => ({ reason, diagnosticAvailable: reason.trim() !== "" })),
        deliveryTurns: RECEIPT_DELIVERY_TURN_LIMIT,
        sessionCompletion: "settled-without-accepted-receipt",
        runPointer: "/fixture/nested-run",
        attemptPointer: "nested-attempt",
        acceptedReceipt: false,
      });
    },
    /** Production-retained typed context fact (ak-navigator-context), not a prompt metadata channel. */
    retainedContext: () => {
      const entry = [...entries].reverse().find((item: any) => item?.customType === "ak-navigator-context");
      return (entry as { data?: unknown } | undefined)?.data as any;
    },
    entries,
    modelSettings,
  };
}

export async function attendance(
  path: string,
  harness: ReturnType<typeof sessionHarness>,
  events: any[],
  loadRoleHelp: (role: string) => Promise<string> = async (role) => `pi --ak-role ${role} --help`,
  home?: string,
) {
  return createNavigatorAttendance({
    context: context(home), role: "coder", phase: "apply", subjectKey: "/repo/.ak/work/issues/28",
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
 * Complete settle. #959: no settlement-bound rebind — prose advice settles once.
 * rebindBatch is ignored (kept for call-site compatibility during migration).
 */
export async function settleAnsweringRebind(
  nav: { settle(settlement: unknown): Promise<void> },
  harness: ReturnType<typeof sessionHarness>,
  settlement: unknown,
  _rebindBatch?: unknown,
  _rebindToolCallId = "settlement-rebind",
): Promise<void> {
  await nav.settle(settlement);
}
