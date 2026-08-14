import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { REVIEWER_AXIS_OUTPUT_ADAPTER } from "../../src/reviewer-construction.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "../../src/role-runtime.ts";
import { REVIEWER_AUDIT_TOOL_NAME } from "../../src/reviewer-auditor.ts";

function axisFromPrompt(text: string): "standards" | "spec" | undefined {
  // Identity from typed package constant — no hard-coded version contract in the fixture.
  const prefix = `Axis-Output-Adapter: ${REVIEWER_AXIS_OUTPUT_ADAPTER.adapterId}@${REVIEWER_AXIS_OUTPUT_ADAPTER.version}`;
  if (text.includes(`${prefix}:standards`)) return "standards";
  if (text.includes(`${prefix}:spec`)) return "spec";
  return undefined;
}

function authorityRefsFromPrompt(text: string): string[] | undefined {
  const marker = "Authority-Refs:\n";
  const index = text.indexOf(marker);
  if (index < 0) return undefined;
  const rest = text.slice(index + marker.length);
  const line = rest.split("\n", 1)[0] ?? "";
  try {
    const parsed: unknown = JSON.parse(line);
    if (!Array.isArray(parsed) || parsed.some((ref) => typeof ref !== "string")) {
      throw new Error("Authority-Refs payload is not a string array");
    }
    return parsed as string[];
  } catch (error) {
    throw new Error(
      `Authority-Refs payload is not recognized JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function userText(context: Context): string {
  const message = context.messages.find((item) => item.role === "user");
  if (!message || message.role !== "user") return "";
  return typeof message.content === "string"
    ? message.content
    : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function expectedAuthorityRefsFromEnv(): string[] | undefined {
  const raw = process.env.AK_REVIEW_EXPECT_AUTHORITY_REFS_JSON;
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((ref) => typeof ref !== "string")) {
    throw new Error("AK_REVIEW_EXPECT_AUTHORITY_REFS_JSON must be a JSON string array");
  }
  return parsed as string[];
}

function assertAuthorityRefsCarrier(axis: "standards" | "spec", prompt: string): void {
  const expected = expectedAuthorityRefsFromEnv();
  const observed = authorityRefsFromPrompt(prompt);
  if (axis === "standards") {
    if (observed !== undefined) {
      throw new Error("Standards child must not receive Authority-Refs material");
    }
    return;
  }
  if (expected === undefined) {
    if (observed !== undefined) {
      throw new Error("Spec child received unexpected Authority-Refs material");
    }
    return;
  }
  if (observed === undefined) {
    throw new Error("Spec child prompt missing Authority-Refs material");
  }
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new Error(
      `Spec child Authority-Refs mismatch: expected ${JSON.stringify(expected)} got ${JSON.stringify(observed)}`,
    );
  }
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
      const prompt = userText(context);
      const axis = axisFromPrompt(prompt);
      if (axis === undefined) throw new Error("child prompt has no recognized typed axis adapter");
      assertAuthorityRefsCarrier(axis, prompt);
      axisSeen.add(axis);
      return fauxAssistantMessage(
        axis === "standards"
          ? "Standards finding count: 0."
          : "Spec: fixed target satisfies the stated behavior.",
      );
    },
    (context) => {
      const prompt = userText(context);
      const axis = axisFromPrompt(prompt);
      if (axis === undefined) throw new Error("second child prompt has no recognized typed axis adapter");
      assertAuthorityRefsCarrier(axis, prompt);
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
