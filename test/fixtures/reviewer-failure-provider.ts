import { execFileSync } from "node:child_process";
import { renameSync } from "node:fs";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { AGENT_TOOL_NAME, REVIEWER_OUTPUT_TOOL_NAME } from "../../src/role-runtime.ts";

type FailureStage =
  | "preflight-git"
  | "preflight-skill"
  | "child-preparation"
  | "child-provider"
  | "child-session"
  | "child-malformed-output";

export default function reviewerFailureProvider(pi: ExtensionAPI): void {
  const stage = process.env["AK_REVIEWER_FAILURE_STAGE"] as FailureStage;
  const faux = fauxProvider({
    api: "ak-reviewer-failure",
    provider: "ak-reviewer-failure",
    tokenSize: { min: 1000, max: 1000 },
  });
  const base = execFileSync("git", ["rev-parse", "HEAD~1"], { encoding: "utf8" }).trim();
  const request = {
    tools: ["bash"],
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
      base: { revision: base },
      materials: [{ id: "readme", repositoryPath: "README.md" }, { id: "task", repositoryPath: "test/fixtures/reviewer-task.md" }],
      spec: { state: "not-established" },
      required: { standards: request },
    }, { id: "fatal-agent" }),
    { stopReason: "toolUse" },
  );
  let providerCalls = 0;
  const first = () => {
    providerCalls += 1;
    return stage.startsWith("child-") || stage.startsWith("preflight-")
      ? agentCall
      : fauxAssistantMessage("Independent review found no findings.");
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
    return fauxAssistantMessage("FORBIDDEN LATER SUCCESS PROSE");
  };
  faux.setResponses([
    first,
    second,
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
  // Reviewer no longer exposes Agent; poison after this fixture's own git reads and
  // before session_start activate/createPinnedGitReader so preflight fail-closed is real.
  if (stage === "preflight-git") {
    console.error("INJECTED_REVIEWER_GIT_IO_FAILURE");
    renameSync(".git", ".git-injected-failure");
  }
  pi.on("tool_call", (event, ctx) => {
    if (stage === "child-provider" && event.toolName === AGENT_TOOL_NAME) {
      (ctx.modelRegistry as any).getProvider = () => {
        console.error("Reviewer Agent provider not found");
        return undefined;
      };
    }
  });
  pi.on("session_shutdown", () => {
    console.error(`REVIEWER_FAILURE_PROVIDER_CALLS=${providerCalls}`);
  });
}
