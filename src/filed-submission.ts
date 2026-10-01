import type { HostContext, HostToolResult, RoleHost } from "./host-contracts.ts";
import type { RoleSubmissionDeclaration } from "./role-submission-declarations.ts";

export type FiledSubmissionBeforeAccept = (input: {
  readonly toolCallId: string;
  readonly parameters: unknown;
  readonly signal: AbortSignal | undefined;
  readonly ctx: HostContext;
}) => Promise<unknown>;

/**
 * One host-neutral submission execute for every public seat.
 * Records nothing itself — the ledger seam already appends the original payload.
 * Ends this tool call. Does not summon an auditor and does not end the role run.
 * Shape is not an admission gate (ADR 0055). Seat reminders stay on beforeAccept.
 */
export function registerFiledSubmissionTool(
  roleHost: RoleHost,
  tool: RoleSubmissionDeclaration,
  options: {
    readonly readyError: () => string | undefined;
    readonly beforeAccept?: FiledSubmissionBeforeAccept;
  },
): void {
  roleHost.registerTool({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    ...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
    parameters: tool.parameters as never,
    async execute(toolCallId, parameters, signal, _onUpdate, ctx): Promise<HostToolResult<unknown>> {
      const blocked = options.readyError();
      if (blocked !== undefined) throw new Error(blocked);
      const projected = options.beforeAccept === undefined
        ? undefined
        : await options.beforeAccept({ toolCallId, parameters, signal, ctx });
      return {
        content: [],
        details: projected === undefined ? parameters : projected,
        terminate: true as const,
      };
    },
  });
}
