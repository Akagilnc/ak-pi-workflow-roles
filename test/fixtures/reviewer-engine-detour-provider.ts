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
import { EVIDENCE_CHILD_OUTPUT_TOOL_NAME } from "../../src/package-contracts/evidence-child-output.ts";
import {
  ENGINE_DETOUR_TOOL_NAME,
  REVIEWER_OUTPUT_TOOL_NAME,
} from "../../src/role-runtime.ts";
import { seedAgentDirModelsJsonFromFaux } from "../helpers/pi-test-harness.ts";

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

export default async function reviewerEngineDetourProvider(pi: ExtensionAPI): Promise<void> {
  const faux = fauxProvider({
    api: "ak-reviewer-engine-detour",
    provider: "ak-reviewer-engine-detour",
    tokenSize: { min: 1000, max: 1000 },
  });
  const seeded = await seedAgentDirModelsJsonFromFaux(faux, process.env.PI_CODING_AGENT_DIR);
  pi.on("session_shutdown", async () => {
    await seeded.close();
  });
  const response = (context: Context) => {
    const names = toolNames(context);
    const prompt = userText(context);
    const axis = axisFromPrompt(prompt);

    // Evidence-child labor path (own public process under #675): detour then report.
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
      const labor = lastDetourStdout(context) ?? "";
      // Failure-path engines omit canned labor; still emit a report so the parent
      // receives the engine-process cause through the detour failure channel.
      if (
        names.includes(ENGINE_DETOUR_TOOL_NAME)
        && labor.includes(CANNED_LABOR) === false
        && labor.trim() !== ""
      ) {
        throw new Error(
          `evidence child ${axis} missing canned engine labor in detour stdout: ${labor}`,
        );
      }
      if (names.includes(ENGINE_DETOUR_TOOL_NAME) && !labor.includes(CANNED_LABOR) && labor.trim() === "") {
        // Detour tool should have failed closed before a second model turn; if we
        // reach here with empty labor, keep the axis honest rather than inventing success.
        throw new Error(`evidence child ${axis} detour produced empty labor`);
      }
      const report =
        axis === "standards"
          ? `Standards finding count: 0. engine-labor=${labor.trim() || "none"}`
          : `Spec: fixed target satisfies the stated behavior. engine-labor=${labor.trim() || "none"}`;
      if (names.includes(EVIDENCE_CHILD_OUTPUT_TOOL_NAME)) {
        return fauxAssistantMessage(
          fauxToolCall(
            EVIDENCE_CHILD_OUTPUT_TOOL_NAME,
            { report },
            { id: `evidence-child-${axis}` },
          ),
          { stopReason: "toolUse" },
        );
      }
      return fauxAssistantMessage(report);
    }

    if (names.includes(REVIEWER_OUTPUT_TOOL_NAME)) {
      // #675: axes run in nested public evidence-child processes; parent fixture
      // cannot observe their in-memory turns. Detour labor is asserted from child
      // session files by the acceptance test.
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
