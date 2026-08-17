/**
 * #380 — Reviewer leg engine detour soft-fail → seat labor → typed parent receipt.
 * Mock only at LLM I/O. After detour returns (success or soft-fail), emit axis report.
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
import { REVIEWER_AUDIT_TOOL_NAME } from "../../src/reviewer-auditor.ts";

const SEAT_LABOR = "seat-labor-after-engine-fallback-380";

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

function detourAlreadyCalled(context: Context): boolean {
  return context.messages.some(
    (message) =>
      message.role === "toolResult" &&
      (message as { toolName?: string }).toolName === ENGINE_DETOUR_TOOL_NAME,
  );
}

export default function reviewerEngineFallbackProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    api: "ak-reviewer-engine-fallback",
    provider: "ak-reviewer-engine-fallback",
    tokenSize: { min: 1000, max: 1000 },
  });
  const axisSeen = new Set<string>();
  const response = (context: Context) => {
    const names = toolNames(context);
    const prompt = userText(context);
    const axis = axisFromPrompt(prompt);

    if (axis !== undefined) {
      if (names.includes(ENGINE_DETOUR_TOOL_NAME) && !detourAlreadyCalled(context)) {
        return fauxAssistantMessage(
          fauxToolCall(
            ENGINE_DETOUR_TOOL_NAME,
            { argv: ["kimi", "--fixture-reviewer-fallback", axis] },
            { id: `engine-detour-fallback-${axis}` },
          ),
          { stopReason: "toolUse" },
        );
      }
      axisSeen.add(axis);
      // Seat main road after soft detour failure (#380).
      return fauxAssistantMessage(
        axis === "standards"
          ? `Standards finding count: 0. ${SEAT_LABOR}`
          : `Spec: fixed target satisfies the stated behavior. ${SEAT_LABOR}`,
      );
    }

    if (names.includes(REVIEWER_AUDIT_TOOL_NAME)) {
      return fauxAssistantMessage(
        fauxToolCall(
          REVIEWER_AUDIT_TOOL_NAME,
          { status: "pass", violations: [], conflicts: [], decisionGate: null },
          { id: "audit" },
        ),
        { stopReason: "toolUse" },
      );
    }

    if (names.includes(REVIEWER_OUTPUT_TOOL_NAME)) {
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

    return fauxAssistantMessage("reviewer engine fallback fixture idle");
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
        name: "offline reviewer engine fallback",
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
