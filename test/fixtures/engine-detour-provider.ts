/**
 * #357 T2 — scripted session LLM for engine detour acceptance.
 * Mock only at LLM I/O: calls package detour tool once when registered,
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
  GATEKEEPER_OUTPUT_TOOL,
  JUDGE_OUTPUT_TOOL_NAME,
  NAVIGATOR_PREPARE_TOOL_NAME,
  NOTARY_OUTPUT_TOOL,
} from "../../src/role-runtime.ts";
import { SOUL_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";

export default function fixture(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    api: "ak-engine-detour",
    provider: "ak-engine-detour",
    tokenSize: { min: 1000, max: 1000 },
  });
  let detourIssued = false;
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
    // Prefer the detour tool when registered (Judge+engine activation).
    if (names.includes(ENGINE_DETOUR_TOOL_NAME) && !detourIssued) {
      detourIssued = true;
      return fauxAssistantMessage(
        fauxToolCall(
          ENGINE_DETOUR_TOOL_NAME,
          {
            // argv first element resolves via PATH (test injects fake `kimi`).
            argv: ["kimi", "--fixture-detour"],
          },
          { id: "engine-detour-1" },
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
