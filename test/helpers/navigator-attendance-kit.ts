/**
 * Shared fixtures for Navigator attendance coverage (#420 / #959 / #1160).
 * #1160: prepare runs the model in parallel; settle picks by status — no second round.
 */
import { createNavigatorAttendance, NAVIGATOR_PREPARE_TOOL_NAME, type NavigatorPreparationSession } from "../../src/navigator-attendance.ts";
import { type NoReceiptLifecycleFacts } from "../../src/receipt-delivery-policy.ts";

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

/** Single-prose advice batch for prepare tool.execute. */
export function proseAdvice(prose = "下一步送 reviewer 独立审阅实现。"): { prose: string } {
  return { prose };
}

/** Status-keyed prepare batch (#1160). */
export function byStatusAdvice(
  byStatus: Record<string, string> = {
    completed: "下一步送 reviewer 独立审阅实现。",
    unfinished: "继续同一 worker apply。",
  },
): { byStatus: Record<string, string> } {
  return { byStatus };
}

export function sessionHarness() {
  const entries: unknown[] = [];
  const modelSettings: Array<{ model: string; thinkingLevel?: string }> = [];
  const promptTexts: string[] = [];
  let tool: any;
  let prompts = 0;
  let releasePrompt: (() => void) | undefined;
  const rejectedPrepareReasons: string[] = [];
  const transportFailures: string[] = [];
  let providerFailure: { source: "transport"; cause: "transport" } | undefined;
  let playbookReadFailure: string | undefined;
  const sessionNoReceipts: NoReceiptLifecycleFacts[] = [];
  let noReceipt: NoReceiptLifecycleFacts | undefined;
  const session: NavigatorPreparationSession = {
    async prompt(text: string) {
      prompts += 1;
      promptTexts.push(text);
      providerFailure = undefined;
      const rejected = rejectedPrepareReasons.shift();
      if (rejected !== undefined) {
        const id = `rejected-prepare-${prompts}`;
        entries.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: NAVIGATOR_PREPARE_TOOL_NAME, arguments: undefined }] } });
        entries.push({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: NAVIGATOR_PREPARE_TOOL_NAME, isError: true, content: [{ type: "text", text: rejected }] } });
        throw new Error(rejected);
      }
      noReceipt = sessionNoReceipts.shift();
      // A session that settled without an accepted receipt returns its turn.
      if (noReceipt !== undefined) return;
      const transport = transportFailures.shift();
      if (transport !== undefined) {
        providerFailure = { source: "transport", cause: "transport" };
        throw new Error(transport);
      }
      // Executor runs sync: park flag is visible before prompt() yields to the caller.
      await new Promise<void>((resolve) => { releasePrompt = resolve; });
    },
    appendEntry(_type, data) { entries.push({ type: "custom", customType: _type, data }); },
    entries: () => entries,
    providerFailure: () => providerFailure,
    noReceipt: () => noReceipt,
    routePlaybookReadFailure: () => playbookReadFailure,
    async setModel(model, thinkingLevel) {
      modelSettings.push(
        thinkingLevel === undefined ? { model } : { model, thinkingLevel },
      );
    },
    dispose() {},
  };
  return {
    factory: async ({ tool: nextTool }: { tool: any }) => { tool = nextTool; return session; },
    tool: () => tool,
    /** True while prompt() is parked on the release gate (not merely counted). */
    isPromptParked: () => releasePrompt !== undefined,
    release: () => {
      const release = releasePrompt;
      releasePrompt = undefined;
      release?.();
    },
    prompts: () => prompts,
    promptTexts: () => promptTexts,
    rejectPrepare(...reasons: string[]) { rejectedPrepareReasons.push(...reasons); },
    failTransport(...reasons: string[]) { transportFailures.push(...reasons); },
    setRoutePlaybookReadFailure(message: string) { playbookReadFailure = message; },
    /** Next prompt settles the session itself without an accepted receipt (#675 nested no-receipt). */
    settleWithoutReceipt(...rejectedReasons: string[]) {
      sessionNoReceipts.push({
        terminalToolCalled: rejectedReasons.length > 0,
        rejectedReceipts: rejectedReasons.map((reason) => ({ reason, diagnosticAvailable: reason.trim() !== "" })),
        // The nested session issued no delivery prompt. Record that, not a quota.
        deliveryTurns: 0,
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
  home?: string,
) {
  return createNavigatorAttendance({
    context: context(home), role: "coder", phase: "apply", subjectKey: "/repo/.ak/work/issues/28",
    subject: "Fix issue 28", authority: "owner decision",
    createSession: harness.factory,
    modelSettingPath: path,
    onEvent: async (event) => { events.push(event); },
  });
}

/** Yield until the event-loop condition holds. No fixed spin budget — those race createSession under load. */
async function waitForEventLoop(condition: () => boolean): Promise<void> {
  while (!condition()) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * Prepare either finishes, or a model round has already started.
 */
export async function waitForStandbyOrModelRound(
  nav: { isPreparing(): boolean },
  harness: { prompts(): number; isPromptParked(): boolean },
): Promise<void> {
  await waitForEventLoop(() => !nav.isPreparing() || harness.prompts() > 0 || harness.isPromptParked());
}

/** Submit body into a parked prepare round and wait until preparation settles. */
async function completeParkedPrepare(
  nav: { isPreparing(): boolean },
  harness: ReturnType<typeof sessionHarness>,
  body: unknown,
  toolCallId: string,
): Promise<void> {
  await waitForEventLoop(() => harness.isPromptParked() && harness.tool() !== undefined);
  await harness.tool().execute(toolCallId, body as never, undefined, undefined, {} as never);
  harness.release();
  await waitForEventLoop(() => !nav.isPreparing());
}

/**
 * Drive the parallel prepare model round with a body, then settle (no second prompt).
 */
export async function settleWithAdvice(
  nav: Awaited<ReturnType<typeof attendance>>,
  harness: ReturnType<typeof sessionHarness>,
  settlement: Parameters<Awaited<ReturnType<typeof attendance>>["settle"]>[0] | { kind: string; role: string; phase: "plan" | "apply" | null; status?: string },
  body: unknown = proseAdvice(),
  toolCallId = "prepare",
): Promise<void> {
  if (harness.isPromptParked() || nav.isPreparing()) {
    // Caller already started prepare — complete the parked round.
    await completeParkedPrepare(nav, harness, body, toolCallId);
  } else {
    // Fresh cycle: start prepare, complete it, then settle.
    await prepareWithAdvice(nav, harness, body, toolCallId);
  }
  await nav.settle(settlement as never);
}

/** Start prepare, submit body, wait until preparation is stored. */
export async function prepareWithAdvice(
  nav: Awaited<ReturnType<typeof attendance>>,
  harness: ReturnType<typeof sessionHarness>,
  body: unknown = proseAdvice(),
  toolCallId = "prepare",
): Promise<void> {
  const before = harness.prompts();
  nav.prepare();
  // prepare() is a no-op while a resolved preparation is still held until settle.
  if (!nav.isPreparing() && !harness.isPromptParked()) {
    return;
  }
  await completeParkedPrepare(nav, harness, body, toolCallId);
  void before;
}
