/**
 * Offline faux provider for public Collector role-bind path (#676 A).
 * Role decides ticket → ak_collector_bind_target → observe → output.
 * Simulates the LLM judgment; does not scrape task text in production code.
 */
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  COLLECTOR_BIND_TARGET_TOOL,
  COLLECTOR_OBSERVE_TOOL,
} from "../../src/collector-ledger.ts";
import { COLLECTOR_OUTPUT_TOOL } from "../../src/package-contracts/collector-output.ts";

export default function collectorBindObserveProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    api: "ak-collector-offline",
    provider: "ak-collector-offline",
    tokenSize: { min: 1000, max: 1000 },
  });
  // Fixture stands in for role judgment: bind issue 676 → unique PR, then observe.
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall(COLLECTOR_BIND_TARGET_TOOL, { issueNumber: 676 }, { id: "collector-bind-1" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall(COLLECTOR_OBSERVE_TOOL, {}, { id: "collector-obs-1" }),
      { stopReason: "toolUse" },
    ),
    (context: any) => {
      const observed = [...context.messages].reverse().find((message: any) =>
        message.role === "toolResult" && message.toolName === COLLECTOR_OBSERVE_TOOL && message.isError === false
      );
      const details = observed?.details;
      const evidence = Array.isArray(details?.evidence) ? details.evidence : [];
      const findings = evidence
        .filter((record: any) =>
          record &&
          typeof record.evidenceId === "string" &&
          (record.kind === "review" || record.kind === "issue_comment" || record.kind === "review_comment")
        )
        .map((record: any) => ({
          evidenceId: record.evidenceId,
          category: "collected",
          summary: "collected finding",
        }));
      return fauxAssistantMessage(
        fauxToolCall(COLLECTOR_OUTPUT_TOOL, findings.length > 0 ? { findings } : {}, { id: "collector-output" }),
        { stopReason: "toolUse" },
      );
    },
  ]);

  const model = faux.getModel();
  const provider: Provider = {
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Offline Collector bind+observe fixture",
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
