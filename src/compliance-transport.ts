import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import type { AuditorSoulRole } from "./auditor-soul.ts";
import { auditorRunDirectory } from "./auditor-dossier-tool.ts";
import {
  courtAttemptIdFromHostContext,
  type HostContext,
} from "./host-contracts.ts";
import type { NoReceiptLifecycleFacts } from "./receipt-delivery-policy.ts";
import type { PublicSummonResult } from "./public-role-summons.ts";
import { OFFICER_CONCLUSION_REASK } from "./gatekeeper-role.ts";

export type ComplianceNoReceipt = NoReceiptLifecycleFacts & { status: "no-receipt"; usage?: Usage };
/**
 * #757 / #750: no unreadable/unusable judgment on auditor replies.
 * Known three-state (pass/bounce/escalate) is read for queueing only.
 * Unknown accepted shape rides as `received` with the raw reply — parent stands,
 * no forged pass, no shape-death label. Resume-speaker for three pairs is #753/#756.
 */
export type ComplianceReceived = {
  readonly status: "received";
  readonly reply: unknown;
  readonly usage?: Usage;
};
/** Host/engine/record failure — not a role three-state, not `received` (#836 A.3). */
export type ComplianceTransportFailure = {
  readonly status: "transport_failure";
  readonly diagnostic: string;
  readonly submissions?: readonly unknown[];
  readonly terminal?: unknown;
  readonly usage?: Usage;
};
export type ComplianceDecision =
  | { status: "pass"; receipt?: unknown; usage?: Usage }
  | { status: "bounce"; violations: readonly unknown[]; receipt?: unknown; usage?: Usage }
  | { status: "escalate"; conflicts?: unknown; decisionGate?: unknown; receipt?: unknown; usage?: Usage }
  | ComplianceNoReceipt
  | ComplianceReceived
  | ComplianceTransportFailure;
/** Zero-projection kickoff — soul already carries dossier-fetch duty; no hand-delivered materials. */
export const AUDITOR_DOSSIER_PROMPT = "卷宗指针：" as const;

export const COMPLIANCE_RESPONSE_ENTRY_TYPE = "ak_compliance_response" as const;
export const AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE = "ak_auditor_parent_attempt_binding" as const;
export const AUDITOR_COMPLIANCE_FAILURE_ENTRY_TYPE = "ak_auditor_compliance_failure" as const;

export class ComplianceResponseRetentionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ComplianceResponseRetentionError";
  }
}

export type AuditorParentAttemptBinding = {
  readonly version: 1;
  readonly parent: {
    readonly sessionId?: string;
    readonly sessionFile?: string;
    readonly attemptEntryId?: string;
    /** Existing court-turn identity (#637); same rule as SettlementCourtScope.courtAttemptId. */
    readonly courtAttemptId?: string;
  };
};

export type AuditorComplianceFailureRecord = {
  readonly version: 1;
  readonly parent: AuditorParentAttemptBinding["parent"];
  readonly failure: {
    readonly cause?: string;
    readonly diagnostic?: string;
    readonly identity?: { readonly name?: string; readonly code?: string | number };
    readonly details?: Readonly<Record<string, unknown>>;
  };
};

/**
 * Persist parent-attempt binding (+ optional compliance failure) under the parent
 * session's auditor-roles nest — the volume `loadBoundAuditorVolumes` reads.
 * courtAttemptId is the existing Host court identity (#637), not a resume flag.
 * Missing parent session file is a no-op (offline mocks without a durable principal).
 */
export function persistAuditorParentAttemptBinding(options: {
  readonly context: HostContext;
  readonly failure?: AuditorComplianceFailureRecord["failure"];
}): AuditorParentAttemptBinding | undefined {
  const parentSessionFile = options.context.sessionManager?.getSessionFile?.();
  if (typeof parentSessionFile !== "string" || parentSessionFile.trim() === "") {
    return undefined;
  }
  const header = options.context.sessionManager?.getHeader?.();
  const parentSessionId =
    header !== null && header !== undefined && typeof header.id === "string" && header.id.length > 0
      ? header.id
      : undefined;
  const leafId = options.context.sessionManager?.getLeafId?.();
  const attemptEntryId =
    typeof leafId === "string" && leafId.length > 0 ? leafId : undefined;
  const courtAttemptId = courtAttemptIdFromHostContext(options.context);
  const binding: AuditorParentAttemptBinding = {
    version: 1,
    parent: {
      sessionFile: parentSessionFile,
      ...(parentSessionId === undefined ? {} : { sessionId: parentSessionId }),
      ...(attemptEntryId === undefined ? {} : { attemptEntryId }),
      ...(courtAttemptId === undefined ? {} : { courtAttemptId }),
    },
  };
  const nest = join(dirname(parentSessionFile), "auditor-roles");
  mkdirSync(nest, { recursive: true });
  // One leaf per court attempt when known; else a unique leaf so multi-summons
  // under unscoped parents do not overwrite each other.
  const leafName =
    courtAttemptId !== undefined
      ? `compliance-${courtAttemptId}.jsonl`
      : `compliance-${randomUUID()}.jsonl`;
  const rows: unknown[] = [
    {
      type: "session",
      id: `auditor-binding-${courtAttemptId ?? randomUUID()}`,
      parentSession: parentSessionFile,
    },
    {
      type: "custom",
      customType: AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE,
      data: binding,
    },
  ];
  if (options.failure !== undefined) {
    const failureData: AuditorComplianceFailureRecord = {
      version: 1,
      parent: binding.parent,
      failure: options.failure,
    };
    // Settlement compliance recovery requires a provider-stop assistant in the
    // same volume interval before the retained failure entry.
    const details = options.failure.details;
    rows.push({
      type: "message",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage:
          typeof options.failure.diagnostic === "string" && options.failure.diagnostic.length > 0
            ? options.failure.diagnostic
            : "auditor transport failure",
        ...(typeof details?.provider === "string" ? { provider: details.provider } : {}),
        ...(typeof details?.model === "string" ? { model: details.model } : {}),
      },
    });
    rows.push({
      type: "custom",
      customType: AUDITOR_COMPLIANCE_FAILURE_ENTRY_TYPE,
      data: failureData,
    });
  }
  writeFileSync(
    join(nest, leafName),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
  return binding;
}

function readListField(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : value === undefined ? [] : [value]; }

/** Try to project a known three-state compliance decision; undefined when not pass/bounce/escalate. */
export function tryReadComplianceCandidate(arguments_: unknown, usage?: Usage): ComplianceDecision | undefined {
  if (typeof arguments_ !== "object" || arguments_ === null || Array.isArray(arguments_)) {
    return undefined;
  }
  const args = arguments_ as Record<string, unknown>;
  const status = args.status;
  if (status === "pass") return { status, receipt: arguments_, ...(usage === undefined ? {} : { usage }) };
  if (status === "bounce") return { status, violations: readListField(args.violations), receipt: arguments_, ...(usage === undefined ? {} : { usage }) };
  if (status === "escalate") {
    return {
      status,
      receipt: arguments_,
      ...(Object.hasOwn(args, "conflicts") ? { conflicts: args.conflicts } : {}),
      ...(Object.hasOwn(args, "decisionGate") ? { decisionGate: args.decisionGate } : {}),
      ...(usage === undefined ? {} : { usage }),
    };
  }
  return undefined;
}

/**
 * Read a compliance candidate. Known three-state projects; anything else is
 * `received` with the raw reply — no unreadable/unusable judgment (#757).
 */
export function readComplianceCandidate(arguments_: unknown, usage?: Usage): ComplianceDecision {
  const projected = tryReadComplianceCandidate(arguments_, usage);
  if (projected !== undefined) return projected;
  return {
    status: "received",
    reply: arguments_,
    ...(usage === undefined ? {} : { usage }),
  };
}

/**
 * Public auditor summon for compliance (#675 / ADR 0062 / owner r11).
 * 审刑院 is the independent audit role; subject (who is audited) selects soul files.
 * Same public path whether nested or direct `ak-role auditor --subject … --source-run …`.
 */
export type AuditorSummon = (
  subject: AuditorSoulRole,
  sourceRunDirectory: string,
  /** Parent cancellation forwarded to the nested activation (#675). */
  signal?: AbortSignal,
  /** Plain-language re-ask when the prior reply was not a three-state conclusion. */
  reask?: string,
) => Promise<PublicSummonResult>;

export type RunComplianceAuditOptions = {
  /** Who is being audited — selects judge-auditor.md / doctor-auditor.md. */
  readonly subject: AuditorSoulRole;
  context: HostContext;
  runDirectory?: string | undefined;
  signal?: AbortSignal;
  /** Test seam — production uses summonPublicRole({ role: "auditor", argv: ["--subject", subject, "--source-run", …] }). */
  summonAuditor?: AuditorSummon;
};

async function usageFromSummonedSession(summoned: PublicSummonResult): Promise<Usage | undefined> {
  const { usageFromPublicSummon } = await import("./session-assistant-usage.ts");
  return usageFromPublicSummon(summoned);
}

/**
 * Project a public auditor terminal onto the parent compliance decision.
 * Known pass/bounce/escalate/no-receipt flow through for queueing.
 * Accepted-but-not-three-state → `received` with raw reply (#757) — no unreadable label,
 * never forged pass, never parent abort. Real provider/engine/disk failures stay loud.
 * Accepted audits always carry real session usage when present (#675 metering).
 */
async function projectAuditorTerminal(summoned: PublicSummonResult): Promise<ComplianceDecision> {
  const outcome = summoned.terminal?.roleOutcome;
  if (outcome === undefined) {
    const detail = summoned.stderr?.trim();
    throw new Error(
      detail && detail.length > 0
        ? `Auditor public summon produced no terminal (exit ${summoned.exitCode}: ${detail})`
        : `Auditor public summon produced no terminal (exit ${summoned.exitCode})`,
    );
  }
  const usage = await usageFromSummonedSession(summoned);
  if (outcome.kind === "no_receipt") {
    const { status: _ignored, kind: _kind, role: _role, decisiveFacts: _facts, ...facts } = outcome;
    return {
      status: "no-receipt",
      ...facts,
      ...(usage === undefined ? {} : { usage }),
    };
  }
  if (outcome.kind === "failure") {
    const rows = outcome.payloads ?? summoned.terminal?.submissions ?? [];
    return {
      status: "transport_failure",
      diagnostic: outcome.diagnostic,
      ...(rows.length > 0 ? { submissions: rows } : {}),
      ...(summoned.terminal === undefined ? {} : { terminal: summoned.terminal }),
      ...(usage === undefined ? {} : { usage }),
    };
  }
  if (outcome.kind === "accepted") {
    const rows = outcome.payloads ?? summoned.terminal?.submissions ?? [];
    if (rows.length === 0) {
      return readComplianceCandidate({}, usage);
    }
    // Queue the latest conclusion; keep every original row on the receipt/reply face.
    const decision = readComplianceCandidate(rows[rows.length - 1], usage);
    if (rows.length === 1) return decision;
    if (decision.status === "pass" || decision.status === "bounce" || decision.status === "escalate") {
      return { ...decision, receipt: rows };
    }
    if (decision.status === "received") {
      return { ...decision, reply: rows };
    }
    return decision;
  }
  // Unknown terminal kind: still not a shape judgment — surface as received reply.
  return {
    status: "received",
    reply: outcome,
    ...(usage === undefined ? {} : { usage }),
  };
}

export async function runComplianceAudit(options: RunComplianceAuditOptions): Promise<ComplianceDecision> {
  const runDirectory = options.runDirectory ?? auditorRunDirectory(options.context);
  if (runDirectory === undefined) {
    throw new Error("Compliance audit requires a parent run directory pointer");
  }
  const subject = options.subject;
  const summon =
    options.summonAuditor
    ?? (async (
      auditSubject: AuditorSoulRole,
      sourceRunDirectory: string,
      auditSignal?: AbortSignal,
      reask?: string,
    ) => {
      // Dynamic import avoids compliance ↔ public-cli circular init (TDZ).
      const { summonPublicRole } = await import("./public-role-summons.ts");
      const { homeFromRunDirectory } = await import("./activation-ledger-topology.ts");
      const home = homeFromRunDirectory(sourceRunDirectory);
      // Same input surface as direct `ak-role auditor --subject … --source-run …`
      // (no ambient env binding for nested-only source).
      return await summonPublicRole({
        role: "auditor",
        argv: [
          "--subject",
          auditSubject,
          "--source-run",
          sourceRunDirectory,
          `${AUDITOR_DOSSIER_PROMPT}${sourceRunDirectory}`,
        ],
        cwd: options.context.cwd ?? process.cwd(),
        home,
        ...(auditSignal === undefined ? {} : { signal: auditSignal }),
        ...(reask === undefined ? {} : { reviewReask: reask }),
      });
    });
  let reask: string | undefined;
  for (;;) {
    // Durable parent-attempt binding is a prerequisite for later retention
    // recovery across same-court resume (#840 / #858). courtAttemptId rides the
    // existing Host court identity — never a parallel resume marker.
    persistAuditorParentAttemptBinding({ context: options.context });
    const summoned = await summon(subject, runDirectory, options.signal, reask);
    const decision = await projectAuditorTerminal(summoned);
    if (decision.status === "received") {
      reask = OFFICER_CONCLUSION_REASK;
      continue;
    }
    if (decision.status === "transport_failure") {
      const outcome =
        summoned.terminal?.roleOutcome !== undefined &&
        typeof summoned.terminal.roleOutcome === "object" &&
        summoned.terminal.roleOutcome !== null &&
        (summoned.terminal.roleOutcome as { kind?: unknown }).kind === "failure"
          ? (summoned.terminal.roleOutcome as {
              readonly cause?: string;
              readonly diagnostic: string;
              readonly decisiveFacts?: Readonly<Record<string, unknown>>;
            })
          : undefined;
      const facts = outcome?.decisiveFacts;
      const identity =
        facts !== undefined && typeof facts === "object" && isRecord(facts.identity)
          ? {
              ...(typeof facts.identity.name === "string"
                ? { name: facts.identity.name }
                : {}),
              ...(typeof facts.identity.code === "string" ||
                typeof facts.identity.code === "number"
                ? { code: facts.identity.code }
                : {}),
            }
          : undefined;
      const details =
        facts !== undefined && isRecord(facts.details)
          ? facts.details
          : facts !== undefined
            ? (Object.fromEntries(
                Object.entries(facts).filter(([key]) => key !== "identity"),
              ) as Readonly<Record<string, unknown>>)
            : undefined;
      persistAuditorParentAttemptBinding({
        context: options.context,
        failure: {
          ...(typeof outcome?.cause === "string" ? { cause: outcome.cause } : { cause: "provider" }),
          diagnostic: decision.diagnostic,
          ...(identity === undefined || Object.keys(identity).length === 0
            ? {}
            : { identity }),
          ...(details === undefined ? {} : { details }),
        },
      });
    }
    return decision;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
