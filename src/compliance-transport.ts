import type { Usage } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { auditorRunDirectory } from "./auditor-dossier-tool.ts";
import type { DossierObservation } from "./dossier-resolution.ts";
import type { HostContext } from "./host-contracts.ts";
import type { NoReceiptLifecycleFacts } from "./receipt-delivery-policy.ts";
import type { PublicSummonResult } from "./public-role-summons.ts";

export type ComplianceArgumentRootType = "null" | "array" | "undefined" | "string" | "number" | "boolean" | "bigint" | "symbol" | "function";
export type ComplianceAuditObservation =
  | { kind: "non-object-arguments"; type: ComplianceArgumentRootType }
  | { kind: "object-status-unreadable"; status: "missing" | "unknown" }
  | DossierObservation;
export type ComplianceNoReceipt = NoReceiptLifecycleFacts & { status: "no-receipt"; usage?: Usage };
export type ComplianceDecision = { status: "pass"; usage?: Usage } | { status: "revise"; violations: readonly unknown[]; usage?: Usage } | { status: "escalate"; conflicts?: unknown; decisionGate?: unknown; usage?: Usage } | ComplianceNoReceipt;

/** Unreadable compliance candidate — infrastructure failure, not a judgment status (#475). */
export class ComplianceCandidateUnreadableError extends Error {
  readonly observation: ComplianceAuditObservation;
  readonly candidate: unknown;
  readonly usage?: Usage;
  constructor(observation: ComplianceAuditObservation, candidate: unknown, usage?: Usage) {
    const detail =
      observation.kind === "non-object-arguments"
        ? `${observation.kind}:${observation.type}`
        : observation.kind === "object-status-unreadable"
          ? `${observation.kind}:${observation.status}`
          : observation.kind === "missing-subject"
            ? `${observation.kind}:${observation.subject}`
            : observation.kind;
    super(`Compliance candidate unreadable: ${detail}`);
    this.name = "ComplianceCandidateUnreadableError";
    this.observation = observation;
    this.candidate = candidate;
    if (usage !== undefined) this.usage = usage;
  }
}
/** Zero-projection kickoff — soul already carries dossier-fetch duty; no hand-delivered materials. */
export const AUDITOR_DOSSIER_PROMPT = "本 run 卷宗已就绪。" as const;

/** Nesting guard: nested public judge/doctor must not re-enter compliance (#675). */
export const AK_ROLE_COMPLIANCE_NESTING_ENV = "AK_ROLE_COMPLIANCE_NESTING" as const;

const nonblank = Type.String({ minLength: 1, pattern: "\\S" });
const decisionGateSchema = Type.Object({ question: nonblank, options: Type.Array(nonblank, { minItems: 1 }) }, { additionalProperties: false });
// Transport retains malformed candidates on ComplianceCandidateUnreadableError so
// the existing failure channel can publish observation + candidate (#475).
// Status values are guidance, not a schema gate.
export const complianceDecisionSchema = Type.Object({ status: Type.Unknown({ description: "pass | revise | escalate — 形状指引，非 schema 闸" }), violations: Type.Array(nonblank, { description: "观察到的合规违规" }), conflicts: Type.Array(nonblank, { description: "未决权威或执行冲突" }), decisionGate: Type.Union([decisionGateSchema, Type.Null()], { description: "升级问题与可选选项" }) }, { additionalProperties: true, required: [] });

export function createComplianceDecisionTool(name: string, description: string) {
  return { name, description, parameters: complianceDecisionSchema, async execute(_id: string, params: unknown): Promise<AgentToolResult<unknown>> { return { content: [{ type: "text", text: "审计决议已收" }], details: params, terminate: true }; } };
}

export const COMPLIANCE_RESPONSE_ENTRY_TYPE = "ak_compliance_response" as const;
export const AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE = "ak_auditor_parent_attempt_binding" as const;
export const AUDITOR_COMPLIANCE_FAILURE_ENTRY_TYPE = "ak_auditor_compliance_failure" as const;

/** Retention failure on the parent books — infrastructure, not a judgment status. */
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
  };
};

function readListField(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : value === undefined ? [] : [value]; }
export function readComplianceCandidate(arguments_: unknown, usage?: Usage): ComplianceDecision {
  if (typeof arguments_ !== "object" || arguments_ === null || Array.isArray(arguments_)) {
    throw new ComplianceCandidateUnreadableError(
      { kind: "non-object-arguments", type: arguments_ === null ? "null" : Array.isArray(arguments_) ? "array" : typeof arguments_ as ComplianceArgumentRootType },
      arguments_,
      usage,
    );
  }
  const args = arguments_ as Record<string, unknown>; const status = args.status;
  if (status === "pass") return { status, ...(usage === undefined ? {} : { usage }) };
  if (status === "revise") return { status, violations: readListField(args.violations), ...(usage === undefined ? {} : { usage }) };
  if (status === "escalate") return { status, ...(Object.hasOwn(args, "conflicts") ? { conflicts: args.conflicts } : {}), ...(Object.hasOwn(args, "decisionGate") ? { decisionGate: args.decisionGate } : {}), ...(usage === undefined ? {} : { usage }) };
  throw new ComplianceCandidateUnreadableError(
    { kind: "object-status-unreadable", status: status === undefined ? "missing" : "unknown" },
    arguments_,
    usage,
  );
}

/** Compliance line = which public role is summoned (same path as direct call). */
export type ComplianceLine = "judge" | "doctor";

export type ComplianceRoleSummon = (
  line: ComplianceLine,
  sourceRunDirectory: string,
) => Promise<PublicSummonResult>;

export type RunComplianceAuditOptions = {
  /** Which public role to summon — judge or doctor, never a substitute auditor seat. */
  readonly line: ComplianceLine;
  /** @deprecated Fixer-lane hand-delivery only (#242 retires). Prefer omitting for zero-projection auditors. */
  serializedInput?: string;
  context: HostContext;
  /** Exact machine-owned run binding; never sourced from AK_ROLE_RUN_DIR. */
  runDirectory?: string | undefined;
  signal?: AbortSignal;
  /**
   * Test seam for public-role summons. Production calls the shared public
   * activation path (#675).
   */
  summonRole?: ComplianceRoleSummon;
};

async function usageFromSummonedSession(summoned: PublicSummonResult): Promise<Usage | undefined> {
  const { usageFromPublicSummon } = await import("./session-assistant-usage.ts");
  return usageFromPublicSummon(summoned);
}

/**
 * Project a nested public judge/doctor terminal onto the compliance face.
 * Judge: converged→pass, continue→revise, escalate→escalate.
 * Doctor: completed→pass, refused→revise; escalate if present.
 */
function projectRoleTerminalToCompliance(
  line: ComplianceLine,
  summoned: PublicSummonResult,
  usage: Usage | undefined,
): ComplianceDecision {
  const outcome = summoned.terminal?.roleOutcome;
  if (outcome === undefined) {
    throw new Error(`${line} public summon produced no terminal (exit ${summoned.exitCode})`);
  }
  if (outcome.kind === "no_receipt") {
    const { status: _ignored, kind: _kind, role: _role, decisiveFacts: _facts, ...facts } = outcome;
    return {
      status: "no-receipt",
      ...facts,
      ...(usage === undefined ? {} : { usage }),
    };
  }
  if (outcome.kind === "failure") {
    const facts = outcome.decisiveFacts as Record<string, unknown> | undefined;
    const secondary =
      facts !== undefined
      && typeof facts.secondaryEvidence === "object"
      && facts.secondaryEvidence !== null
        ? (facts.secondaryEvidence as Record<string, unknown>)
        : undefined;
    const candidate =
      facts !== undefined && Object.hasOwn(facts, "candidate")
        ? facts.candidate
        : secondary !== undefined && Object.hasOwn(secondary, "candidate")
          ? secondary.candidate
          : undefined;
    if (candidate !== undefined) {
      const status =
        typeof candidate === "object"
        && candidate !== null
        && !Array.isArray(candidate)
        && Object.hasOwn(candidate as object, "status")
          ? (candidate as { status: unknown }).status
          : undefined;
      throw new ComplianceCandidateUnreadableError(
        {
          kind: "object-status-unreadable",
          status: status === undefined ? "missing" : "unknown",
        },
        candidate,
        usage,
      );
    }
    throw new Error(outcome.diagnostic);
  }
  if (outcome.kind === "accepted") {
    const facts = outcome.decisiveFacts;
    const rawStatus =
      typeof outcome.status === "string" && outcome.status.trim() !== ""
        ? outcome.status.trim()
        : typeof facts.status === "string"
          ? facts.status
          : typeof facts.judgeStatus === "string"
            ? facts.judgeStatus
            : undefined;
    if (line === "judge") {
      if (rawStatus === "converged" || rawStatus === "pass") {
        return { status: "pass", ...(usage === undefined ? {} : { usage }) };
      }
      if (rawStatus === "continue" || rawStatus === "revise") {
        const violations = readListField(
          facts.violations ?? facts.classes ?? facts.fixSummary ?? facts.report,
        );
        return { status: "revise", violations, ...(usage === undefined ? {} : { usage }) };
      }
      if (rawStatus === "escalate") {
        const decisionGate =
          facts.decisionGate
          ?? (typeof facts.decisionQuestion === "string"
            ? {
                question: facts.decisionQuestion,
                options: Array.isArray(facts.decisionOptions) ? facts.decisionOptions : [],
              }
            : undefined);
        return {
          status: "escalate",
          ...(Object.hasOwn(facts, "conflicts") ? { conflicts: facts.conflicts } : {}),
          ...(decisionGate !== undefined ? { decisionGate } : {}),
          ...(usage === undefined ? {} : { usage }),
        };
      }
    }
    if (line === "doctor") {
      if (rawStatus === "completed" || rawStatus === "pass") {
        return { status: "pass", ...(usage === undefined ? {} : { usage }) };
      }
      if (rawStatus === "refused" || rawStatus === "revise") {
        return {
          status: "revise",
          violations: readListField(facts.violations ?? facts.findings ?? facts.report),
          ...(usage === undefined ? {} : { usage }),
        };
      }
      if (rawStatus === "escalate") {
        return {
          status: "escalate",
          ...(Object.hasOwn(facts, "conflicts") ? { conflicts: facts.conflicts } : {}),
          ...(Object.hasOwn(facts, "decisionGate") ? { decisionGate: facts.decisionGate } : {}),
          ...(usage === undefined ? {} : { usage }),
        };
      }
    }
    // Unreadable role status — retain candidate for parent failure channel (ADR 0055).
    throw new ComplianceCandidateUnreadableError(
      {
        kind: "object-status-unreadable",
        status: rawStatus === undefined ? "missing" : "unknown",
      },
      { status: rawStatus, ...facts },
      usage,
    );
  }
  throw new Error(`${line} public summon returned unusable terminal kind`);
}

export async function runComplianceAudit(options: RunComplianceAuditOptions): Promise<ComplianceDecision> {
  // Nested public judge/doctor must not re-enter compliance (recursion guard).
  if (process.env[AK_ROLE_COMPLIANCE_NESTING_ENV] === "1") {
    return { status: "pass" };
  }
  const runDirectory = options.runDirectory ?? auditorRunDirectory(options.context);
  if (runDirectory === undefined) {
    throw new Error("Compliance audit requires a parent run directory pointer");
  }
  const prompt = options.serializedInput ?? AUDITOR_DOSSIER_PROMPT;
  const summon =
    options.summonRole
    ?? (async (line: ComplianceLine, sourceRunDirectory: string) => {
      const { summonPublicRole } = await import("./public-role-summons.ts");
      const { homeFromRunDirectory } = await import("./activation-ledger-topology.ts");
      const home = homeFromRunDirectory(sourceRunDirectory);
      const pointerPrompt = `卷宗指针：${sourceRunDirectory}\n${prompt}`;
      // Same public argv shape as direct ak-role <line> (judge instruction; doctor --issue/--runs).
      let argv: readonly string[];
      if (line === "doctor") {
        const normalized = sourceRunDirectory.replace(/\\/g, "/");
        const issuesMatch = /\/issues\/([1-9]\d*)\/runs(?:\/|$)/.exec(normalized);
        if (issuesMatch === null) {
          throw new Error("doctor compliance summon requires a run under books/.../issues/<n>/runs");
        }
        const issue = issuesMatch[1]!;
        // Prefix through ".../issues/<n>/runs".
        const runsPath = normalized.slice(0, issuesMatch.index! + issuesMatch[0].replace(/\/$/, "").length);
        argv = ["--issue", issue, "--runs", runsPath, pointerPrompt];
      } else {
        argv = [pointerPrompt];
      }
      return await summonPublicRole({
        role: line,
        argv,
        cwd: options.context.cwd ?? process.cwd(),
        home,
      });
    });
  const priorNesting = process.env[AK_ROLE_COMPLIANCE_NESTING_ENV];
  process.env[AK_ROLE_COMPLIANCE_NESTING_ENV] = "1";
  try {
    const summoned = await summon(options.line, runDirectory);
    const usage = await usageFromSummonedSession(summoned);
    return projectRoleTerminalToCompliance(options.line, summoned, usage);
  } finally {
    if (priorNesting === undefined) delete process.env[AK_ROLE_COMPLIANCE_NESTING_ENV];
    else process.env[AK_ROLE_COMPLIANCE_NESTING_ENV] = priorNesting;
  }
}
