import { appendFileSync } from "node:fs";

import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Context, type Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DOSSIER = "ak_get_run_dossier";
const JUDGE = "ak_judge_output";
const AUDIT = "ak_soul_audit_decision";
const NAVIGATOR = "ak_navigator_prepare";

function toolResults(context: Context): Array<any> {
  return context.messages.filter((message) => message.role === "toolResult") as Array<any>;
}

function resultText(context: Context): string {
  return JSON.stringify(toolResults(context).map((message) => ({ content: message.content, details: message.details })));
}

export default function auditorDossierTracerProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({ provider: "ak-dossier-tracer", api: "openai-responses", tokenSize: { min: 1000, max: 1000 } });
  const marker = process.env.AK_DOSSIER_TRACER_MARKER;
  const tracePath = process.env.AK_DOSSIER_TRACER_TRACE;
  if (!marker || !tracePath) throw new Error("AK_DOSSIER_TRACER_MARKER and AK_DOSSIER_TRACER_TRACE are required");
  const trace = (event: object) => appendFileSync(tracePath, `${JSON.stringify(event)}\n`);

  const response = (context: Context) => {
    const names = context.tools?.map((tool) => tool.name) ?? [];
    if (names.includes(NAVIGATOR)) {
      return fauxAssistantMessage(fauxToolCall(NAVIGATOR, { candidates: [{ next: { role: "reviewer", phase: null }, reason: "tracer route" }] }), { stopReason: "toolUse" });
    }
    if (names.includes(AUDIT)) {
      const results = toolResults(context);
      const located = [...results].reverse().find((message) => message.toolName === DOSSIER);
      if (!located) {
        trace({ tool: DOSSIER });
        return fauxAssistantMessage(fauxToolCall(DOSSIER, {}), { stopReason: "toolUse" });
      }
      const paths = located.details as { admittedRequest: string; parentSessionCandidate: string; attachments: string };
      const reads = results.filter((message) => message.toolName === "read");
      if (reads.length === 0) { trace({ tool: "read", path: paths.admittedRequest }); return fauxAssistantMessage(fauxToolCall("read", { path: paths.admittedRequest }), { stopReason: "toolUse" }); }
      if (reads.length === 1) { trace({ tool: "read", path: paths.parentSessionCandidate }); return fauxAssistantMessage(fauxToolCall("read", { path: paths.parentSessionCandidate }), { stopReason: "toolUse" }); }
      if (reads.length === 2) {
        const admitted = (reads[0]!.content as Array<{ type?: string; text?: string }>)
          .map((part) => part.text ?? "").join("\n");
        const frozenPath = admitted.match(/"frozenPath"\s*:\s*"([^"]+)"/)?.[1];
        if (!frozenPath || !frozenPath.startsWith(`${paths.attachments}/`)) {
          throw new Error("admitted request did not identify an attachment under the located directory");
        }
        trace({ tool: "read", path: frozenPath });
        return fauxAssistantMessage(fauxToolCall("read", { path: frozenPath }), { stopReason: "toolUse" });
      }
      const observed = resultText(context);
      if (!observed.includes(marker)) throw new Error(`auditor did not read its marker ${marker}`);
      return fauxAssistantMessage(fauxToolCall(AUDIT, { status: "pass", violations: [], conflicts: [], decisionGate: null }), { stopReason: "toolUse" });
    }
    if (names.includes(JUDGE)) {
      return fauxAssistantMessage(fauxToolCall(JUDGE, { judgeStatus: "converged" }), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage("unexpected tracer request");
  };
  faux.setResponses(Array.from({ length: 12 }, () => response));
  const model = faux.getModel();
  pi.registerProvider({
    ...faux.provider,
    auth: { apiKey: { name: "offline tracer", async resolve() { return { auth: { apiKey: "offline" } }; } } },
    getModels() { return [model]; },
  } as Provider);
}
