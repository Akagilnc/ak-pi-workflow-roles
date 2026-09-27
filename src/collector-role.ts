/**
 * Collector business: soul/material assembly and sole submission tool.
 * #1088: code no longer observes/requests/merges GitHub findings — the LLM
 * uses host CLI tools. Envelope owns host-surface + construction seatbelt.
 */
import type { RoleHost, HostContext, HostToolResult } from "./host-contracts.ts";
import type { Static } from "typebox";

import {
  emptyCollectorManifest,
  loadCollectorManifest,
  parseCollectorPrNumber,
  parseCollectorRepository,
  type CollectorManifest,
  type CollectorRepository,
} from "./collector-config.ts";
import {
  COLLECTOR_OUTPUT_TOOL,
} from "./package-contracts/collector-output.ts";
import { collectorOutputArgsSchema } from "./collector-tool-schemas.ts";

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
        "Path to the Collector v1 request manifest JSON file (caller guidance; not a machine collection directive).",
      type: "string" as const,
    }),
  }),
] as const);

const outputSchema = collectorOutputArgsSchema;
type OutputParams = Static<typeof outputSchema>;

export type CollectorRoleDependencies = {
  loadSoul(): Promise<string>;
};

export type CollectorRoleHostActions = {
  failInfrastructure(error: unknown, ctx: HostContext, toolCallId?: string): never;
};

export type CollectorActivation = {
  soul: string;
  repository: CollectorRepository;
  prNumber: number | undefined;
  manifest: CollectorManifest;
};

function buildMethodContext(activation: CollectorActivation): string {
  const lines = [
    "<collector_method>",
    `host: github.com`,
    `repository: ${activation.repository.canonical}`,
    `prNumber: ${activation.prNumber === undefined ? "未绑定" : String(activation.prNumber)}`,
    `requests: ${JSON.stringify(activation.manifest.requests.map((request) => ({ id: request.id })))}`,
    `manifestDigest: ${activation.manifest.digest}`,
    "</collector_method>",
  ];
  if (activation.manifest.requests.length > 0) {
    const payload = JSON.stringify({
      requests: activation.manifest.requests.map((request) => ({
        id: request.id,
        body: request.requestBody,
      })),
    }).replaceAll("<", "\\u003c");
    lines.push("", "<collector_request_manifest>", payload, "</collector_request_manifest>");
  }
  return lines.join("\n");
}

/**
 * Shared envelope installs the submission tool and material callback after lifecycle gates.
 * Role module does not self-hook events, setActiveTools, or mode/fork checks (ADR 0018 / #676 E).
 */
export function createCollectorRoleRuntime(
  pi: RoleHost,
  dependencies: CollectorRoleDependencies,
  _hostActions: CollectorRoleHostActions,
): {
  activate(ctx: HostContext): Promise<CollectorActivation>;
  assembleMaterials(activation: CollectorActivation, baseSystemPrompt: string): string;
  onToolCall(
    _activation: CollectorActivation,
    event: { toolName: string; toolCallId: string },
  ): { block: true; reason: string } | undefined;
  onToolResult(_activation: CollectorActivation, _event: { toolCallId: string }): void;
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
      const manifest = typeof requestManifestFlag === "string" && requestManifestFlag.trim().length > 0
        ? await loadCollectorManifest(requestManifestFlag)
        : emptyCollectorManifest();

      return {
        soul,
        repository,
        prNumber,
        manifest,
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

    onToolResult() {
      // No operational ledger after #1088.
    },

    registerBusinessTools(getActivation) {
      if (toolsRegistered) return;
      toolsRegistered = true;

      pi.registerTool({
        name: COLLECTOR_OUTPUT_TOOL,
        label: "通进司输出",
        description: "提交通进司回执。",
        promptSnippet: "提交通进司回执",
        parameters: outputSchema,
        async execute(
          _toolCallId: string,
          params: OutputParams,
          _signal: AbortSignal | undefined,
          _onUpdate: unknown,
          _ctx: HostContext,
        ): Promise<HostToolResult<unknown>> {
          const activation = getActivation();
          if (activation === undefined) throw new Error("通进司未激活");
          // #1088 / #836: record as submitted — runtime does not merge findings.
          return {
            content: [],
            details: params,
            terminate: true as const,
          };
        },
      });
    },
  };
}
