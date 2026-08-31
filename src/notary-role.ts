import type { RoleHost, HostContext, HostToolResult } from "./host-contracts.ts";
/**
 * Public Notary role runtime — direct officer seat (not through Gatekeeper province).
 * Caller supplies only a source-run locator; Notary self-fetches authoritative materials.
 */

import {
  NOTARY_ACCEPTED_TEXT,
  NOTARY_OUTPUT_TOOL_NAME,
  NOTARY_SOURCE_RUN_FLAG,
  NOTARY_TICKET_FLAG,
  notaryOutputSchema,
  projectLawfulNotaryOutput,
  retainNotarySubmission,
  type NotarySourceRunLocator,
} from "./notary-contracts.ts";

export {
  NOTARY_ACCEPTED_TEXT,
  NOTARY_OUTPUT_TOOL_NAME,
  NOTARY_SOURCE_RUN_FLAG,
  NOTARY_TICKET_FLAG,
};

export type NotaryRoleDependencies = {
  loadSoul(): Promise<string>;
  loadSourceRunLocator(path: string): Promise<NotarySourceRunLocator>;
};

export type NotaryRoleHostActions = {
  failInfrastructure(
    error: unknown,
    ctx: HostContext,
    toolCallId?: string,
  ): never;
};

/** Optional ticket flag: absent/blank = unbound; non-empty invalid = honest fail. */
export function readNotaryTicketFlag(flag: unknown): number | undefined {
  if (flag === undefined) return undefined;
  if (typeof flag !== "string") {
    throw new Error(
      "Notary ak-notary-ticket-number is present but not a safe positive integer string",
    );
  }
  if (flag.trim() === "") return undefined;
  const n = Number(flag);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(
      "Notary ak-notary-ticket-number is present but not a safe positive integer string",
    );
  }
  return n;
}

/**
 * Typed session bound (locator + optional ticket).
 * Sole production projection fed into before_agent_start material assembly.
 */
export function projectNotarySessionBound(input: {
  readonly sourceRun: NotarySourceRunLocator;
  readonly ticketNumber?: number;
}): {
  readonly sourceRun: NotarySourceRunLocator;
  readonly ticketNumber?: number;
} {
  return {
    sourceRun: input.sourceRun,
    ...(input.ticketNumber === undefined ? {} : { ticketNumber: input.ticketNumber }),
  };
}

export type NotarySessionBound = ReturnType<typeof projectNotarySessionBound>;

/**
 * Assemble systemPrompt patch from soul + typed bound.
 * Returns bound alongside prompt so callers observe the same object the prompt encodes
 * (production host only consumes systemPrompt; bound is the typed half of this seam).
 */
export function assembleNotaryAgentStart(input: {
  readonly baseSystemPrompt: string;
  readonly soul: string;
  readonly bound: NotarySessionBound;
}): { readonly systemPrompt: string; readonly bound: NotarySessionBound } {
  return {
    bound: input.bound,
    systemPrompt: `${input.baseSystemPrompt}\n\n<notary_soul>\n${input.soul}\n</notary_soul>\n\n<notary_source_run>\n${JSON.stringify(input.bound)}\n</notary_source_run>`,
  };
}

export function createNotaryRoleRuntime(
  pi: RoleHost,
  dependencies: NotaryRoleDependencies,
  host: NotaryRoleHostActions,
) {
  let activation:
    | {
        soul: string;
        sourceRun: NotarySourceRunLocator;
        ticketNumber?: number;
      }
    | undefined;
  let registered = false;
  pi.registerFlag(
    NOTARY_SOURCE_RUN_FLAG.name,
    NOTARY_SOURCE_RUN_FLAG.definition,
  );
  pi.registerFlag(NOTARY_TICKET_FLAG.name, NOTARY_TICKET_FLAG.definition);

  return {
    async activate(): Promise<void> {
      const path = pi.getFlag(NOTARY_SOURCE_RUN_FLAG.name);
      if (typeof path !== "string" || path.trim() === "") {
        throw new Error("Notary requires --ak-notary-source-run");
      }
      const soul = (await dependencies.loadSoul()).trim();
      if (soul.length === 0) throw new Error("Notary soul is empty");
      const sourceRun = await dependencies.loadSourceRunLocator(path);
      const ticketNumber = readNotaryTicketFlag(
        pi.getFlag(NOTARY_TICKET_FLAG.name),
      );
      activation = {
        soul,
        sourceRun,
        ...(ticketNumber === undefined ? {} : { ticketNumber }),
      };

      if (!registered) {
        registered = true;
        pi.registerTool({
          name: NOTARY_OUTPUT_TOOL_NAME,
          label: "符宝郎输出",
          description: "提交引文保真与票面对齐的 typed pass/bounce 决议。",
          promptSnippet: "提交符宝郎决议",
          parameters: notaryOutputSchema,
          async execute(toolCallId: string, parameters: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: HostContext, ): Promise<HostToolResult<unknown>> {
            if (activation === undefined) {
              throw new Error("符宝郎未激活");
            }
            // Unique submission + terminate only. Shape is not an admission gate
            // (第 0 条 / ADR 0055): lawful pass/bounce projected; else params as-is.
            // #541 infra declaration + sole-final barrier are ledger-owned (#575).
            const lawful = projectLawfulNotaryOutput(parameters);
            const details = lawful ?? retainNotarySubmission(parameters);
            return {
              content: [{ type: "text" as const, text: NOTARY_ACCEPTED_TEXT }],
              details,
              terminate: true as const,
            };
          },
        });
        pi.on("before_agent_start", (event) => {
          if (activation === undefined) {
            throw new Error("符宝郎未激活");
          }
          // Locator + optional ticket — never preload diary/diff/draft body (self-fetch).
          const bound = projectNotarySessionBound({
            sourceRun: activation.sourceRun,
            ...(activation.ticketNumber === undefined
              ? {}
              : { ticketNumber: activation.ticketNumber }),
          });
          const assembled = assembleNotaryAgentStart({
            baseSystemPrompt: event.systemPrompt,
            soul: activation.soul,
            bound,
          });
          // Host event result only carries systemPrompt; bound is assembled with it.
          return { systemPrompt: assembled.systemPrompt };
        });
      }

      // Evidence role: keep Pi default tools + notary output (ADR 0064 unrestricted).
      const all = pi.getAllTools().map((tool) => tool.name);
      if (all.filter((name) => name === NOTARY_OUTPUT_TOOL_NAME).length !== 1) {
        throw new Error(
          `Notary required tool collision or missing: ${NOTARY_OUTPUT_TOOL_NAME}`,
        );
      }
    },
  };
}
