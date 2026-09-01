/**
 * Shared Navigator institutional-child lifecycle seam (#590 / ADR 0018).
 * Owns scratch sessionManager, openPiInstitutionalSession, subscribe/close.
 * Navigator attendance module only consumes NavigatorPreparationSession handles.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

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
  type NavigatorPreparationSession,
  type NavigatorProviderFailureFact,
  type NavigatorSessionFactory,
} from "./navigator-attendance.ts";
import { sitianReport } from "./sitian-facade.ts";

function exactRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve navigator seat selection without ambient parent host context (#590).
 * Prefer the run's institutional-resolution page; fall back to navigator-model.json
 * for bare/developer seams that never wrote a page.
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
      // Only documented bare-seam fallback: missing page or missing navigator seat.
      // Corrupted/invalid pages keep their cause (失败诚实宪法).
      if (
        error instanceof InstitutionalResolutionError
        && (error.reason === "missing-page" || error.reason === "missing-seat")
      ) {
        // fall through to persistent model setting
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
 * Host-neutral navigator session factory (#590 / #233 pattern).
 * Self-held institutional child session via openPiInstitutionalSession; seat from
 * institutional-resolution (or navigator-model.json fallback). Does not consume
 * parent ExtensionContext.modelRegistry.
 */
export function createNativeNavigatorSessionFactory(defaultModelSettingPath = navigatorModelSettingPath()): NavigatorSessionFactory {
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
        // Institutional HTTP path: non-auth/quota 4xx/5xx remains transport (diagnostics may be stripped).
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
        // Soul/routebook ride the prepare prompt; system materials stay empty here.
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
          // Prefer terminal-message classification (holds statusCode/diagnostics).
          // streamFailure is a secondary cause carrier and must not wipe a typed fact.
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
            source: "navigator-attendance",
          });
        } catch {
          // best-effort persistence in attendance adapter
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
        // Institutional handle has no live setModel; same-selection validate only.
        // Model switches require a fresh attendance session (prepare recreates).
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

