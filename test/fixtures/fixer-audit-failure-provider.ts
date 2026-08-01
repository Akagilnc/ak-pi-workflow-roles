import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FIXER_OUTPUT_TOOL_NAME } from "../../src/role-runtime.ts";

export default function fixture(pi: ExtensionAPI): void {
  const faux = fauxProvider({ api: "ak-fixer-audit-failure", provider: "ak-fixer-audit-failure", tokenSize: { min: 1000, max: 1000 } });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(FIXER_OUTPUT_TOOL_NAME, { status: "completed", report: "done", classResults: [{ name: "Contract", disposition: "completed", searchScope: "all", exceptions: [], commitSha: "a".repeat(40) }] }, { id: "fixer-output" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("MALFORMED FIXER AUDIT OUTPUT"),
    fauxAssistantMessage("FORBIDDEN LATER SUCCESS PROSE"),
  ]);
  const model = faux.getModel();
  const provider: Provider = { ...faux.provider, auth: { apiKey: { name: "offline", async resolve() { return { auth: { apiKey: "offline" } }; } } }, getModels() { return [model]; } };
  pi.registerProvider(provider);
  pi.on("session_shutdown", () => console.error(`FIXER_AUDIT_FAILURE_PROVIDER_CALLS=${faux.state.callCount}`));
}
