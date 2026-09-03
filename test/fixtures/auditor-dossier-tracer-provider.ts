import { appendFileSync } from "node:fs";

import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Context, type Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  NOTARY_OUTPUT_TOOL,
} from "../../src/role-runtime.ts";
import { GATEKEEPER_OUTPUT_TOOL_NAME as GATEKEEPER_OUTPUT_TOOL } from "../../src/package-contracts/gatekeeper-output.ts";
import { seedAgentDirModelsJsonFromFaux } from "../helpers/pi-test-harness.ts";

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

export default async function auditorDossierTracerProvider(pi: ExtensionAPI): Promise<void> {
  const faux = fauxProvider({ provider: "ak-dossier-tracer", api: "openai-responses", tokenSize: { min: 1000, max: 1000 } });
  // Child-local institutional auth reads PI_CODING_AGENT_DIR/models.json (#518 S3).
  const seeded = await seedAgentDirModelsJsonFromFaux(faux, process.env.PI_CODING_AGENT_DIR);
  pi.on("session_shutdown", () => {
    void seeded.close();
  });
  const marker = process.env.AK_DOSSIER_TRACER_MARKER;
  const tracePath = process.env.AK_DOSSIER_TRACER_TRACE;
  if (!marker || !tracePath) throw new Error("AK_DOSSIER_TRACER_MARKER and AK_DOSSIER_TRACER_TRACE are required");
  const trace = (event: object) => appendFileSync(tracePath, `${JSON.stringify(event)}\n`);

  const response = (context: Context) => {
    const names = context.tools?.map((tool) => tool.name) ?? [];
    // Scripted Gatekeeper → Notary pass before auditor dossier work.
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
      // Child-local HTTP path strips toolResult.details; dossier tool also puts
      // the same location object in content text (JSON). Prefer details, fall back.
      const pathsFromDetails = located.details as
        | { admittedRequest?: string; parentSessionCandidate?: string; attachments?: string }
        | undefined;
      let paths = pathsFromDetails;
      if (paths?.admittedRequest === undefined) {
        const text = (Array.isArray(located.content) ? located.content : [])
          .map((part: { type?: string; text?: string }) => (part?.type === "text" ? part.text ?? "" : ""))
          .join("");
        try {
          paths = JSON.parse(text) as typeof paths;
        } catch {
          throw new Error(`dossier tool result missing location details/content: ${text.slice(0, 200)}`);
        }
      }
      if (paths?.admittedRequest === undefined || paths.parentSessionCandidate === undefined || paths.attachments === undefined) {
        throw new Error("dossier tool result missing required location paths");
      }
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
  // +2 slots for scripted Gatekeeper dispatch + officer pass ahead of auditor dossier turns.
  faux.setResponses(Array.from({ length: 14 }, () => response));
  const model = faux.getModel();
  pi.registerProvider({
    ...faux.provider,
    auth: { apiKey: { name: "offline tracer", async resolve() { return { auth: { apiKey: "offline" } }; } } },
    getModels() { return [model]; },
  } as Provider);
}
