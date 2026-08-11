import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { REVIEWER_OUTPUT_TOOL_NAME } from "../../src/role-runtime.ts";
import { REVIEWER_AUDIT_TOOL_NAME } from "../../src/reviewer-auditor.ts";

function userText(context: Context): string {
  const message = context.messages.find((item) => item.role === "user");
  if (!message || message.role !== "user") return "";
  return typeof message.content === "string"
    ? message.content
    : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

/** Offline provider for public ak-role Reviewer fixed two-axis + auditor chain. */
export default function reviewerTwoAxisProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    api: "ak-reviewer-two-axis",
    provider: "ak-reviewer-two-axis",
    tokenSize: { min: 1000, max: 1000 },
  });
  const axisSeen = new Set<string>();
  faux.setResponses([
    (context) => {
      const text = userText(context);
      const axis = text.includes("Axis-Output-Adapter: reviewer-axis-output@1:standards")
        ? "standards"
        : text.includes("Axis-Output-Adapter: reviewer-axis-output@1:spec")
          ? "spec"
          : undefined;
      if (axis === undefined) throw new Error("child prompt missing typed axis adapter");
      axisSeen.add(axis);
      return fauxAssistantMessage(
        axis === "standards"
          ? "Standards finding count: 0."
          : "Spec: fixed target satisfies the stated behavior.",
      );
    },
    (context) => {
      const text = userText(context);
      const axis = text.includes("Axis-Output-Adapter: reviewer-axis-output@1:standards")
        ? "standards"
        : text.includes("Axis-Output-Adapter: reviewer-axis-output@1:spec")
          ? "spec"
          : undefined;
      if (axis === undefined) throw new Error("second child prompt missing typed axis adapter");
      axisSeen.add(axis);
      return fauxAssistantMessage(
        axis === "standards"
          ? "Standards finding count: 0."
          : "Spec: fixed target satisfies the stated behavior.",
      );
    },
    () => {
      if (axisSeen.size !== 2 || !axisSeen.has("standards") || !axisSeen.has("spec")) {
        throw new Error(`expected both axes before output; saw ${[...axisSeen].join(",")}`);
      }
      return fauxAssistantMessage(
        fauxToolCall(REVIEWER_OUTPUT_TOOL_NAME, { status: "completed" }, { id: "output" }),
        { stopReason: "toolUse" },
      );
    },
    () =>
      fauxAssistantMessage(
        fauxToolCall(
          REVIEWER_AUDIT_TOOL_NAME,
          { status: "pass", violations: [], conflicts: [], decisionGate: null },
          { id: "audit" },
        ),
        { stopReason: "toolUse" },
      ),
  ]);
  const model = faux.getModel();
  const provider: Provider = {
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Offline Reviewer two-axis",
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
