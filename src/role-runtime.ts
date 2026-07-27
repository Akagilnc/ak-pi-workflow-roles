import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AnyCanonicalSkillBinding } from "./canonical-skill-binding.ts";
import type { CollectorClock } from "./collector-evidence.ts";
import type { CollectorGitHubTransport } from "./collector-github.ts";
import {
  COLLECTOR_OBSERVE_TOOL,
  COLLECTOR_OUTPUT_TOOL,
  COLLECTOR_REQUEST_TOOL,
  COLLECTOR_WAIT_TOOL,
  createCollectorRoleRuntime,
} from "./collector-role.ts";
import type { ComplianceDecision } from "./compliance-transport.ts";
import {
  createJudgeRoleRuntime,
  type SoulAuditInput,
  type SoulAuditResult,
} from "./judge-role.ts";
import {
  createReviewerRoleRuntime,
  type ReviewerAuditInput,
} from "./reviewer-role.ts";
import type { ReviewerAgentResult } from "./reviewer-execution-ledger.ts";
import {
  createCoderRoleRuntime,
  createFixerRoleRuntime,
} from "./worker-role.ts";

export {
  JUDGE_OUTPUT_TOOL_NAME,
  type JudgeVerdict,
  type SoulAuditInput,
  type SoulAuditResult,
} from "./judge-role.ts";
export {
  AGENT_TOOL_NAME,
  REVIEWER_OUTPUT_TOOL_NAME,
  type ReviewerAuditInput,
  type ReviewerOutput,
} from "./reviewer-role.ts";
export {
  CODER_OUTPUT_TOOL_NAME,
  FIXER_OUTPUT_TOOL_NAME,
  type CoderOutput,
  type FixerOutput,
  type WorkerOutput,
} from "./worker-role.ts";
export {
  COLLECTOR_OBSERVE_TOOL,
  COLLECTOR_OUTPUT_TOOL,
  COLLECTOR_REQUEST_TOOL,
  COLLECTOR_WAIT_TOOL,
} from "./collector-role.ts";
export type {
  ReviewerAgentAttempt,
  ReviewerAgentInvocationBatch,
  ReviewerAgentResult,
  ReviewerBashEvidence,
  ReviewerExecutionRecord,
  ReviewerTargetSnapshot,
  ReviewerUsage,
  ReviewerWorkspaceDisposition,
} from "./reviewer-execution-ledger.ts";
export type { CollectorReceipt } from "./collector-receipt.ts";
export type { CollectorGitHubTransport } from "./collector-github.ts";
export type { CollectorClock } from "./collector-evidence.ts";

export type RoleRuntimeDependencies = {
  loadJudgeSoul(): Promise<string>;
  loadFixerSoul?(): Promise<string>;
  loadFixPacket?(path: string): Promise<string>;
  loadCoderSoul?(): Promise<string>;
  loadCoderTask?(path: string): Promise<string>;
  loadReviewerSoul?(): Promise<string>;
  loadReviewerTask?(path: string): Promise<string>;
  loadCollectorSoul?(): Promise<string>;
  createCollectorTransport?(): CollectorGitHubTransport;
  createCollectorClock?(): CollectorClock;
  collectorPackageExtensionPath?: string;
  loadCanonicalSkillBinding?(
    name: "tdd" | "code-review",
  ): Promise<AnyCanonicalSkillBinding>;
  runReviewerAgent?(
    input: { description: string; prompt: string },
    options: { context: ExtensionContext; signal?: AbortSignal },
  ): Promise<ReviewerAgentResult>;
  shutdownReviewerAgent?(): Promise<void>;
  transcriptFromContext(ctx: ExtensionContext): string;
  auditSoulCompliance(
    input: SoulAuditInput,
    options: { context: ExtensionContext; signal?: AbortSignal },
  ): Promise<SoulAuditResult>;
  auditReviewerCompliance?(
    input: ReviewerAuditInput,
    options: { context: ExtensionContext; signal?: AbortSignal },
  ): Promise<ComplianceDecision>;
};

function failInfrastructure(error: unknown, ctx: ExtensionContext): never {
  ctx.abort();
  if (ctx.mode === "print" || ctx.mode === "json") process.exitCode = 1;
  throw error;
}

export function createRoleRuntimeExtension(
  dependencies: RoleRuntimeDependencies,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.registerFlag("ak-role", {
      description:
        "Activate a packaged workflow role: judge, fixer, coder, reviewer, or collector",
      type: "string",
    });

    const hostActions = { failInfrastructure };
    const judge = createJudgeRoleRuntime(
      pi,
      {
        loadSoul: dependencies.loadJudgeSoul,
        transcriptFromContext: dependencies.transcriptFromContext,
        auditSoulCompliance: dependencies.auditSoulCompliance,
      },
      hostActions,
    );
    const fixer = createFixerRoleRuntime(
      pi,
      {
        async loadSoul() {
          if (dependencies.loadFixerSoul === undefined) {
            throw new Error("fixer soul loader is not configured");
          }
          return dependencies.loadFixerSoul();
        },
        async loadPacket(path) {
          if (dependencies.loadFixPacket === undefined) {
            throw new Error("Fixer packet loader is not configured");
          }
          return dependencies.loadFixPacket(path);
        },
      },
    );
    const coder = createCoderRoleRuntime(
      pi,
      {
        async loadSoul() {
          if (dependencies.loadCoderSoul === undefined) {
            throw new Error("coder soul loader is not configured");
          }
          return dependencies.loadCoderSoul();
        },
        async loadTask(path) {
          if (dependencies.loadCoderTask === undefined) {
            throw new Error("Coder task loader is not configured");
          }
          return dependencies.loadCoderTask(path);
        },
        ...(dependencies.loadCanonicalSkillBinding === undefined
          ? {}
          : {
              loadCanonicalSkillBinding: (name: "tdd") =>
                dependencies.loadCanonicalSkillBinding!(name),
            }),
      },
      hostActions,
    );
    const reviewer = createReviewerRoleRuntime(
      pi,
      {
        async loadSoul() {
          if (dependencies.loadReviewerSoul === undefined) {
            throw new Error("reviewer soul loader is not configured");
          }
          return dependencies.loadReviewerSoul();
        },
        async loadTask(path) {
          if (
            dependencies.loadReviewerTask === undefined ||
            dependencies.loadCanonicalSkillBinding === undefined ||
            dependencies.runReviewerAgent === undefined ||
            dependencies.auditReviewerCompliance === undefined
          ) {
            throw new Error("Reviewer runtime dependencies are not configured");
          }
          return dependencies.loadReviewerTask(path);
        },
        async loadCanonicalSkillBinding(name) {
          if (dependencies.loadCanonicalSkillBinding === undefined) {
            throw new Error("Reviewer runtime dependencies are not configured");
          }
          return dependencies.loadCanonicalSkillBinding(name);
        },
        async runAgent(input, options) {
          if (dependencies.runReviewerAgent === undefined) {
            throw new Error("Reviewer runtime dependencies are not configured");
          }
          return dependencies.runReviewerAgent(input, options);
        },
        ...(dependencies.shutdownReviewerAgent === undefined
          ? {}
          : { shutdownAgent: dependencies.shutdownReviewerAgent }),
        async auditCompliance(input, options) {
          if (dependencies.auditReviewerCompliance === undefined) {
            throw new Error("Reviewer runtime dependencies are not configured");
          }
          return dependencies.auditReviewerCompliance(input, options);
        },
      },
      hostActions,
    );
    const collector = createCollectorRoleRuntime(
      pi,
      {
        async loadSoul() {
          if (dependencies.loadCollectorSoul === undefined) {
            throw new Error("collector soul loader is not configured");
          }
          return dependencies.loadCollectorSoul();
        },
        createTransport() {
          if (dependencies.createCollectorTransport === undefined) {
            throw new Error("Collector GitHub transport is not configured");
          }
          return dependencies.createCollectorTransport();
        },
        ...(dependencies.createCollectorClock === undefined
          ? {}
          : { createClock: dependencies.createCollectorClock }),
        ...(dependencies.collectorPackageExtensionPath === undefined
          ? {}
          : {
            packageExtensionPath: dependencies.collectorPackageExtensionPath,
          }),
      },
      hostActions,
    );

    pi.on("session_start", async (event, ctx) => {
      const role = pi.getFlag("ak-role");
      if (role === undefined) return;
      if (
        role !== "judge" && role !== "fixer" && role !== "coder" &&
        role !== "reviewer" && role !== "collector"
      ) {
        throw new Error(`Unsupported workflow role: ${String(role)}`);
      }
      switch (role) {
        case "judge":
          await judge.activate();
          return;
        case "fixer":
          await fixer.activate();
          return;
        case "coder":
          await coder.activate(ctx);
          return;
        case "reviewer":
          await reviewer.activate(ctx);
          return;
        case "collector":
          await collector.activate(ctx, event);
          return;
      }
    });
  };
}
