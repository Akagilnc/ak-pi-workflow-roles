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
  resolveNavigatorSeatSelection,
  type NavigatorProviderFailureFact,
  type NavigatorSessionFactory,
} from "./navigator-session-contracts.ts";
import type { NoReceiptLifecycleFacts } from "./receipt-delivery-policy.ts";

export function createNativeNavigatorSessionFactory(): NavigatorSessionFactory {
  return async ({ context, subject, tool }) => {
    const resolved = await resolveNavigatorSeatSelection(context);
    let thinkingLevel = resolved.thinkingLevel;

    // Archivist nest for attendance route memory only (ADR 0018 / 0065) — not a session open.
    const { createRecordSession } = await import("./archivist-record-entry.ts");
    const parentFile = context.sessionManager?.getSessionFile?.();
    const sessionManager = createRecordSession({
      cwd: context.cwd,
      kind: "navigator",
      ...(typeof parentFile === "string" && parentFile.length > 0 ? { subject, parent: context.sessionManager } : {}),
    });

    let providerFailure: NavigatorProviderFailureFact | undefined;
    let noReceipt: NoReceiptLifecycleFacts | undefined;
    let disposed = false;
    let inFlightPrompt: Promise<unknown> | undefined;

    const resolveHome = async (): Promise<string | undefined> => {
      const parentFile = context.sessionManager?.getSessionFile?.();
      if (typeof parentFile === "string" && parentFile.trim() !== "") {
        try {
          const { tryHomeFromAkRolesPath, homeFromRunDirectory } = await import(
            "./activation-ledger-topology.ts"
          );
          const fromParent = tryHomeFromAkRolesPath(parentFile);
          if (fromParent !== undefined && fromParent.length > 0) return fromParent;
          const runDir = parentFile.replace(/\/session\/session\.jsonl$/, "");
          if (runDir !== parentFile) {
            try {
              return homeFromRunDirectory(runDir);
            } catch {
              // fall through
            }
          }
        } catch {
          // fall through
        }
      }
      const envHome = process.env.HOME;
      return typeof envHome === "string" && envHome.trim() !== "" ? envHome : undefined;
    };

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
          const home = await resolveHome();
          // Public activation — same face as `ak-role navigator <instruction>` (#675).
          const summoned = await summonPublicRole({
            role: "navigator",
            argv: [text],
            cwd: context.cwd,
            ...(home === undefined ? {} : { home }),
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
            // Non-accepted kinds (e.g. audit_escalation): no route advice this turn.
            // Not a shape-unusable judgment on the navigator reply (#757).
            return;
          }
          for (const payload of outcome.payloads ?? []) {
            if (typeof payload !== "object" || payload === null || Array.isArray(payload)) continue;
            const candidates = (payload as { candidates?: unknown }).candidates;
            if (!Array.isArray(candidates)) continue;
            await tool.execute(
              "navigator-public-prepare",
              { candidates },
              undefined,
              undefined,
              context as never,
            );
          }
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
