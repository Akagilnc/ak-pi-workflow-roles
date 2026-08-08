import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AGENT_TOOL_NAME, REVIEWER_OUTPUT_TOOL_NAME } from "../../src/role-runtime.ts";
import { REVIEWER_AUDIT_TOOL_NAME } from "../../src/reviewer-auditor.ts";

export default function reviewerProductionProvider(pi: ExtensionAPI): void {
  const runDirectory = process.env.AK_ROLE_RUN_DIR;
  if (typeof runDirectory !== "string") throw new Error("missing AK_ROLE_RUN_DIR");
  const request = JSON.parse(readFileSync(join(runDirectory, "admitted-request.json"), "utf8")) as {
    attachments: Array<{ frozenPath: string }>;
  };
  const sourcePath = request.attachments[0]?.frozenPath;
  if (typeof sourcePath !== "string") throw new Error("missing admitted attachment");
  const callsPath = process.env.AK_REVIEWER_PROVIDER_CALLS;
  let calls = 0;
  const count = () => {
    calls += 1;
    if (callsPath !== undefined) writeFileSync(callsPath, `${calls}\n`, "utf8");
  };
  const faux = fauxProvider({
    api: "ak-reviewer-production",
    provider: "ak-reviewer-production",
    tokenSize: { min: 1000, max: 1000 },
  });
  const allPrerequisites = [
    "preflight.git.pin-target", "preflight.git.resolve-base", "preflight.git.derive-range",
    "preflight.git.list-ordered-commits", "preflight.git.read-material",
    "runner.git.materialize-mirror", "runner.git.materialize-workspace", "runner.git.verify-snapshot",
  ];
  faux.setResponses([
    () => {
      count();
      return fauxAssistantMessage(
        fauxToolCall(AGENT_TOOL_NAME, {
          version: 1,
          base: { revision: "HEAD~1" },
          materials: [{
            id: "authority",
            repositoryPath: "AUTHORITY.md",
            source: "host-input",
            sourcePath,
          }],
          spec: { state: "not-established" },
          required: { standards: { tools: ["read"], prerequisiteOperations: allPrerequisites } },
        }, { id: "production-agent" }),
        { stopReason: "toolUse" },
      );
    },
    () => {
      count();
      return fauxAssistantMessage(
        fauxToolCall("read", {
          path: ".ak-reviewer/materials/selected/authority.md",
        }, { id: "production-read" }),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      count();
      const readResult = [...context.messages].reverse().find((message) => message.role === "toolResult" && message.toolName === "read");
      const consumed = readResult?.role === "toolResult" ? readResult.content.map((part) => part.type === "text" ? part.text : "").join("") : "";
      writeFileSync(join(runDirectory, "provider-consumed.txt"), consumed, "utf8");
      return fauxAssistantMessage("FROZEN_BYTES_CONSUMED");
    },
    () => {
      count();
      return fauxAssistantMessage(
        fauxToolCall(REVIEWER_OUTPUT_TOOL_NAME, { status: "completed" }, { id: "production-output" }),
        { stopReason: "toolUse" },
      );
    },
    () => {
      count();
      return fauxAssistantMessage(
        fauxToolCall(REVIEWER_AUDIT_TOOL_NAME, {
          status: "pass",
          violations: [],
          conflicts: [],
          decisionGate: null,
        }, { id: "production-audit" }),
        { stopReason: "toolUse" },
      );
    },
  ]);
  const model = faux.getModel();
  const provider: Provider = {
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Offline Reviewer production",
        async resolve() { return { auth: { apiKey: "offline" } }; },
      },
    },
    getModels() { return [model]; },
  };
  pi.registerProvider(provider);
}
