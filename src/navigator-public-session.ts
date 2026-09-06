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
  navigatorProviderFailureFromDiagnostics,
  navigatorProviderFailureFromError,
  navigatorProviderFailureFromStatus,
  navigatorUnavailableError,
  parseNavigatorModelSetting,
  resolveNavigatorSeatSelection,
  type NavigatorProviderFailureFact,
  type NavigatorSessionFactory,
} from "./navigator-session-contracts.ts";

/**
 * Classify public-navigator failure terminal from structured decisiveFacts only
 * (httpStatus / diagnostics / secondaryEvidence on the terminal) — same fields
 * settlement already stamps from typed HTTP observation / provider stop.
 */
function providerFailureFromPublicTerminal(outcome: {
  readonly cause: string;
  readonly diagnostic: string;
  readonly decisiveFacts: Readonly<Record<string, unknown>>;
}): NavigatorProviderFailureFact {
  const facts = outcome.decisiveFacts;
  const secondary =
    typeof facts.secondaryEvidence === "object" && facts.secondaryEvidence !== null
      ? (facts.secondaryEvidence as Record<string, unknown>)
      : undefined;
  const httpStatus =
    typeof secondary?.httpStatus === "number"
      ? secondary.httpStatus
      : typeof facts.httpStatus === "number"
        ? facts.httpStatus
        : typeof facts.errorCode === "number"
          ? facts.errorCode
          : undefined;
  const fromStatus = navigatorProviderFailureFromStatus(httpStatus);
  if (fromStatus !== undefined) return fromStatus;
  const diagnostics = secondary?.diagnostics ?? facts.diagnostics;
  const fromDiagnostics = navigatorProviderFailureFromDiagnostics(diagnostics);
  if (fromDiagnostics !== undefined) return fromDiagnostics;
  const fromCode = navigatorProviderFailureFromError({
    code: secondary?.code ?? facts.errorCode,
  });
  if (fromCode !== undefined) return fromCode;
  if (outcome.cause === "provider") return { source: "transport", cause: "transport" };
  return { source: "session", cause: "session" };
}

export function createNativeNavigatorSessionFactory(): NavigatorSessionFactory {
  return async ({ context, subject, tool }) => {
    const resolved = await resolveNavigatorSeatSelection(context);
    let selection = resolved.selection;
    let thinkingLevel = resolved.thinkingLevel;
    let configuredLabel = resolved.configuredLabel;

    // Archivist nest for attendance route memory only (ADR 0018 / 0065) — not a session open.
    const { createRecordSession } = await import("./archivist-record-entry.ts");
    const sessionManager = createRecordSession({
      cwd: context.cwd,
      kind: "navigator",
      subject,
      parent: context.sessionManager,
    });

    let providerFailure: NavigatorProviderFailureFact | undefined;
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
            providerFailure = { source: "transport", cause: "transport" };
            throw navigatorUnavailableError(
              "transport",
              new Error(`Navigator public summon produced no terminal (${detail})`),
            );
          }
          if (outcome.kind === "failure") {
            providerFailure = providerFailureFromPublicTerminal(outcome);
            throw navigatorUnavailableError(
              providerFailure.source,
              new Error(outcome.diagnostic),
              providerFailure.cause,
            );
          }
          if (outcome.kind === "no_receipt") {
            // No candidates — attendance no-receipt path.
            return;
          }
          if (outcome.kind !== "accepted") {
            providerFailure = { source: "session", cause: "session" };
            throw navigatorUnavailableError(
              "session",
              new Error("Navigator public summon returned unusable terminal"),
            );
          }
          const candidates = outcome.decisiveFacts.candidates;
          if (!Array.isArray(candidates)) {
            return;
          }
          // Rejoin attendance prepare tool sink (same candidate shape as public advice).
          await tool.execute(
            "navigator-public-prepare",
            { candidates },
            undefined,
            undefined,
            context as never,
          );
        } catch (error) {
          if (error instanceof NavigatorUnavailableError) throw error;
          const fact = navigatorProviderFailureFromError(error);
          providerFailure = fact ?? { source: "transport", cause: "transport" };
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
        if (
          nextParsed.provider !== selection.provider
          || nextParsed.model !== selection.model
        ) {
          throw new NavigatorUnavailableError(
            "model",
            `Navigator model switch requires a new session: ${configuredLabel} → ${next}`,
          );
        }
        // Seat table applies on the next public summon (#675 / #697).
        const appliedThinking = nextThinking ?? nextParsed.thinkingLevel;
        selection = {
          provider: nextParsed.provider,
          model: nextParsed.model,
          ...(appliedThinking === undefined ? {} : { thinking: appliedThinking }),
        };
        thinkingLevel = appliedThinking;
        configuredLabel = next;
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
