/**
 * Shared fixtures for Navigator attendance coverage (#420 整改拆分).
 * Extracted from test/contract/navigator-attendance.test.ts.
 * #178: package navigator default removed — fixtures supply a caller seat model.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createNavigatorAttendance, NAVIGATOR_PREPARE_TOOL_NAME, type NavigatorCandidate, type NavigatorPreparationSession } from "../../src/navigator-attendance.ts";
import { RECEIPT_DELIVERY_TURN_LIMIT, type NoReceiptLifecycleFacts } from "../../src/receipt-delivery-policy.ts";

const FIXTURE_NAVIGATOR_SEAT = { provider: "provider", model: "model" } as const;

/** Seed navigator seat only when the home has no model yet — never overwrite caller config. */
function ensureFixtureNavigatorSeat(
  home: string,
  seat: { provider: string; model: string } = FIXTURE_NAVIGATOR_SEAT,
): void {
  if (home.trim() === "") return;
  const path = join(home, ".ak-roles", "public-cli.json");
  let doc: { seats?: Record<string, Record<string, unknown>> } = { seats: {} };
  try {
    if (existsSync(path)) {
      doc = JSON.parse(readFileSync(path, "utf8")) as typeof doc;
      const row = doc.seats?.navigator;
      if (typeof row?.provider === "string" && typeof row?.model === "string") return;
    }
  } catch {
    doc = { seats: {} };
  }
  mkdirSync(dirname(path), { recursive: true });
  doc.seats = {
    ...(doc.seats ?? {}),
    navigator: { ...(doc.seats?.navigator ?? {}), ...seat },
  };
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
}

export function context(home = process.env.HOME ?? "") {
  ensureFixtureNavigatorSeat(home);
  return {
    sessionManager: {
      getSessionId: () => "invocation",
    },
    cwd: "/repo",
    home,
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

export async function attendance(path: string, harness: ReturnType<typeof sessionHarness>, events: any[], loadRoleHelp: (role: string) => Promise<string> = async (role) => `pi --ak-role ${role} --help`) {
  const home = dirname(path);
  let seat: { provider: string; model: string } = FIXTURE_NAVIGATOR_SEAT;
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as { model?: unknown };
    if (typeof raw.model === "string") {
      const slash = raw.model.indexOf("/");
      if (slash > 0 && slash < raw.model.length - 1) {
        const provider = raw.model.slice(0, slash);
        const rest = raw.model.slice(slash + 1);
        const colon = rest.lastIndexOf(":");
        const model = colon < 0 ? rest : rest.slice(0, colon);
        if (provider !== "" && model !== "") seat = { provider, model };
      }
    }
  } catch {
    // Missing legacy setting file is fine — fixture seat still applies.
  }
  ensureFixtureNavigatorSeat(home, seat);
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
