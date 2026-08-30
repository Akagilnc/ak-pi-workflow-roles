import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { INSPECTOR_OUTPUT_TOOL_NAME } from "../../src/inspector-contracts.ts";

export default function inspectorPublicProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    api: "ak-inspector-offline",
    provider: "ak-inspector-offline",
    tokenSize: { min: 1000, max: 1000 },
  });
  const status = process.env.AK_TEST_INSPECTOR_STATUS ?? "pass";
  const candidate = status === "malformed"
    ? { status: "unknown", findings: "unaltered" }
    : { status, findings: [`${status}-finding`] };
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall(INSPECTOR_OUTPUT_TOOL_NAME, candidate),
      { stopReason: "toolUse" },
    ),
  ]);
  const model = faux.getModel();
  const provider: Provider = {
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Offline Inspector public fixture",
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
