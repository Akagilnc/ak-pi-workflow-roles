/**
 * Offline faux provider for public Collector production-seam tracers.
 * Issues one ak_collector_observe so the real Collector runtime crosses GitHub.
 */
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { COLLECTOR_OBSERVE_TOOL, COLLECTOR_REQUEST_TOOL } from "../../src/collector-ledger.ts";
import { COLLECTOR_OUTPUT_TOOL } from "../../src/package-contracts/collector-output.ts";

export default function collectorObserveProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    api: "ak-collector-offline",
    provider: "ak-collector-offline",
    tokenSize: { min: 1000, max: 1000 },
  });
  const requestManifest = process.argv.includes("--ak-collector-request-manifest");
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall(COLLECTOR_OBSERVE_TOOL, {}, { id: "collector-obs-1" }),
      { stopReason: "toolUse" },
    ),
    ...(requestManifest ? [
      (context: any) => {
        const observed = [...context.messages].reverse().find((message: any) => message.role === "toolResult");
        return fauxAssistantMessage(
          fauxToolCall(COLLECTOR_REQUEST_TOOL, { requestId: "codex", snapshotId: observed.details.snapshotId }, { id: "collector-request-1" }),
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage(
        fauxToolCall(COLLECTOR_OBSERVE_TOOL, {}, { id: "collector-obs-2" }),
        { stopReason: "toolUse" },
      ),
    ] : []),
    fauxAssistantMessage(
      fauxToolCall(COLLECTOR_OUTPUT_TOOL, {}, { id: "collector-output" }),
      { stopReason: "toolUse" },
    ),
  ]);

  const model = faux.getModel();
  const provider: Provider = {
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Offline Collector observe fixture",
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
  pi.on("session_shutdown", () => {
    console.error(`COLLECTOR_OBSERVE_PROVIDER_CALLS=${faux.state.callCount}`);
  });
}
