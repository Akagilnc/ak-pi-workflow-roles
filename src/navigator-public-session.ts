/**
 * Navigator attendance session factory (#675 r3).
 * Each prepare turn uses the public navigator activation path (summonPublicRole) —
 * same seat table and shared envelope as `ak-role navigator`.
 * Archivist createRecordSession only books route-memory nest under the parent;
 * no openPiInProcessSession second lifecycle / no agentDir patch on the old path.
 */
import { sitianReport } from "./sitian-facade.ts";
import {
  NavigatorUnavailableError,
  navigatorProviderFailureFromPublicTerminal,
  navigatorProviderFailureFromError,
  navigatorUnavailableError,
  parseNavigatorModelSetting,
  type NavigatorProviderFailureFact,
  type NavigatorSessionFactory,
} from "./navigator-session-contracts.ts";
import type { NoReceiptLifecycleFacts } from "./receipt-delivery-policy.ts";
import { runDirectoryFromHostContext, type HostContext } from "./host-contracts.ts";

/**
 * Ledger process home for navigator attendance: admitted HostContext.runDirectory
 * first, else a parent session file under .ak-roles. Never context.home / env HOME /
 * passwd guesses — those split the nest from the owning run (#852).
 */
async function resolveNavigatorLedgerHome(context: HostContext): Promise<string | undefined> {
  const { tryHomeFromAkRolesPath } = await import(
    "./activation-ledger-topology.ts"
  );
  const runDirectory = runDirectoryFromHostContext(context);
  if (runDirectory !== undefined) {
    const fromRun = tryHomeFromAkRolesPath(runDirectory);
    if (fromRun !== undefined && fromRun.length > 0) return fromRun;
  }
  const parentFile = context.sessionManager?.getSessionFile?.();
  if (typeof parentFile === "string" && parentFile.trim() !== "") {
    const fromParent = tryHomeFromAkRolesPath(parentFile);
    if (fromParent !== undefined && fromParent.length > 0) return fromParent;
  }
  return undefined;
}

export function createNativeNavigatorSessionFactory(): NavigatorSessionFactory {
  return async ({ context, subject, tool }) => {
    // Model is enforced at prepare (attendance seat resolve) and at prompt (summon).
    // Factory open only books the archivist nest — no package default, no eager seat read.
    let thinkingLevel: string | undefined;

    // Archivist nest for attendance route memory only (ADR 0018 / 0065) — not a session open.
    // #852: navigator/<work-subject> is the sole book-top exception; always pass subject so
    // unmaterialized/missing parent still gets a durable nest instead of silent in-memory.
    // Home comes from HostContext.runDirectory (or ledger parent path) — never context.home.
    const { createRecordSession, NAVIGATOR_RECORD_KIND } = await import("./archivist-record-entry.ts");
    const home = await resolveNavigatorLedgerHome(context);
    const sessionManager = createRecordSession({
      cwd: context.cwd,
      kind: NAVIGATOR_RECORD_KIND,
      subject,
      ...(context.sessionManager !== undefined ? { parent: context.sessionManager } : {}),
      ...(home !== undefined ? { home } : {}),
    });

    let providerFailure: NavigatorProviderFailureFact | undefined;
    let noReceipt: NoReceiptLifecycleFacts | undefined;
    let disposed = false;
    let inFlightPrompt: Promise<unknown> | undefined;

    return {
      prompt: async (text) => {
        if (disposed) {
          throw navigatorUnavailableError("session", new Error("Navigator attendance was disposed"));
        }
        providerFailure = undefined;
        noReceipt = undefined;
        const run = (async () => {
        try {
          const { summonPublicRole } = await import("./public-role-summons.ts");
          const summonHome = await resolveNavigatorLedgerHome(context);
          // Public activation — same face as `ak-role navigator <instruction>` (#675).
          const summoned = await summonPublicRole({
            role: "navigator",
            argv: [text],
            cwd: context.cwd,
            ...(summonHome === undefined ? {} : { home: summonHome }),
          });

          const outcome = summoned.terminal?.roleOutcome;
          if (outcome === undefined) {
            const detail = summoned.stderr?.trim() || `exit ${summoned.exitCode}`;
            // Known source is the public-summon transport path; unconfirmed cause stays unknown.
            providerFailure = { source: "transport", cause: "unknown" };
            throw navigatorUnavailableError(
              providerFailure.source,
              new Error(`Navigator public summon produced no terminal (${detail})`),
              providerFailure.cause,
            );
          }
          if (outcome.kind === "failure") {
            providerFailure = navigatorProviderFailureFromPublicTerminal(outcome);
            throw navigatorUnavailableError(
              providerFailure.source,
              new Error(outcome.diagnostic),
              providerFailure.cause,
            );
          }
          if (outcome.kind === "no_receipt") {
            // The nested session spent its own delivery budget; attendance settles
            // no-receipt on these facts instead of opening another summon (#675).
            noReceipt = outcome;
            return;
          }
          if (outcome.kind !== "accepted") {
            // Non-accepted kinds (e.g. audit_escalation): no prose advice this turn.
            // Not a shape-unusable judgment on the navigator reply (#757).
            return;
          }
          // #959: present navigator words as prose. No candidates/next parsing.
          const { navigatorProseFromUnknown } = await import("./package-contracts/navigator-output.ts");
          const proseParts: string[] = [];
          for (const payload of outcome.payloads ?? []) {
            const prose = navigatorProseFromUnknown(payload);
            if (prose !== undefined) proseParts.push(prose);
          }
          if (proseParts.length === 0) return;
          await tool.execute(
            "navigator-public-prepare",
            { prose: proseParts.join("\n\n") },
            undefined,
            undefined,
            context as never,
          );
        } catch (error) {
          if (error instanceof NavigatorUnavailableError) throw error;
          const fact = navigatorProviderFailureFromError(error);
          // Catch path is the public-summon seam (source transport); untyped cause stays unknown.
          providerFailure = fact ?? { source: "transport", cause: "unknown" };
          throw navigatorUnavailableError(providerFailure.source, error, providerFailure.cause);
        }
        })();
        inFlightPrompt = run;
        try {
          await run;
        } finally {
          if (inFlightPrompt === run) inFlightPrompt = undefined;
        }
      },
      providerFailure: () => providerFailure,
      noReceipt: () => noReceipt,
      appendEntry: (customType, data) => {
        sessionManager.appendCustomEntry(customType, data);
        try {
          sitianReport({
            level: "event",
            kind: "attendance",
            cwd: context.cwd,
            sessionParent: sessionManager.getSessionFile(),
            payload: { customType, data },
            source: "navigator-public-session",
          });
        } catch {
          // best-effort
        }
      },
      entries: () => sessionManager.getEntries(),
      setModel: async (next, nextThinking) => {
        let nextParsed: ReturnType<typeof parseNavigatorModelSetting>;
        try {
          nextParsed = parseNavigatorModelSetting(next);
        } catch (error) {
          throw navigatorUnavailableError("model", error);
        }
        // No live provider session is pinned here: every prompt is an independent
        // public summon whose nested CLI reads the current seat table (#675 验收②
        // / #617 DK-3). A seat edit between prepares therefore applies on the next
        // summon — it is never an unavailable session.
        thinkingLevel = nextThinking ?? nextParsed.thinkingLevel;
      },
      getThinkingLevel: () => thinkingLevel,
      recordPointer: () => sessionManager.getSessionDir(),
      dispose: async () => {
        disposed = true;
        const pending = inFlightPrompt;
        if (pending !== undefined) await pending.catch(() => undefined);
      },
    };
  };
}
