import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ComplianceDecision } from "./compliance-transport.ts";
import {
  navigatorReceiptV1Schema,
  validateNavigatorReceiptV1,
  type CurrentPositionSnapshotV1,
} from "./navigator-contracts.ts";
import { navigatorEvidenceReadSchema, type NavigatorEvidenceStore } from "./navigator-evidence.ts";
import type { NavigatorAuditInput } from "./navigator-auditor.ts";
import { NAVIGATOR_OUTPUT_TOOL_NAME } from "./package-contracts/navigator-output.ts";

export const NAVIGATOR_EVIDENCE_TOOL_NAME = "ak_navigator_evidence_read";
export { NAVIGATOR_OUTPUT_TOOL_NAME };
export const NAVIGATOR_SNAPSHOT_FLAG = {
  name: "ak-navigator-snapshot",
  definition: { description: "Path to one frozen Navigator v1 snapshot", type: "string" as const },
} as const;

export type NavigatorToolDependencies = {
  auditCompliance(input: NavigatorAuditInput, options: { context: ExtensionContext; signal?: AbortSignal }): Promise<ComplianceDecision>;
};

export type NavigatorActiveState = {
  soul: string;
  snapshot: CurrentPositionSnapshotV1;
  store: NavigatorEvidenceStore;
};

function singleton(toolCallId: string, ctx: ExtensionContext): void {
  const leaf = ctx.sessionManager.getLeafEntry();
  if (leaf?.type !== "message" || leaf.message.role !== "assistant") throw new Error("Navigator output must be the sole final tool call");
  const calls = leaf.message.content.filter((part) => part.type === "toolCall");
  if (calls.length !== 1 || calls[0]?.id !== toolCallId || calls[0]?.name !== NAVIGATOR_OUTPUT_TOOL_NAME) throw new Error("Navigator output must be the sole final tool call");
}

export function createNavigatorToolDefinitions(
  dependencies: NavigatorToolDependencies,
  activeState: () => NavigatorActiveState | undefined,
  host: { failInfrastructure(error: unknown, ctx: ExtensionContext): never },
) {
  return [
    {
      name: NAVIGATOR_EVIDENCE_TOOL_NAME,
      label: "Navigator Evidence",
      description: "Read one admitted frozen evidence item.",
      parameters: navigatorEvidenceReadSchema,
      async execute(_id: string, params: { evidenceId: string; offset?: number; limit?: number }) {
        const active = activeState();
        if (!active) throw new Error("Navigator not activated");
        const details = active.store.read(params.evidenceId, params.offset, params.limit);
        return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
      },
    },
    {
      name: NAVIGATOR_OUTPUT_TOOL_NAME,
      label: "Navigator Output",
      description: "Submit one typed advisory posture.",
      parameters: navigatorReceiptV1Schema,
      async execute(id: string, params: unknown, signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) {
        const active = activeState();
        if (!active) throw new Error("Navigator not activated");
        singleton(id, ctx);
        const output = validateNavigatorReceiptV1(params, active.snapshot, active.store.readRecord());
        let audit: ComplianceDecision;
        try {
          audit = await dependencies.auditCompliance(
            { soul: active.soul, snapshot: active.snapshot, readRecord: active.store.readRecord(), output },
            signal === undefined ? { context: ctx } : { context: ctx, signal },
          );
        } catch (error) {
          host.failInfrastructure(error, ctx);
        }
        if (audit.status === "revise") throw new Error(`Navigator output violates its soul: ${audit.violations.join("; ")}`);
        return {
          content: [{ type: "text" as const, text: "Navigator output accepted" }],
          details: output,
          terminate: true as const,
          ...(audit.usage === undefined ? {} : { usage: audit.usage }),
        };
      },
    },
  ] as const;
}
