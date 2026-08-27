/**
 * #378 — scripted session LLM for Reviewer leg engine detour acceptance.
 * Mock only at LLM I/O: when legs expose the package detour tool, call it once
 * per axis, then emit the existing axis report text from detour stdout.
 * Parent still submits typed ak_reviewer_output. Zero production hooks.
 */
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { REVIEWER_AXIS_OUTPUT_ADAPTER } from "../../src/reviewer-construction.ts";
import {
  ENGINE_DETOUR_TOOL_NAME,
  REVIEWER_OUTPUT_TOOL_NAME,
} from "../../src/role-runtime.ts";

const CANNED_LABOR = "canned-reviewer-engine-labor-378";

function axisFromPrompt(text: string): "standards" | "spec" | undefined {
  const prefix = `Axis-Output-Adapter: ${REVIEWER_AXIS_OUTPUT_ADAPTER.adapterId}@${REVIEWER_AXIS_OUTPUT_ADAPTER.version}`;
  if (text.includes(`${prefix}:standards`)) return "standards";
  if (text.includes(`${prefix}:spec`)) return "spec";
  return undefined;
}

function userText(context: Context): string {
  const message = [...context.messages].reverse().find((item) => item.role === "user");
  if (!message || message.role !== "user") return "";
  return typeof message.content === "string"
    ? message.content
    : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function toolNames(context: Context): string[] {
  return context.tools?.map((tool) => tool.name) ?? [];
}

function lastDetourStdout(context: Context): string | undefined {
  for (let i = context.messages.length - 1; i >= 0; i -= 1) {
    const message = context.messages[i]!;
    if (message.role !== "toolResult") continue;
    const toolName = (message as { toolName?: string }).toolName;
    if (toolName !== ENGINE_DETOUR_TOOL_NAME) continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return String(content ?? "");
    return content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
  }
  return undefined;
}

function detourAlreadyCalled(context: Context): boolean {
  return context.messages.some(
    (message) =>
      message.role === "toolResult" &&
      (message as { toolName?: string }).toolName === ENGINE_DETOUR_TOOL_NAME,
  );
}

export default function reviewerEngineDetourProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    api: "ak-reviewer-engine-detour",
    provider: "ak-reviewer-engine-detour",
    tokenSize: { min: 1000, max: 1000 },
  });
  const axisSeen = new Set<string>();
  const response = (context: Context) => {
    const names = toolNames(context);
    const prompt = userText(context);
    const axis = axisFromPrompt(prompt);

    // Evidence-child labor path: detour when registered, then axis report text.
    if (axis !== undefined) {
      if (names.includes(ENGINE_DETOUR_TOOL_NAME) && !detourAlreadyCalled(context)) {
        return fauxAssistantMessage(
          fauxToolCall(
            ENGINE_DETOUR_TOOL_NAME,
            { argv: ["kimi", "--fixture-reviewer-detour", axis] },
            { id: `engine-detour-${axis}` },
          ),
          { stopReason: "toolUse" },
        );
      }
      axisSeen.add(axis);
      const labor = lastDetourStdout(context) ?? "";
      if (names.includes(ENGINE_DETOUR_TOOL_NAME) && !labor.includes(CANNED_LABOR)) {
        throw new Error(
          `evidence child ${axis} missing canned engine labor in detour stdout: ${labor}`,
        );
      }
      return fauxAssistantMessage(
        axis === "standards"
          ? `Standards finding count: 0. engine-labor=${labor.trim() || "none"}`
          : `Spec: fixed target satisfies the stated behavior. engine-labor=${labor.trim() || "none"}`,
      );
    }

    if (names.includes(REVIEWER_OUTPUT_TOOL_NAME)) {
      // #378: both fixed axes must complete engine labor before typed parent output.
      if (!axisSeen.has("standards") || !axisSeen.has("spec")) {
        throw new Error(
          `parent output before both evidence-child axes; seen=${[...axisSeen].join(",") || "none"}`,
        );
      }
      return fauxAssistantMessage(
        fauxToolCall(
          REVIEWER_OUTPUT_TOOL_NAME,
          { status: "completed" },
          { id: "output" },
        ),
        { stopReason: "toolUse" },
      );
    }

    return fauxAssistantMessage("reviewer engine detour fixture idle");
  };

  faux.setResponses([
    response,
    response,
    response,
    response,
    response,
    response,
    response,
    response,
    response,
    response,
    response,
    response,
  ]);
  const model = faux.getModel();
  const provider: Provider = {
    ...faux.provider,
    auth: {
      apiKey: {
        name: "offline reviewer engine detour",
        async resolve() {
          return { auth: { apiKey: "offline" } };
        },
      },
    },
    getModels() {
      return [model];
    },
  };
  pi.registerProvider(provider);
}
