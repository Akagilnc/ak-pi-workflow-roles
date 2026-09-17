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
      // Executor runs sync: park flag is visible before prompt() yields to the caller.
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
    /** True while prompt() is parked on the release gate (not merely counted). */
    isPromptParked: () => releasePrompt !== undefined,
    release: () => {
      const release = releasePrompt;
      releasePrompt = undefined;
      release?.();
    },
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

/** Yield until the event-loop condition holds. No fixed spin budget — those race createSession under load. */
async function waitForEventLoop(condition: () => boolean): Promise<void> {
  while (!condition()) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * Release the early ready-wait prompt gate.
 * Early prepare parks on harness.release; settle awaits that prepare. A fixed
 * setImmediate budget that loses the race with createSession deadlocks:
 * settle waits for the parked prompt, the helper waits for settle's feed prompt
 * (#959 CI: navigator-attendance{,-seams,-routes} file timeouts).
 *
 * Gate state, not cumulative prompt count: if the early prompt is already
 * parked, prompts() == before and waiting for prompts() > before self-locks
 * (release is after the wait). Wait for isPromptParked (or a finished
 * non-parking prompt) then release only when parked.
 */
async function releaseEarlyReadyWait(
  harness: ReturnType<typeof sessionHarness>,
): Promise<void> {
  const before = harness.prompts();
  await waitForEventLoop(
    () => harness.isPromptParked() || harness.prompts() > before,
  );
  if (!harness.isPromptParked()) {
    // Rejected/transport/no-receipt path finished the prompt without parking.
    await new Promise<void>((resolve) => setImmediate(resolve));
    return;
  }
  harness.release();
  // Prompt continuation finishes the early turn on the next macrotask.
  await new Promise<void>((resolve) => setImmediate(resolve));
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
  // Finish early ready-wait only when prepare() is in flight. Do not key off
  // cumulative prompt count — prior settles leave prompts() > 0 and would hang
  // waiting for a prompt that never opens.
  if (nav.isPreparing()) {
    await releaseEarlyReadyWait(harness);
  }
  const targetPrompts = harness.prompts() + 1;
  const waiting = nav.settle(settlement as never);
  await waitForEventLoop(() => harness.prompts() >= targetPrompts && harness.tool() !== undefined);
  await harness.tool().execute(toolCallId, body as never, undefined, undefined, {} as never);
  harness.release();
  await waiting;
}
