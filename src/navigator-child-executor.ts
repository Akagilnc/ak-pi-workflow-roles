/**
 * Shared Navigator institutional-child lifecycle seam (#590 / ADR 0018).
 * Owns scratch sessionManager, openPiInstitutionalSession, subscribe/close.
 * Imports only session contracts (no lifecycle) — never the attendance consumer.
 */
import { createRecordSession } from "./archivist-record-entry.ts";
import { auditorRunDirectory } from "./auditor-dossier-tool.ts";
import type { HostContext, HostInstitutionalModelSelection } from "./host-contracts.ts";
import {
  InstitutionalResolutionError,
  readInstitutionalSeatSelection,
} from "./institutional-resolution.ts";
import {
  NAVIGATOR_PREPARE_TOOL_NAME,
  NavigatorUnavailableError,
  navigatorModelSettingPath,
  navigatorProviderFailureFromDiagnostics,
  navigatorProviderFailureFromError,
  navigatorProviderFailureFromStatus,
  navigatorUnavailableError,
  parseNavigatorModelSetting,
  readNavigatorModelSetting,
  type NavigatorProviderFailureFact,
  type NavigatorSessionFactory,
} from "./navigator-session-contracts.ts";
import { sitianReport } from "./sitian-facade.ts";

function exactRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Prefer institutional-resolution navigator seat; fall back to model file only when
 * the page is missing or lacks the seat (typed reasons). Corrupted pages fail loud.
 */
export async function resolveNavigatorSeatSelection(
  context: HostContext,
  modelSettingPath: string | undefined,
  defaultModelSettingPath: string,
): Promise<{ selection: HostInstitutionalModelSelection; configuredLabel: string; thinkingLevel: "off" | "max" }> {
  const runDirectory = auditorRunDirectory(context);
  if (runDirectory !== undefined) {
    try {
      const selection = await readInstitutionalSeatSelection(runDirectory, "navigator");
      const thinkingLevel = selection.thinking === "max" ? "max" : "off";
      return {
        selection: {
          provider: selection.provider,
          model: selection.model,
          ...(selection.thinking === undefined ? {} : { thinking: selection.thinking }),
        },
        configuredLabel: `${selection.provider}/${selection.model}${thinkingLevel === "max" ? ":max" : ""}`,
        thinkingLevel,
      };
    } catch (error) {
      if (
        error instanceof InstitutionalResolutionError
        && (error.reason === "missing-page" || error.reason === "missing-seat")
      ) {
        // documented bare-seam fallback
      } else {
        throw error instanceof NavigatorUnavailableError
          ? error
          : navigatorUnavailableError("model", error);
      }
    }
  }
  let configured: string;
  try {
    configured = await readNavigatorModelSetting(modelSettingPath ?? defaultModelSettingPath);
  } catch (error) {
    throw navigatorUnavailableError("model", error);
  }
  let parsed: ReturnType<typeof parseNavigatorModelSetting>;
  try {
    parsed = parseNavigatorModelSetting(configured);
  } catch (error) {
    throw navigatorUnavailableError("model", error);
  }
  return {
    selection: {
      provider: parsed.provider,
      model: parsed.model,
      thinking: parsed.thinkingLevel,
    },
    configuredLabel: configured,
    thinkingLevel: parsed.thinkingLevel,
  };
}

/**
 * Host-neutral navigator session factory: institutional child via openPiInstitutionalSession.
 */
export function createNativeNavigatorSessionFactory(
  defaultModelSettingPath = navigatorModelSettingPath(),
): NavigatorSessionFactory {
  return async ({ context, subject, modelSettingPath, tool }) => {
    const resolved = await resolveNavigatorSeatSelection(context, modelSettingPath, defaultModelSettingPath);
    let selection = resolved.selection;
    let thinkingLevel = resolved.thinkingLevel;
    let configuredLabel = resolved.configuredLabel;

    const sessionManager = createRecordSession({
      cwd: context.cwd,
      kind: "navigator",
      subject,
      parent: context.sessionManager,
    });

    let providerFailure: NavigatorProviderFailureFact | undefined;
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
      }
    };

    const { openPiInstitutionalSession } = await import("./pi/in-process-session.ts");
    let opened: Awaited<ReturnType<typeof openPiInstitutionalSession>>;
    try {
      opened = await openPiInstitutionalSession({
        cwd: context.cwd,
        selection,
        systemPrompt: "",
        noTools: "all",
        toolsAllowlist: [NAVIGATOR_PREPARE_TOOL_NAME],
        customTools: [tool],
        sessionManager,
        label: "Navigator",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/authentication failed/i.test(message)) throw navigatorUnavailableError("auth", error);
      if (/provider not found|model/i.test(message)) throw navigatorUnavailableError("model", error);
      throw navigatorUnavailableError("session", error);
    }

    const unsubscribe = opened.handle.subscribe((event) => {
      if (event.type === "message_end" && event.message !== undefined) {
        const message = event.message;
        if (exactRecord(message) && (message.stopReason === "error" || message.stopReason === "aborted")) {
          classifyTerminalMessage(message);
        }
      }
    });

    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      void opened.handle.close();
    };

    return {
      prompt: async (text) => {
        providerFailure = undefined;
        const failFrom = (error: unknown): never => {
          if (providerFailure === undefined) {
            assignProviderFailure({ source: "transport", cause: "transport" });
          }
          const fact = providerFailure!;
          throw navigatorUnavailableError(fact.source, error, fact.cause);
        };
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
            failFrom(cause);
          }
          if (opened.streamFailure !== undefined) {
            if (providerFailure === undefined) classifyTerminalMessage(opened.streamFailure);
            failFrom(opened.streamFailure);
          }
        } catch (error) {
          if (error instanceof NavigatorUnavailableError) throw error;
          if (providerFailure === undefined) classifyTerminalMessage(error);
          failFrom(error);
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
            source: "navigator-child-executor",
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
            `Navigator thinking level ${nextThinking} is unavailable for ${next}`,
          );
        }
        selection = {
          provider: nextParsed.provider,
          model: nextParsed.model,
          thinking: nextParsed.thinkingLevel,
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
