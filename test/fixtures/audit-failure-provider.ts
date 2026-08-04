import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { JUDGE_OUTPUT_TOOL_NAME, NAVIGATOR_PREPARE_TOOL_NAME } from "../../src/role-runtime.ts";
import { SOUL_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";

export default function auditFailureProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    api: "ak-audit-failure",
    provider: "ak-audit-failure",
    tokenSize: { min: 1000, max: 1000 },
  });
  const observation = process.env.AK_NAVIGATOR_OBSERVATION === "1";
  /** Canonical delivery matrix: recommendation | unavailable | silence (extends observation seam). */
  const deliveryOutcome = process.env.AK_NAVIGATOR_DELIVERY_OUTCOME;
  const deliveryMode = deliveryOutcome === "recommendation" || deliveryOutcome === "unavailable" || deliveryOutcome === "silence"
    ? deliveryOutcome
    : undefined;
  const healthyNavigator =
    process.env.AK_HEALTHY_NAVIGATOR === "1"
    || observation
    || deliveryMode === "recommendation"
    || deliveryMode === "silence";
  const roleScripted = observation || deliveryMode !== undefined;
  let navigatorCalls = 0;
  let navigatorStartedAt = "";
  let navigatorCompletedAt = "";
  let inputReleasedAt = "";
  const response = async (context: Context) => {
    const names = context.tools?.map((tool) => tool.name) ?? [];
    if (names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) {
      if (deliveryMode === "unavailable") {
        navigatorCalls += 1;
        navigatorStartedAt = new Date().toISOString();
        // Malformed prepare forces typed unavailable; role receipt still converges.
        navigatorCompletedAt = new Date().toISOString();
        return fauxAssistantMessage("NAVIGATOR PREPARE MALFORMED");
      }
      if (healthyNavigator) {
        navigatorCalls += 1;
        navigatorStartedAt = new Date().toISOString();
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        navigatorCompletedAt = new Date().toISOString();
        return fauxAssistantMessage(fauxToolCall(NAVIGATOR_PREPARE_TOOL_NAME, {
          candidates: [{
            id: "audit-failure-route",
            matches: { role: "judge", phase: null, kind: "accepted" },
            route: [{ role: "judge", phase: null }, { role: "reviewer", phase: null }],
            next: { role: "reviewer", phase: null },
            reason: "healthy in-flight Navigator preparation",
            command: "Usage: pi --ak-role reviewer --help",
          }],
        }), { stopReason: "toolUse" });
      }
    }
    if (names.includes(SOUL_AUDIT_TOOL_NAME)) {
      if (process.env.AK_AUDIT_TIMEOUT_FAILURE === "1") {
        return fauxAssistantMessage("AUDIT PROVIDER TIMEOUT", {
          stopReason: "error",
          errorMessage: "provider timeout: compliance request expired",
        });
      }
      if (deliveryMode === "silence") {
        return fauxAssistantMessage(fauxToolCall(SOUL_AUDIT_TOOL_NAME, {
          status: "escalate",
          violations: [],
          conflicts: ["Soul authority conflicts with controlling authority"],
          decisionGate: {
            question: "Which authority governs this verdict?",
            options: ["Soul", "Controlling authority"],
          },
        }), { stopReason: "toolUse" });
      }
      if (roleScripted) return fauxAssistantMessage(fauxToolCall(SOUL_AUDIT_TOOL_NAME, { status: "pass", violations: [], conflicts: [], decisionGate: null }), { stopReason: "toolUse" });
      return fauxAssistantMessage("MALFORMED AUDITOR OUTPUT");
    }
    if (names.includes(JUDGE_OUTPUT_TOOL_NAME)) {
      if (deliveryMode === "silence") {
        return fauxAssistantMessage(fauxToolCall(JUDGE_OUTPUT_TOOL_NAME, { judgeStatus: "converged" }, { id: "silence-judge" }), { stopReason: "toolUse" });
      }
      if (roleScripted) return fauxAssistantMessage(fauxToolCall(JUDGE_OUTPUT_TOOL_NAME, { judgeStatus: "converged" }, { id: "observed-judge" }), { stopReason: "toolUse" });
      return fauxAssistantMessage(fauxToolCall(JUDGE_OUTPUT_TOOL_NAME, { judgeStatus: "converged" }, { id: "fatal-judge" }), { stopReason: "toolUse" });
    }
    if (healthyNavigator || deliveryMode === "unavailable") return fauxAssistantMessage("MALFORMED AUDITOR OUTPUT");
    return fauxAssistantMessage("FORBIDDEN LATER SUCCESS PROSE");
  };
  faux.setResponses(healthyNavigator || deliveryMode === "unavailable" ? [response, response, response, response, response] : [
    fauxAssistantMessage(
      fauxToolCall(
        JUDGE_OUTPUT_TOOL_NAME,
        { judgeStatus: "converged" },
        { id: "fatal-judge" },
      ),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("MALFORMED AUDITOR OUTPUT"),
    fauxAssistantMessage("FORBIDDEN LATER SUCCESS PROSE"),
  ]);

  const model = faux.getModel();
  const provider: Provider = {
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Offline audit failure fixture",
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
  pi.on("agent_end", () => {
    inputReleasedAt = new Date().toISOString();
  });
  process.on("exit", () => {
    if (healthyNavigator && !observation) console.error(`AUDIT_FAILURE_PROCESS_RELEASE=${JSON.stringify({ at: new Date().toISOString() })}`);
  });
  pi.on("session_shutdown", async () => {
    console.error(`AUDIT_FAILURE_PROVIDER_CALLS=${faux.state.callCount}`);
    if (!healthyNavigator || observation) return;
    const root = process.env.AK_NAVIGATOR_ROOT;
    const directory = root === undefined ? undefined : join(root, "runs", "navigator");
    const files = directory === undefined ? [] : (await readdir(directory)).filter((file) => file.endsWith(".jsonl")).sort();
    const persisted = files.length === 0 || directory === undefined
      ? []
      : (await readFile(join(directory, files.at(-1)!), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as any);
    const roleDirectory = root === undefined ? undefined : join(root, "runs", "judge", "session");
    const roleFiles = roleDirectory === undefined ? [] : (await readdir(roleDirectory)).filter((file) => file.endsWith(".jsonl")).sort();
    const rolePersisted = roleFiles.length === 0 || roleDirectory === undefined
      ? []
      : (await readFile(join(roleDirectory, roleFiles.at(-1)!), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as any);
    const prepared = [...persisted].reverse().find((entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.toolName === NAVIGATOR_PREPARE_TOOL_NAME);
    const settlement = [...persisted].reverse().find((entry) => entry.type === "custom" && entry.customType === "ak-navigator-settlement");
    const roleResults = rolePersisted
      .filter((entry) => entry.type === "message" && entry.message?.role === "toolResult")
      .map((entry) => ({ toolCallId: entry.message.toolCallId, toolName: entry.message.toolName, isError: entry.message.isError === true, details: entry.message.details ?? {} }));
    const failedOutput = roleResults.find((entry) => entry.toolCallId === "fatal-judge");
    const failedOutputEntry = [...rolePersisted].find((entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.toolCallId === "fatal-judge");
    const drainedBeforeSettlement = navigatorCompletedAt !== "" && typeof settlement?.timestamp === "string" && Date.parse(navigatorCompletedAt) <= Date.parse(settlement.timestamp);
    console.error(`AUDIT_FAILURE_EVIDENCE=${JSON.stringify({
      providerCalls: faux.state.callCount,
      navigatorCalls,
      navigator: { startedAt: navigatorStartedAt, completedAt: navigatorCompletedAt, preparedAt: prepared?.timestamp ?? "", settledAt: settlement?.timestamp ?? "", settlementKind: settlement?.data?.kind ?? "", inputReleasedAt, releaseAfterDrain: drainedBeforeSettlement },
      role: { failedOutput, failedOutputAt: failedOutputEntry?.timestamp ?? "", failedOutputCorrelation: failedOutput?.toolCallId === "fatal-judge" && failedOutput?.toolName === JUDGE_OUTPUT_TOOL_NAME },
    })}`);
  });
}
