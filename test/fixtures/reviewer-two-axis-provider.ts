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
import { EVIDENCE_CHILD_OUTPUT_TOOL_NAME } from "../../src/package-contracts/evidence-child-output.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "../../src/role-runtime.ts";
import { seedAgentDirModelsJsonFromFaux } from "../helpers/pi-test-harness.ts";

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
export default async function reviewerTwoAxisProvider(pi: ExtensionAPI): Promise<void> {
  const faux = fauxProvider({
    api: "ak-reviewer-two-axis",
    provider: "ak-reviewer-two-axis",
    tokenSize: { min: 1000, max: 1000 },
  });
  // Evidence-child auth is child-local via models.json (#518 S3).
  const seeded = await seedAgentDirModelsJsonFromFaux(faux, process.env.PI_CODING_AGENT_DIR);
  pi.on("session_shutdown", () => {
    void seeded.close();
  });
  const expectedAxes = expectedAxesFromEnv();
  // #675: evidence-child is a nested public process — dispatch by tools, not a shared
  // in-process axisSeen queue (parent and children no longer share one faux instance).
  const respond = (context: Context) => {
    const names = context.tools?.map((tool) => tool.name) ?? [];
    const prompt = userText(context);
    const axis = axisFromPrompt(prompt);

    if (axis !== undefined) {
      if (!expectedAxes.has(axis)) {
        throw new Error(`launched unexpected axis ${axis}; expected ${[...expectedAxes].join(",")}`);
      }
      assertAuthorityRefsCarrier(axis, prompt);
      const report =
        axis === "standards"
          ? "Standards finding count: 0."
          : "Spec: fixed target satisfies the stated behavior.";
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
    }

    return fauxAssistantMessage("reviewer two-axis fixture idle");
  };
  faux.setResponses([
    respond,
    respond,
    respond,
    respond,
    respond,
    respond,
    respond,
    respond,
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
