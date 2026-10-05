/**
 * Collector business: soul/material assembly and sole submission tool.
 * #1088: code no longer observes/requests/merges GitHub findings — the LLM
 * uses host CLI tools. Envelope owns host-surface + construction seatbelt.
 * #1165: --request-manifest is a caller path only; package does not load it.
 */
import type { RoleHost, HostContext } from "./host-contracts.ts";
import { registerFiledSubmissionTool } from "./filed-submission.ts";
import { roleSubmissionDeclaration } from "./role-submission-declarations.ts";

import {
  parseCollectorPrNumber,
  parseCollectorRepository,
  type CollectorRepository,
} from "./collector-config.ts";
import {
  COLLECTOR_OUTPUT_TOOL,
} from "./package-contracts/collector-output.ts";
export { COLLECTOR_OUTPUT_TOOL };

export const COLLECTOR_REQUIRED_TOOLS = [COLLECTOR_OUTPUT_TOOL] as const;

/** Host tools that grant construction seat privileges — blocked for 收证席 (ADR 0064). */
export const COLLECTOR_CONSTRUCTION_TOOLS = Object.freeze(["write", "edit"] as const);

/** Envelope-owned transport flags (ADR 0018 / #676 E). */
export const COLLECTOR_TRANSPORT_FLAGS = Object.freeze([
  Object.freeze({
    name: "ak-collector-repo",
    definition: Object.freeze({
      description:
        "GitHub owner/repo target for Collector (github.com only; conservative ASCII grammar).",
      type: "string" as const,
    }),
  }),
  Object.freeze({
    name: "ak-collector-pr",
    definition: Object.freeze({
      description:
        "Optional positive safe-integer pull request number for Collector. Omit when the role will locate the PR via host CLI.",
      type: "string" as const,
    }),
  }),
  Object.freeze({
    name: "ak-collector-request-manifest",
    definition: Object.freeze({
      description:
        "Caller path to a request manifest JSON file (passed as-is; package does not read or validate).",
      type: "string" as const,
    }),
  }),
] as const);


export type CollectorRoleDependencies = {
  loadSoul(): Promise<string>;
};

export type CollectorActivation = {
  soul: string;
  repository: CollectorRepository;
  prNumber: number | undefined;
  requestManifestPath?: string;
};

function buildMethodContext(activation: CollectorActivation): string {
  const lines = [
    "<collector_method>",
    `host: github.com`,
    `repository: ${activation.repository.canonical}`,
    `prNumber: ${activation.prNumber === undefined ? "未绑定" : String(activation.prNumber)}`,
    ...(activation.requestManifestPath === undefined
      ? []
      : [`requestManifestPath: ${activation.requestManifestPath}`]),
    "</collector_method>",
  ];
  return lines.join("\n");
}

/**
 * Shared envelope installs the submission tool and material callback after lifecycle gates.
 * Role module does not self-hook events, setActiveTools, or mode/fork checks (ADR 0018 / #676 E).
 */
export function createCollectorRoleRuntime(
  pi: RoleHost,
  dependencies: CollectorRoleDependencies,
): {
  activate(ctx: HostContext): Promise<CollectorActivation>;
  assembleMaterials(activation: CollectorActivation, baseSystemPrompt: string): string;
  onToolCall(
    _activation: CollectorActivation,
    event: { toolName: string; toolCallId: string },
  ): { block: true; reason: string } | undefined;
  registerBusinessTools(getActivation: () => CollectorActivation | undefined): void;
} {
  let toolsRegistered = false;

  return {
    async activate(_ctx) {
      const soul = (await dependencies.loadSoul()).trim();
      if (soul.length === 0) throw new Error("Collector soul is empty");

      const repoFlag = pi.getFlag("ak-collector-repo");
      const prFlag = pi.getFlag("ak-collector-pr");
      const requestManifestFlag = pi.getFlag("ak-collector-request-manifest");
      if (typeof repoFlag !== "string" || repoFlag.trim().length === 0) {
        throw new Error("Collector requires --ak-collector-repo");
      }
      const repository = parseCollectorRepository(repoFlag);
      let prNumber: number | undefined;
      if (typeof prFlag === "string" && prFlag.trim().length > 0) {
        prNumber = parseCollectorPrNumber(prFlag);
      } else if (typeof prFlag === "number") {
        prNumber = parseCollectorPrNumber(prFlag);
      }
      // #1165: opaque caller path — keep spaces/"" when the flag was provided.
      const requestManifestPath =
        typeof requestManifestFlag === "string" ? requestManifestFlag : undefined;

      return {
        soul,
        repository,
        prNumber,
        ...(requestManifestPath === undefined ? {} : { requestManifestPath }),
      };
    },

    assembleMaterials(activation, baseSystemPrompt) {
      return [
        baseSystemPrompt,
        "",
        "<collector_soul>",
        activation.soul,
        "</collector_soul>",
        "",
        buildMethodContext(activation),
      ].join("\n");
    },

    onToolCall(_activation, event) {
      if ((COLLECTOR_CONSTRUCTION_TOOLS as readonly string[]).includes(event.toolName)) {
        return {
          block: true,
          reason: `通进司为收证席，禁用施工工具 ${event.toolName}`,
        };
      }
      return undefined;
    },

    registerBusinessTools(getActivation) {
      if (toolsRegistered) return;
      toolsRegistered = true;

      registerFiledSubmissionTool(pi, roleSubmissionDeclaration("collector"), {
        readyError: () => (getActivation() === undefined ? "通进司未激活" : undefined),
      });
    },
  };
}
