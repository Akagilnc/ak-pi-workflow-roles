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

export default function auditFailureProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    api: "ak-audit-failure",
    provider: "ak-audit-failure",
    tokenSize: { min: 1000, max: 1000 },
  });
  const healthyNavigator = process.env.AK_HEALTHY_NAVIGATOR === "1";
  const siblingOrder = process.env.AK_NAVIGATOR_SIBLING_ORDER ?? "none";
  let roleTurns = 0;
  let navigatorCalls = 0;
  let navigatorStartedAt = "";
  let navigatorCompletedAt = "";
  const response = async (context: Context) => {
    const names = context.tools?.map((tool) => tool.name) ?? [];
    if (healthyNavigator && names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) {
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
    if (names.includes(JUDGE_OUTPUT_TOOL_NAME)) {
      roleTurns += 1;
      if (healthyNavigator && siblingOrder === "sibling-first" && roleTurns === 1) {
        return fauxAssistantMessage(fauxToolCall("read", { path: "README.md" }, { id: "navigator-sibling" }), { stopReason: "toolUse" });
      }
      return fauxAssistantMessage(fauxToolCall(JUDGE_OUTPUT_TOOL_NAME, { judgeStatus: "converged" }, { id: "fatal-judge" }), { stopReason: "toolUse" });
    }
    if (healthyNavigator) return fauxAssistantMessage("MALFORMED AUDITOR OUTPUT");
    return fauxAssistantMessage("FORBIDDEN LATER SUCCESS PROSE");
  };
  faux.setResponses(healthyNavigator ? [response, response, response, response, response] : [
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
  pi.on("session_shutdown", async () => {
    console.error(`AUDIT_FAILURE_PROVIDER_CALLS=${faux.state.callCount}`);
    if (!healthyNavigator) return;
    const root = process.env.AK_NAVIGATOR_ROOT;
    const directory = root === undefined ? undefined : join(root, "runs", "navigator");
    const files = directory === undefined ? [] : (await readdir(directory)).filter((file) => file.endsWith(".jsonl")).sort();
    const persisted = files.length === 0 || directory === undefined
      ? []
      : (await readFile(join(directory, files.at(-1)!), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as any);
    const prepared = [...persisted].reverse().find((entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.toolName === NAVIGATOR_PREPARE_TOOL_NAME);
    const settlement = [...persisted].reverse().find((entry) => entry.type === "custom" && entry.customType === "ak-navigator-settlement");
    console.error(`NAVIGATOR_CALLS=${navigatorCalls}`);
    console.error(`NAVIGATOR_SIBLING_ORDER=${siblingOrder}`);
    console.error(`NAVIGATOR_PREPARED_AT=${prepared?.timestamp ?? ""}`);
    console.error(`NAVIGATOR_STARTED_AT=${navigatorStartedAt}`);
    console.error(`NAVIGATOR_COMPLETED_AT=${navigatorCompletedAt}`);
    console.error(`NAVIGATOR_SETTLEMENT_AT=${settlement?.timestamp ?? ""}`);
    console.error(`NAVIGATOR_SETTLEMENT_KIND=${settlement?.data?.kind ?? ""}`);
  });
}
