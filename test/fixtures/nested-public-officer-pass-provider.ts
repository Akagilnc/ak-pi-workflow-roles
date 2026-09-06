/**
 * #675 offline nested public officer/auditor provider.
 * Optional nested Pi extension for offline officer/auditor scripted I/O.
 * Load only via explicit PublicSummonRequest.extraPiArgs (same face as public
 * CLI seat extraPiArgs). Not a production env protocol.

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
  INSPECTOR_OUTPUT_TOOL,
  NOTARY_OUTPUT_TOOL,
} from "../../src/role-runtime.ts";
import { AUDITOR_OUTPUT_TOOL_NAME } from "../../src/package-contracts/auditor-output.ts";
import { SOUL_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";
import { seedAgentDirModelsJsonFromFaux } from "../helpers/pi-test-harness.ts";

export default async function nestedPublicOfficerPassProvider(
  pi: ExtensionAPI,
): Promise<void> {
  const faux = fauxProvider({
    api: "ak-nested-officer-pass",
    provider: "ak-nested-officer-pass",
    tokenSize: { min: 1000, max: 1000 },
  });
  const seeded = await seedAgentDirModelsJsonFromFaux(faux, process.env.PI_CODING_AGENT_DIR);
  pi.on("session_shutdown", async () => {
    await seeded.close();
  });

  const respond = (context: Context) => {
    const names = context.tools?.map((tool) => tool.name) ?? [];
    if (names.includes(NOTARY_OUTPUT_TOOL)) {
      return fauxAssistantMessage(
        fauxToolCall(NOTARY_OUTPUT_TOOL, { status: "pass", findings: [] }),
        { stopReason: "toolUse" },
      );
    }
    if (names.includes(INSPECTOR_OUTPUT_TOOL)) {
      return fauxAssistantMessage(
        fauxToolCall(INSPECTOR_OUTPUT_TOOL, { status: "pass", findings: [] }),
        { stopReason: "toolUse" },
      );
    }
    const auditTool = names.includes(AUDITOR_OUTPUT_TOOL_NAME)
      ? AUDITOR_OUTPUT_TOOL_NAME
      : names.includes(SOUL_AUDIT_TOOL_NAME)
        ? SOUL_AUDIT_TOOL_NAME
        : undefined;
    if (auditTool !== undefined) {
      const mode = process.env.AK_NESTED_AUDIT_MODE ?? "pass";
      if (mode === "throw") {
        throw new Error("provider quota exhausted");
      }
      if (mode === "escalate") {
        return fauxAssistantMessage(
          fauxToolCall(auditTool, {
            status: "escalate",
            conflicts: ["Soul authority conflicts with controlling authority"],
            decisionGate: {
              question: "Which authority governs this verdict?",
              options: ["Soul", "Controlling authority"],
            },
          }),
          { stopReason: "toolUse" },
        );
      }
      if (mode === "mystery") {
        return fauxAssistantMessage(
          fauxToolCall(auditTool, {
            status: "mystery",
            retained: "raw auditor candidate",
          }),
          { stopReason: "toolUse" },
        );
      }
      if (mode === "malformed-prose") {
        return fauxAssistantMessage("MALFORMED AUDITOR OUTPUT");
      }
      return fauxAssistantMessage(
        fauxToolCall(auditTool, {
          status: "pass",
          violations: [],
          conflicts: [],
          decisionGate: null,
        }),
        { stopReason: "toolUse" },
      );
    }
    return fauxAssistantMessage("nested public officer pass fixture idle");
  };

  faux.setResponses(Array.from({ length: 12 }, () => respond));
  const model = faux.getModel();
  const provider: Provider = {
    ...faux.provider,
    auth: {
      apiKey: {
        name: "offline nested officer pass",
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
