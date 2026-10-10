/**
 * Mid-turn ticket report (#1171): roles call this as soon as they know the
 * ticket number; the executing process binds and relocates immediately.
 * When to call lives in this tool's description — not Soul.
 */
import { Type } from "typebox";
import { existsSync } from "node:fs";

import type {
  DurablePrincipalAuthority,
  HostContext,
  HostGatekeeperActions,
  HostToolResult,
  RoleHost,
} from "./host-contracts.ts";
import { runDirectoryFromHostContext } from "./host-contracts.ts";
import { piDurablePrincipalAuthority } from "./pi/durable-principal.ts";
import {
  bindAdmittedTicketNumber,
  relocateAdmittedRunToTicket,
  type AdmittedRoleInvocation,
} from "./public-cli/invocation.ts";
import { isUnboundRunDirectory, sessionDirectoryOf, sessionFileOf } from "./role-run-placement.ts";
import { rewriteRunDirectoryPathValue } from "./role-run-path-rewrite.ts";
import { readPageSync } from "./run-dossier.ts";
import { readDeclaredTicketNumber } from "./run-ticket-number.ts";
import { isRecord } from "./unknown-value.ts";

export const REPORT_TICKET_TOOL_NAME = "ak_report_ticket" as const;

const reportTicketArgsSchema = Type.Object(
  {
    ticketNumber: Type.Unknown({
      description:
        "本票号（正整数、数字串或前导 #N）。已知票号时开工即报；尚无票号时不要调用。",
    }),
  },
  { additionalProperties: true },
);

export const REPORT_TICKET_TOOL_DESCRIPTION =
  "向包申报本票号。已知票号时开工第一件事调用；包当场把本腿归到票号目录。"
  + "尚无票号（例如中书省建票前）不要调用，取得后再报。"
  + "交卷时若仍未报过且交卷亦未带票号，包会经既有重交通道再问一次。";

function pageString(page: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = page?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Build the relocate seam's admitted face from durable pages + live principal.
 * The executing process owns this snapshot for the bind/relocate call only.
 */
export function admittedForLiveTicketReport(
  runDirectory: string,
  authority: DurablePrincipalAuthority,
): AdmittedRoleInvocation {
  const admittedPage = readPageSync(runDirectory, "admitted") ?? {};
  const invocationPage = readPageSync(runDirectory, "invocation") ?? {};
  const role = pageString(admittedPage, "role") ?? pageString(invocationPage, "role");
  const runId = pageString(admittedPage, "runId") ?? pageString(invocationPage, "runId");
  const bookKey = pageString(admittedPage, "bookKey") ?? pageString(invocationPage, "bookKey");
  const projectRoot = pageString(admittedPage, "projectRoot")
    ?? pageString(invocationPage, "projectRoot");
  if (role === undefined || runId === undefined || bookKey === undefined || projectRoot === undefined) {
    throw new Error("ak_report_ticket requires durable role/runId/bookKey/projectRoot on the run");
  }
  const attachments = Array.isArray(admittedPage.attachments)
    ? admittedPage.attachments as AdmittedRoleInvocation["attachments"]
    : [];
  const sessionDirectory = sessionDirectoryOf(runDirectory);
  const sessionFile = sessionFileOf(runDirectory);
  const principal = authority.seal({ sessionDirectory, sessionFile });
  const ticketNumber = readDeclaredTicketNumber(admittedPage.ticketNumber)
    ?? readDeclaredTicketNumber(invocationPage.ticketNumber);
  return {
    role,
    runId,
    bookKey,
    projectRoot,
    instruction: typeof admittedPage.instruction === "string" ? admittedPage.instruction : "",
    instructionEmpty: admittedPage.instructionEmpty === true
      || (typeof admittedPage.instruction === "string" && admittedPage.instruction.trim() === ""),
    attachments,
    runDirectory,
    principal,
    ...(ticketNumber === undefined ? {} : { ticketNumber }),
  } as AdmittedRoleInvocation;
}

/**
 * Role-facing tool details only (#1171 / ADR 0087): ticket identity and whether
 * placement moved. Never hand a package-computed runDirectory back to the seat.
 */
export type ReportTicketResult = {
  readonly ticketNumber: number;
  readonly relocated: boolean;
};

/**
 * Bind + relocate under the existing post-admission seams, then update the
 * executing process's live path handles (HostContext + optional env + setSessionFile).
 * Pi: native SessionManager.setSessionFile so later appends stay on the moved file.
 */
export async function reportTicketFromHostContext(
  context: HostContext,
  rawTicketNumber: unknown,
  authority: DurablePrincipalAuthority = piDurablePrincipalAuthority,
): Promise<ReportTicketResult> {
  const ticketNumber = readDeclaredTicketNumber(rawTicketNumber);
  if (ticketNumber === undefined) {
    throw new Error("ak_report_ticket requires an identifiable ticketNumber");
  }
  const runDirectory = runDirectoryFromHostContext(context);
  if (runDirectory === undefined) {
    throw new Error("ak_report_ticket requires a per-turn run directory");
  }
  if (!existsSync(runDirectory)) {
    throw new Error(`ak_report_ticket run directory missing: ${runDirectory}`);
  }

  const admitted = admittedForLiveTicketReport(runDirectory, authority);
  const alreadyPlaced = !isUnboundRunDirectory(runDirectory);
  // #1171 B2 / #1025: already under a ticket leaf — do not rewrite durable identity.
  // Placement stays put; no heterogenous-ticket refuse policy (#1171 judge).
  if (!alreadyPlaced) {
    await bindAdmittedTicketNumber(admitted, ticketNumber);
  }
  // Live handles belong with rename ownership — before derived renderCurrentSync
  // (#1171 F4-R2). Reuse relocate's heldLease.relocate seam; keep raw I/O throw.
  const applyLiveHandles = (nextDirectory: string): void => {
    // Capture live session handle before ownership transfer. After relocate the
    // write handle must share host-authority coords with the principal (#1183):
    // project the prior path onto the new leaf — never rebuild default
    // session.jsonl over a non-default seal (and do not trust a setter rebuild).
    const priorSessionFile = context.sessionManager.getSessionFile?.();
    (context as { runDirectory?: string }).runDirectory = nextDirectory;
    // Same-leg spawn env only (#1171 F1): never overwrite another leg's ambient
    // AK_ROLE_RUN_DIR in a shared process. HostContext is the per-turn authority
    // (host-contracts); Pi dedicated children still refresh when env === old path.
    if (process.env.AK_ROLE_RUN_DIR === runDirectory) {
      process.env.AK_ROLE_RUN_DIR = nextDirectory;
    }
    // Leg-local session/: rewrite the open handle under the renamed run prefix.
    const projectedSessionFile = typeof priorSessionFile === "string" && priorSessionFile.trim() !== ""
      ? rewriteRunDirectoryPathValue(priorSessionFile, runDirectory, nextDirectory)
      : sessionFileOf(nextDirectory);
    if (typeof projectedSessionFile === "string") {
      context.sessionManager.setSessionFile?.(projectedSessionFile);
    }
  };
  // Always enter relocate: unbound→rename+publish; already-on-ticket→publish leftover staging.
  const relocation = await relocateAdmittedRunToTicket(
    admitted,
    authority,
    alreadyPlaced ? undefined : { relocate: applyLiveHandles },
  );
  const nextDirectory = relocation?.newRunDirectory ?? admitted.runDirectory;
  if (relocation === undefined) applyLiveHandles(nextDirectory);

  return {
    ticketNumber: alreadyPlaced
      ? (admitted.ticketNumber ?? ticketNumber)
      : ticketNumber,
    relocated: relocation !== undefined,
  };
}

/**
 * Register the report-ticket tool on the shared host tool mouth (same as submission).
 * #1214 R1b: past the identifiable-ticketNumber check, bind/relocate I/O is host
 * infrastructure — rides failInfrastructure with toolCallId (engine-detour shape).
 * Unidentifiable ticketNumber stays an ordinary tool error (A1).
 */
export function registerReportTicketTool(
  roleHost: RoleHost,
  hostActions: HostGatekeeperActions,
): void {
  if (roleHost.getAllTools().some((tool) => tool.name === REPORT_TICKET_TOOL_NAME)) return;
  roleHost.registerTool({
    name: REPORT_TICKET_TOOL_NAME,
    label: "报票号",
    description: REPORT_TICKET_TOOL_DESCRIPTION,
    promptSnippet: "已知票号时立即申报，包当场归位",
    parameters: reportTicketArgsSchema,
    async execute(toolCallId, parameters, _signal, _onUpdate, ctx): Promise<HostToolResult<ReportTicketResult>> {
      const raw = isRecord(parameters) ? parameters.ticketNumber : undefined;
      // Parameter boundary: only unidentifiable ticketNumber is ordinary tool error.
      const ticketNumber = readDeclaredTicketNumber(raw);
      if (ticketNumber === undefined) {
        throw new Error("ak_report_ticket requires an identifiable ticketNumber");
      }
      try {
        const details = await reportTicketFromHostContext(ctx, ticketNumber);
        return {
          content: [],
          details,
        };
      } catch (error) {
        hostActions.failInfrastructure(error, ctx, toolCallId);
      }
    },
  });
}

/** Soft re-ask when a sealed submission still leaves the leg unbound (#1171 / ADR 0073). */
export const MISSING_TICKET_REASK_MATERIAL = "resources/missing-ticket-reask.md" as const;
