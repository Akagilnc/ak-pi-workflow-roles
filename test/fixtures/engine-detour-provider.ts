/**
 * #357 T2 — scripted session LLM for engine detour acceptance.
 * Mock only at LLM I/O: calls package detour tool twice in one activation when registered,
 * then existing typed Judge submission. Zero production hooks.
 */
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  ENGINE_DETOUR_TOOL_NAME,
  JUDGE_OUTPUT_TOOL_NAME,
  NAVIGATOR_PREPARE_TOOL_NAME,
  NOTARY_OUTPUT_TOOL,
} from "../../src/role-runtime.ts";
import { GATEKEEPER_OUTPUT_TOOL_NAME as GATEKEEPER_OUTPUT_TOOL } from "../../src/package-contracts/gatekeeper-output.ts";
import { SOUL_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";

/** Fake engine body that exits 0 yet signals an upstream failure (#541 code0 gap). */
export const CODE0_ERROR_BODY = "upstream-engine-failure-541";
/** The infra diagnostic the model declares when it recognizes the engine failure. */
export const CODE0_INFRA_DIAGNOSTIC = `劳务引擎以 code 0 携带错误体退出：${CODE0_ERROR_BODY}`;

export default function fixture(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    api: "ak-engine-detour",
    provider: "ak-engine-detour",
    tokenSize: { min: 1000, max: 1000 },
  });
  let detourCount = 0;
  const response = async (context: Context) => {
    const names = context.tools?.map((tool) => tool.name) ?? [];
    // Scripted Gatekeeper → Notary pass before auditor (officer choice is fixture, not oracle).
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
            id: "engine-detour-route",
            matches: { role: "judge", phase: null, kind: "accepted" },
            route: [{ role: "judge", phase: null }],
            next: { role: "judge", phase: null },
            reason: "engine detour fixture navigator",
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
    // #541: a code0 + non-empty error body returns as a successful detour result
    // (detour predicate treats code0+nonempty as success); the model must
    // recognize the engine failure and declare infra via the Judge output tool
    // before any business receipt.
    if (names.includes(ENGINE_DETOUR_TOOL_NAME)) {
      const lastDetour = [...context.messages]
        .reverse()
        .find((message) => message.role === "toolResult" && message.toolName === ENGINE_DETOUR_TOOL_NAME) as
        | { content?: unknown }
        | undefined;
      const detourText = Array.isArray(lastDetour?.content)
        ? lastDetour.content.map((part) => (part.type === "text" ? part.text : "")).join("")
        : typeof lastDetour?.content === "string" ? lastDetour.content : "";
      if (detourText.includes(CODE0_ERROR_BODY)) {
        return fauxAssistantMessage(
          fauxToolCall(
            JUDGE_OUTPUT_TOOL_NAME,
            { infrastructureFailure: { diagnostic: CODE0_INFRA_DIAGNOSTIC } },
            { id: "engine-detour-infra-out" },
          ),
          { stopReason: "toolUse" },
        );
      }
    }
    // Prefer the detour tool when registered (Judge+engine activation).
    if (names.includes(ENGINE_DETOUR_TOOL_NAME) && detourCount < 2) {
      detourCount += 1;
      const index = detourCount;
      return fauxAssistantMessage(
        fauxToolCall(
          ENGINE_DETOUR_TOOL_NAME,
          {
            // argv first element resolves via PATH (test injects fake `kimi`).
            argv: ["kimi", "--call", index === 1 ? "first" : "second"],
          },
          { id: `engine-detour-${index}` },
        ),
        { stopReason: "toolUse" },
      );
    }
    if (names.includes(JUDGE_OUTPUT_TOOL_NAME)) {
      return fauxAssistantMessage(
        fauxToolCall(
          JUDGE_OUTPUT_TOOL_NAME,
          { judgeStatus: "converged" },
          { id: "engine-detour-judge-out" },
        ),
        { stopReason: "toolUse" },
      );
    }
    return fauxAssistantMessage("engine detour fixture idle");
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
  ]);
  const model = faux.getModel();
  const provider: Provider = {
    ...faux.provider,
    auth: {
      apiKey: {
        name: "offline engine detour",
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
