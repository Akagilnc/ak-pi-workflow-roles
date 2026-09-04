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
/** Canned success stdout the scripted fake engine returns per detour call (dual-call tracer, #536). */
export const DETOUR_STDOUT_ECHOES = [
  "canned-engine-stdout-1\n",
  "canned-engine-stdout-2\n",
] as const;

/** Text the model sees in a detour toolResult (string or parts, as the context projects it). */
function detourResultText(message: { content?: unknown } | undefined): string {
  return Array.isArray(message?.content)
    ? message.content.map((part: any) => (part.type === "text" ? part.text : "")).join("")
    : typeof message?.content === "string" ? message.content : "";
}

/**
 * Sole authority for the scripted dual-detour dispatch (#536): issue the next
 * call while every detour so far returned the canned success stdout this fixture
 * scripts and fewer than two ran; after an engine failure keep calling without
 * a business receipt so the envelope settles the pending infrastructure failure
 * as typed failure. Returns the next toolCall arguments, or undefined to stand down.
 */
export function nextDetourCall(context: {
  tools?: Array<{ name?: string }> | null;
  messages?: Array<any> | null;
}): { argv: string[]; id: string } | undefined {
  const names = context.tools?.map((tool) => tool.name) ?? [];
  if (!names.includes(ENGINE_DETOUR_TOOL_NAME)) return undefined;
  const msgs = context.messages ?? [];
  const priorDetourResults = msgs.filter(
    (message: any) =>
      message?.role === "toolResult" &&
      message?.toolName === ENGINE_DETOUR_TOOL_NAME,
  );
  const allDetoursSucceeded = priorDetourResults.every(
    (message: any) =>
      (DETOUR_STDOUT_ECHOES as readonly string[]).includes(detourResultText(message)),
  );
  const keepCalling = allDetoursSucceeded ? priorDetourResults.length < 2 : true;
  if (!keepCalling) return undefined;
  const index = priorDetourResults.length + 1;
  return {
    // argv first element resolves via PATH (tests inject fake `kimi`).
    argv: ["kimi", "--call", index === 1 ? "first" : "second"],
    id: `engine-detour-${index}`,
  };
}

export default function fixture(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    api: "ak-engine-detour",
    provider: "ak-engine-detour",
    tokenSize: { min: 1000, max: 1000 },
  });
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
      if (detourResultText(lastDetour).includes(CODE0_ERROR_BODY)) {
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
    // Prefer the detour tool when registered (Judge+engine activation); dispatch
    // shape is owned by nextDetourCall (#536).
    const detourCall = nextDetourCall(context);
    if (detourCall !== undefined) {
      return fauxAssistantMessage(
        fauxToolCall(ENGINE_DETOUR_TOOL_NAME, { argv: detourCall.argv }, { id: detourCall.id }),
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
