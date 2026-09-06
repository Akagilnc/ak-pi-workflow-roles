/**
 * Navigator attendance session factory (#675).
 * Nested prepare loop uses the shared in-process open seam (no institutional seat page).
 * Direct `ak-role navigator` remains the public one-shot path.
 */
import { sitianReport } from "./sitian-facade.ts";
import {
  NAVIGATOR_PREPARE_TOOL_NAME,
  NavigatorUnavailableError,
  navigatorModelSettingPath,
  navigatorProviderFailureFromDiagnostics,
  navigatorProviderFailureFromError,
  navigatorProviderFailureFromStatus,
  navigatorUnavailableError,
  parseNavigatorModelSetting,
  resolveNavigatorSeatSelection,
  type NavigatorProviderFailureFact,
  type NavigatorSessionFactory,
} from "./navigator-session-contracts.ts";
import { recordTypedProviderHttpStatus } from "./typed-provider-http.ts";
import type { Usage } from "@earendil-works/pi-ai";

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function exactRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runChildCleanup(
  cleanups: ReadonlyArray<() => void | Promise<void>>,
  primaryFailure: unknown,
  label: string,
): Promise<void> {
  let cleanupFailure: unknown;
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (failure) {
      cleanupFailure = cleanupFailure === undefined
        ? failure
        : new AggregateError([cleanupFailure, failure], `${label} cleanup failed`, {
          cause: cleanupFailure,
        });
    }
  }
  if (cleanupFailure === undefined) return;
  if (primaryFailure !== undefined) {
    throw new AggregateError(
      [primaryFailure, cleanupFailure],
      `${label} execution and cleanup failed`,
      { cause: primaryFailure },
    );
  }
  throw new AggregateError([cleanupFailure], `${label} cleanup failed`, {
    cause: cleanupFailure,
  });
}

export function createNativeNavigatorSessionFactory(
  defaultModelSettingPath = navigatorModelSettingPath(),
): NavigatorSessionFactory {
  return async ({ context, subject, modelSettingPath, tool }) => {
    const resolved = await resolveNavigatorSeatSelection(context, modelSettingPath, defaultModelSettingPath);
    let selection = resolved.selection;
    let thinkingLevel = resolved.thinkingLevel;
    let configuredLabel = resolved.configuredLabel;

    const { createRecordSession } = await import("./archivist-record-entry.ts");
    const sessionManager = createRecordSession({
      cwd: context.cwd,
      kind: "navigator",
      subject,
      parent: context.sessionManager,
    });

    let providerFailure: NavigatorProviderFailureFact | undefined;
    let observationWrite: Promise<void> = Promise.resolve();
    const assignProviderFailure = (fact: NavigatorProviderFailureFact | undefined): void => {
      if (fact !== undefined) providerFailure = fact;
    };
    const classifyTerminalMessage = (message: unknown): void => {
      if (!exactRecord(message)) {
        assignProviderFailure(navigatorProviderFailureFromError(message));
        return;
      }
      assignProviderFailure(navigatorProviderFailureFromDiagnostics(message.diagnostics));
      if (providerFailure !== undefined) return;
      if (message.role !== "assistant") assignProviderFailure(navigatorProviderFailureFromError(message));
      if (providerFailure !== undefined) return;
      const status = typeof message.statusCode === "number"
        ? message.statusCode
        : typeof message.status === "number"
          ? message.status
          : typeof message.httpStatus === "number"
            ? message.httpStatus
            : undefined;
      if (typeof status === "number") {
        assignProviderFailure(navigatorProviderFailureFromStatus(status));
        if (providerFailure === undefined && status >= 400 && status < 600) {
          assignProviderFailure({ source: "transport", cause: "transport" });
        }
        const runDir = process.env.AK_ROLE_RUN_DIR;
        const provider = typeof message.provider === "string" && message.provider.trim() !== ""
          ? message.provider
          : selection.provider;
        if (typeof runDir === "string" && runDir.trim() !== "" && provider.trim() !== "") {
          observationWrite = observationWrite.then(() =>
            recordTypedProviderHttpStatus(runDir, { httpStatus: status, provider }),
          );
        }
      }
    };

    // Same in-process open seam public roles use (#675): default coding tools + prepare
    // terminating tool. No noTools:"all" / prepare-only allowlist fork.
    const { openPiInProcessSession } = await import("./pi/in-process-session.ts");
    let opened: Awaited<ReturnType<typeof openPiInProcessSession>>;
    try {
      opened = await openPiInProcessSession({
        cwd: context.cwd,
        selection,
        systemPrompt:
          `You are Navigator attendance on this parent run. Submit direction via the ${NAVIGATOR_PREPARE_TOOL_NAME} tool in one call. Do not call other tools before that submission.`,
        toolsAllowlist: ["read", "bash", "edit", "write", NAVIGATOR_PREPARE_TOOL_NAME],
        customTools: [tool],
        sessionManager,
        label: "Navigator",
      });
    } catch (error) {
      const fact = navigatorProviderFailureFromError(error);
      throw navigatorUnavailableError(fact?.source ?? "session", error, fact?.cause ?? "session");
    }

    const unsubscribe = opened.handle.subscribe((event) => {
      if (event.type === "message_end" && event.message !== undefined) {
        const message = event.message;
        if (exactRecord(message) && (message.stopReason === "error" || message.stopReason === "aborted")) {
          classifyTerminalMessage(message);
        }
      }
    });

    let disposal: Promise<void> | undefined;
    const dispose = (): Promise<void> => {
      if (disposal === undefined) {
        disposal = runChildCleanup(
          [() => unsubscribe(), () => opened.handle.close()],
          undefined,
          "Navigator",
        );
      }
      return disposal;
    };

    return {
      prompt: async (text) => {
        providerFailure = undefined;
        observationWrite = Promise.resolve();
        const failFrom = (error: unknown): never => {
          if (providerFailure === undefined) {
            assignProviderFailure({ source: "transport", cause: "transport" });
          }
          const fact = providerFailure!;
          throw navigatorUnavailableError(fact.source, error, fact.cause);
        };
        let terminal: unknown;
        try {
          const turn = await opened.handle.prompt(text);
          if (turn.stopReason === "error" || turn.stopReason === "aborted") {
            const cause = turn.errorMessage ?? opened.streamFailure ?? "Navigator provider failure";
            if (providerFailure === undefined && opened.streamFailure !== undefined) {
              classifyTerminalMessage(opened.streamFailure);
            }
            if (providerFailure === undefined) {
              assignProviderFailure(navigatorProviderFailureFromError(
                typeof cause === "object" && cause !== null ? cause : new Error(String(cause)),
              ));
            }
            terminal = cause;
          } else if (opened.streamFailure !== undefined) {
            if (providerFailure === undefined) classifyTerminalMessage(opened.streamFailure);
            terminal = opened.streamFailure;
          }
        } catch (error) {
          if (error instanceof NavigatorUnavailableError) throw error;
          if (providerFailure === undefined) classifyTerminalMessage(error);
          terminal = error;
        }
        await observationWrite;
        if (terminal !== undefined) failFrom(terminal);
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
            source: "evidence-child-executor",
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
        if (nextParsed.thinkingLevel !== nextThinking || thinkingLevel !== nextThinking) {
          throw new NavigatorUnavailableError(
            "thinking",
            `Navigator thinking level ${nextThinking ?? "(none)"} is unavailable for ${next}`,
          );
        }
        selection = {
          provider: nextParsed.provider,
          model: nextParsed.model,
          ...(nextParsed.thinkingLevel === undefined
            ? {}
            : { thinking: nextParsed.thinkingLevel }),
        };
        thinkingLevel = nextParsed.thinkingLevel;
        configuredLabel = next;
      },
      getThinkingLevel: () => thinkingLevel,
      recordPointer: () => sessionManager.getSessionDir(),
      dispose,
    };
  };
}
