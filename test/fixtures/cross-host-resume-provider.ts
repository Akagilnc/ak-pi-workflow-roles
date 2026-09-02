/**
 * Offline faux provider for #617 Pi→Grok→Pi public-CLI roundtrip.
 * Birth leg: one non-terminating bash toolCall/toolResult, then typed 429.
 * Settle leg: judge_output converged only after birth-paired tools + Grok user turn
 * are visible in restored session history (never settle/gatekeeper self-records).
 */
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Api,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  GATEKEEPER_OUTPUT_TOOL,
  JUDGE_OUTPUT_TOOL_NAME,
  NAVIGATOR_PREPARE_TOOL_NAME,
  NOTARY_OUTPUT_TOOL,
} from "../../src/role-runtime.ts";
import { SOUL_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";
import { seedAgentDirModelsJsonFromFaux } from "../helpers/pi-test-harness.ts";

export const CROSS_HOST_BASH_CALL_ID = "call_cross_host_bash";
export const CROSS_HOST_BASH_MARKER = "cross-host-history-anchor";
/** Opaque resume message Grok alone appends to JSONL before ACP (settle must not re-send). */
export const CROSS_HOST_GROK_USER_MARKER = "cross-host-grok-user-turn";

function leg(): string {
  return process.env.AK_CROSS_HOST_LEG ?? "";
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (typeof part !== "object" || part === null) continue;
    const record = part as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
  }
  return parts.join("");
}

function hasBirthBashToolCall(context: Context): boolean {
  return context.messages.some((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
    return message.content.some((part) => {
      if (typeof part !== "object" || part === null) return false;
      const record = part as { type?: unknown; id?: unknown; name?: unknown };
      return record.type === "toolCall"
        && record.id === CROSS_HOST_BASH_CALL_ID
        && record.name === "bash";
    });
  });
}

function hasBirthBashToolResult(context: Context): boolean {
  return context.messages.some(
    (message) =>
      message.role === "toolResult"
      && message.toolName === "bash"
      && message.toolCallId === CROSS_HOST_BASH_CALL_ID,
  );
}

function hasGrokAppendedUserTurn(context: Context): boolean {
  // Grok production path appends this user turn to the same JSONL before ACP.
  // Settle resume must not pass the marker, so only a restored Grok append satisfies it.
  return context.messages.some(
    (message) =>
      message.role === "user"
      && messageText(message.content).includes(CROSS_HOST_GROK_USER_MARKER),
  );
}

/** Restored cross-host history: birth-paired bash + Grok-only user turn. */
function hasRestoredCrossHostHistory(context: Context): boolean {
  return hasBirthBashToolCall(context)
    && hasBirthBashToolResult(context)
    && hasGrokAppendedUserTurn(context);
}

export default async function crossHostResumeProvider(pi: ExtensionAPI): Promise<void> {
  const faux = fauxProvider({
    api: "openai-completions",
    provider: "openai-codex",
    tokenSize: { min: 1000, max: 1000 },
  });
  const seeded = await seedAgentDirModelsJsonFromFaux(faux, process.env.PI_CODING_AGENT_DIR, {
    providerId: "openai-codex",
  });
  pi.on("session_shutdown", () => {
    void seeded.close();
  });

  let bashIssued = false;
  const response = async (context: Context) => {
    const names = context.tools?.map((tool) => tool.name) ?? [];
    if (names.includes(GATEKEEPER_OUTPUT_TOOL)) {
      return fauxAssistantMessage(
        fauxToolCall(GATEKEEPER_OUTPUT_TOOL, { status: "dispatch", officer: "notary" }),
        { stopReason: "toolUse" },
      );
    }
    if (names.includes(NOTARY_OUTPUT_TOOL)) {
      return fauxAssistantMessage(
        fauxToolCall(NOTARY_OUTPUT_TOOL, { status: "pass", findings: [] }),
        { stopReason: "toolUse" },
      );
    }
    if (names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) {
      return fauxAssistantMessage(
        fauxToolCall(NAVIGATOR_PREPARE_TOOL_NAME, {
          candidates: [{
            id: "cross-host-route",
            matches: { role: "judge", phase: null, kind: "accepted" },
            route: [{ role: "judge", phase: null }],
            next: { role: "judge", phase: null },
            reason: "cross-host resume fixture navigator",
            command: "Usage: pi --ak-role judge --help",
          }],
        }),
        { stopReason: "toolUse" },
      );
    }
    if (names.includes(SOUL_AUDIT_TOOL_NAME)) {
      return fauxAssistantMessage(
        fauxToolCall(SOUL_AUDIT_TOOL_NAME, {
          status: "pass",
          violations: [],
          conflicts: [],
          decisionGate: null,
        }),
        { stopReason: "toolUse" },
      );
    }
    // Birth only: anchor tool pair. Settle must never re-issue the same id/name bash.
    if (leg() === "birth" && !bashIssued) {
      bashIssued = true;
      return fauxAssistantMessage(
        fauxToolCall(
          "bash",
          { command: `printf '%s\\n' '${CROSS_HOST_BASH_MARKER}'` },
          { id: CROSS_HOST_BASH_CALL_ID },
        ),
        { stopReason: "toolUse" },
      );
    }
    if (names.includes(JUDGE_OUTPUT_TOOL_NAME) && leg() === "settle") {
      if (!hasRestoredCrossHostHistory(context)) {
        return fauxAssistantMessage("cross-host settle refused: session history not restored");
      }
      return fauxAssistantMessage(
        fauxToolCall(
          JUDGE_OUTPUT_TOOL_NAME,
          { judgeStatus: "converged", note: "cross-host settled" },
          { id: "call_cross_host_settle" },
        ),
        { stopReason: "toolUse" },
      );
    }
    return fauxAssistantMessage("cross-host fixture idle");
  };
  faux.setResponses(Array.from({ length: 16 }, () => response));

  const model = faux.getModel();
  const providerConfig = {
    name: "Offline cross-host resume fixture",
    baseUrl: "http://127.0.0.1:9999",
    apiKey: "offline",
    api: "openai-completions" as const,
    models: [
      {
        id: model.id,
        name: model.name,
        reasoning: false,
        input: ["text", "image"] as Array<"image" | "text">,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
    ],
    streamSimple(
      requestModel: Model<Api>,
      streamContext: Context,
      options?: SimpleStreamOptions,
    ) {
      // After bash history lands, birth leg stops via typed 429 so the run stays resumable.
      if (leg() === "birth" && hasBirthBashToolResult(streamContext)) {
        const stream = createAssistantMessageEventStream();
        const human = fauxAssistantMessage([], {
          stopReason: "error",
          errorMessage: "Rate limit reached (429)",
        });
        queueMicrotask(() => {
          void (async () => {
            await options?.onResponse?.({ status: 429, headers: {} }, requestModel);
            stream.push({ type: "error", reason: "error", error: human });
            stream.end(human);
          })();
        });
        return stream;
      }
      return faux.provider.streamSimple(
        requestModel as never,
        streamContext as never,
        options as never,
      );
    },
  };

  pi.registerProvider("openai-codex", providerConfig);
}
