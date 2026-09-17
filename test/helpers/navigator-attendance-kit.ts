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

/** Release the current in-flight prompt gate (early ready-wait has no final advice body). */
async function releaseInFlightPrompt(harness: ReturnType<typeof sessionHarness>): Promise<void> {
  const before = harness.prompts();
  // Prompt may already be parked on the release gate.
  for (let i = 0; i < 20 && harness.prompts() < before + 1; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  harness.release();
  for (let i = 0; i < 40; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * #959: early prepare() runs the host round from parent start (ready and wait);
 * settle feeds currentSettlement and takes the output prompt.
 */
export async function settleWithAdvice(
  nav: Awaited<ReturnType<typeof attendance>>,
  harness: ReturnType<typeof sessionHarness>,
  settlement: Parameters<Awaited<ReturnType<typeof attendance>>["settle"]>[0] | { kind: string; role: string; phase: "plan" | "apply" | null; status?: string },
  body: unknown = proseAdvice(),
  toolCallId = "prepare",
): Promise<void> {
  // Finish early ready-wait if prepare() already opened a host prompt.
  if (nav.isPreparing() || harness.prompts() > 0) {
    const before = harness.prompts();
    await releaseInFlightPrompt(harness);
    // If prepare had not yet opened a prompt, settle path will open the feed prompt alone.
    if (harness.prompts() === before && nav.isPreparing()) {
      // Wait until early prompt exists, then release.
      for (let i = 0; i < 50 && harness.prompts() === before; i += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      harness.release();
      for (let i = 0; i < 40; i += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }
  const targetPrompts = harness.prompts() + 1;
  const waiting = nav.settle(settlement as never);
  while (harness.prompts() < targetPrompts || harness.tool() === undefined) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await harness.tool().execute(toolCallId, body as never, undefined, undefined, {} as never);
  harness.release();
  await waiting;
}
