import { writeFileSync } from "node:fs";
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

function axisFromPrompt(text: string): "standards" | "spec" | undefined {
  // Identity from typed package constant — no hard-coded version contract in the fixture.
  const prefix = `Axis-Output-Adapter: ${REVIEWER_AXIS_OUTPUT_ADAPTER.adapterId}@${REVIEWER_AXIS_OUTPUT_ADAPTER.version}`;
  if (text.includes(`${prefix}:standards`)) return "standards";
  if (text.includes(`${prefix}:spec`)) return "spec";
  return undefined;
}

function authorityRefsFromPrompt(text: string): string[] | undefined {
  const marker = "权威引用：\n";
  const index = text.indexOf(marker);
  if (index < 0) return undefined;
  const rest = text.slice(index + marker.length);
  const line = rest.split("\n", 1)[0] ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(
      `权威引用 payload is not recognized JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed) || parsed.some((ref) => typeof ref !== "string")) {
    throw new Error("权威引用 payload is not a string array");
  }
  return parsed as string[];
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
      throw new Error("Standards child must not receive 权威引用 material");
    }
    return;
  }
  if (expected === undefined) {
    if (observed !== undefined) {
      throw new Error("Spec child received unexpected 权威引用 material");
    }
    return;
  }
  if (observed === undefined) {
    throw new Error("Spec child prompt missing 权威引用 material");
  }
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new Error(
      `Spec child 权威引用 mismatch: expected ${JSON.stringify(expected)} got ${JSON.stringify(observed)}`,
    );
  }
}

function expectedAxesFromEnv(): ReadonlySet<"standards" | "spec"> {
  const raw = process.env.AK_REVIEW_EXPECT_AXES;
  if (raw === undefined || raw.trim() === "") {
    return new Set(["standards", "spec"]);
  }
  const axes = raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  if (axes.some((axis) => axis !== "standards" && axis !== "spec")) {
    throw new Error("AK_REVIEW_EXPECT_AXES must be comma-separated standards/spec");
  }
  return new Set(axes as Array<"standards" | "spec">);
}

/** Stable seat-owned delta for the real package tracer (#437 / #495 S6 single accept). */
export const REVIEWER_AMENDMENT_TRACE = Object.freeze({ standards: "axis-delta" });
/** @deprecated alias kept for any residual import during S6 cutover */
export const REVIEWER_AMENDMENT_TRACE_A = REVIEWER_AMENDMENT_TRACE;
export const REVIEWER_AMENDMENT_TRACE_B = REVIEWER_AMENDMENT_TRACE;

/** Offline provider for public ak-role Reviewer fixed two-axis chain (no auditor after #495 S6). */
export default function reviewerTwoAxisProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    api: "ak-reviewer-two-axis",
    provider: "ak-reviewer-two-axis",
    tokenSize: { min: 1000, max: 1000 },
  });
  const expectedAxes = expectedAxesFromEnv();
  const axisSeen = new Set<string>();
  const childResponse = (context: Context, label: string) => {
    const prompt = userText(context);
    const axis = axisFromPrompt(prompt);
    if (axis === undefined) throw new Error(`${label} has no recognized typed axis adapter`);
    if (!expectedAxes.has(axis)) {
      throw new Error(`${label} launched unexpected axis ${axis}; expected ${[...expectedAxes].join(",")}`);
    }
    assertAuthorityRefsCarrier(axis, prompt);
    axisSeen.add(axis);
    return fauxAssistantMessage(
      axis === "standards"
        ? "Standards finding count: 0."
        : "Spec: fixed target satisfies the stated behavior.",
    );
  };
  const responses: Array<(context: Context) => ReturnType<typeof fauxAssistantMessage>> = [];
  for (let i = 0; i < expectedAxes.size; i += 1) {
    const label = i === 0 ? "child prompt" : `child prompt #${i + 1}`;
    responses.push((context) => childResponse(context, label));
  }
  const parentOutput = (context: Context) => {
    for (const axis of expectedAxes) {
      if (!axisSeen.has(axis)) {
        throw new Error(`expected axes [${[...expectedAxes].join(",")}] before output; saw ${[...axisSeen].join(",")}`);
      }
    }
    if (axisSeen.size !== expectedAxes.size) {
      throw new Error(`expected axes [${[...expectedAxes].join(",")}] before output; saw ${[...axisSeen].join(",")}`);
    }
    // #443 optional capture: parent session systemPrompt at the real output call.
    const capturePath = process.env.AK_REVIEW_CAPTURE_SYSTEM_PROMPT;
    if (typeof capturePath === "string" && capturePath.trim() !== "") {
      writeFileSync(capturePath, context.systemPrompt ?? "", "utf8");
    }
    return fauxAssistantMessage(
      fauxToolCall(
        REVIEWER_OUTPUT_TOOL_NAME,
        { status: "completed", amendments: REVIEWER_AMENDMENT_TRACE },
        { id: "output" },
      ),
      { stopReason: "toolUse" },
    );
  };
  // #495 S6: no reviewer-side auditor — single typed accept after legs.
  responses.push((context) => parentOutput(context));
  faux.setResponses(responses);
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
