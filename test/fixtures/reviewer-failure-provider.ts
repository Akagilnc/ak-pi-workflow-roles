import { execFileSync } from "node:child_process";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { AGENT_TOOL_NAME, REVIEWER_OUTPUT_TOOL_NAME } from "../../src/role-runtime.ts";

type FailureStage =
  | "child-preparation"
  | "child-provider"
  | "child-session"
  | "child-malformed-output"
  | "audit-auth"
  | "audit-provider"
  | "audit-malformed-decision";

export default function reviewerFailureProvider(pi: ExtensionAPI): void {
  const stage = process.env["AK_REVIEWER_FAILURE_STAGE"] as FailureStage;
  const faux = fauxProvider({
    api: "ak-reviewer-failure",
    provider: "ak-reviewer-failure",
    tokenSize: { min: 1000, max: 1000 },
  });
  const request = {
    tools: [],
    bashCommands: [],
    prerequisiteOperations: [
      "preflight.git.resolve-base", "preflight.git.derive-range",
      "preflight.git.list-ordered-commits", "preflight.git.read-material",
      "runner.git.materialize-mirror", "runner.git.materialize-workspace",
      "runner.git.verify-snapshot",
    ],
  };
  const agentCall = fauxAssistantMessage(
    fauxToolCall(AGENT_TOOL_NAME, {
      version: 1,
      base: { revision: execFileSync("git", ["rev-parse", "HEAD~1"], { encoding: "utf8" }).trim() },
      standardsMaterials: [{ id: "readme", repositoryPath: "README.md" }],
      spec: { state: "not-established", evidence: [{ id: "task", repositoryPath: "test/fixtures/reviewer-task.md" }] },
      required: { standards: request },
    }, { id: "fatal-agent" }),
    { stopReason: "toolUse" },
  );
  const outputCall = fauxAssistantMessage(
    fauxToolCall(REVIEWER_OUTPUT_TOOL_NAME, {
      status: "refused",
      report: "The requested review cannot proceed because its runtime stage failed.",
    }, { id: "fatal-reviewer-output" }),
    { stopReason: "toolUse" },
  );
  let providerCalls = 0;
  const first = () => {
    providerCalls += 1;
    return stage.startsWith("child-") ? agentCall : outputCall;
  };
  const second = () => {
    if (stage === "child-session") {
      providerCalls += 1;
      console.error("INJECTED_REVIEWER_CHILD_SESSION_FAILURE");
      return fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "INJECTED_REVIEWER_CHILD_SESSION_FAILURE",
      });
    }
    if (stage === "child-malformed-output") {
      providerCalls += 1;
      console.error("Reviewer Agent returned a blank child report");
      return fauxAssistantMessage("   ");
    }
    if (stage === "audit-malformed-decision") {
      providerCalls += 1;
      console.error("invalid reviewer audit decision");
      return fauxAssistantMessage("MALFORMED_REVIEWER_AUDIT_DECISION_STAGE");
    }
    return fauxAssistantMessage("FORBIDDEN LATER SUCCESS PROSE");
  };
  faux.setResponses([
    first,
    second,
    fauxAssistantMessage("FORBIDDEN LATER SUCCESS PROSE"),
    fauxAssistantMessage(
      fauxToolCall(REVIEWER_OUTPUT_TOOL_NAME, {
        status: "refused",
        report: "FORBIDDEN INFRASTRUCTURE REFUSAL",
      }),
      { stopReason: "toolUse" },
    ),
  ]);
  const model = faux.getModel();
  const provider: Provider = {
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Offline Reviewer staged failure",
        async resolve() { return { auth: { apiKey: "offline" } }; },
      },
    },
    getModels() { return [model]; },
  };
  pi.registerProvider(provider);
  pi.on("tool_call", (event, ctx) => {
    if (stage === "child-provider" && event.toolName === AGENT_TOOL_NAME) {
      (ctx.modelRegistry as any).getProvider = () => {
        console.error("Reviewer Agent provider not found");
        return undefined;
      };
    }
    if (
      stage === "audit-provider" &&
      event.toolName === REVIEWER_OUTPUT_TOOL_NAME
    ) {
      (ctx.modelRegistry as any).getProvider = () => {
        console.error("Reviewer compliance audit provider not found");
        return undefined;
      };
    }
    if (stage === "audit-auth" && event.toolName === REVIEWER_OUTPUT_TOOL_NAME) {
      (ctx.modelRegistry as any).getProviderAuth = async () => {
        console.error("INJECTED_REVIEWER_AUDIT_AUTH_FAILURE");
        throw new Error("INJECTED_REVIEWER_AUDIT_AUTH_FAILURE");
      };
    }
  });
  pi.on("session_shutdown", () => {
    console.error(`REVIEWER_FAILURE_PROVIDER_CALLS=${providerCalls}`);
  });
}
