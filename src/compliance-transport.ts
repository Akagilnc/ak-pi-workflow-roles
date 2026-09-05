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

export type AuditorSummon = (sourceRunDirectory: string) => Promise<PublicSummonResult>;

/** Offline-test hook key — globalThis so extension/test share one inject (no dual-module). */
const TEST_AUDITOR_SUMMON = Symbol.for("ak-roles.test-auditor-summon");

/**
 * Install or clear the offline auditor summon hook (tests only).
 * Returns a restore function that puts back the previous hook.
 */
export function setTestAuditorSummon(summon: AuditorSummon | undefined): () => void {
  const slot = globalThis as Record<symbol, AuditorSummon | undefined>;
  const previous = slot[TEST_AUDITOR_SUMMON];
  slot[TEST_AUDITOR_SUMMON] = summon;
  return () => {
    slot[TEST_AUDITOR_SUMMON] = previous;
  };
}

function testAuditorSummon(): AuditorSummon | undefined {
  return (globalThis as Record<symbol, AuditorSummon | undefined>)[TEST_AUDITOR_SUMMON];
}

export type RunComplianceAuditOptions = {
  /** @deprecated retained for call-site compatibility; public auditor owns its tool. */
  tool?: ReturnType<typeof createComplianceDecisionTool>;
  /** @deprecated retained for call-site compatibility; public auditor owns its soul. */
  systemPrompt?: string;
  /** @deprecated Fixer-lane hand-delivery only (#242 retires). Prefer omitting for zero-projection auditors. */
  serializedInput?: string;
  roleLabel?: string;
  invalidDecisionLabel?: string;
  context: HostContext;
  /** Exact machine-owned run binding; never sourced from AK_ROLE_RUN_DIR. */
  runDirectory?: string | undefined;
  signal?: AbortSignal;
  /**
   * Test seam for public-role summons. Production calls the shared public
   * activation path (#675).
   */
  summonAuditor?: AuditorSummon;
};

/** Sum nested public auditor session usage onto the parent no-receipt face (#675). */
async function usageFromSummonedAuditorSession(
  summoned: PublicSummonResult,
): Promise<Usage | undefined> {
  const runId = summoned.terminal?.runId;
  if (typeof runId !== "string" || runId.trim() === "") return undefined;
  const artifact = summoned.terminal?.artifacts?.find((item) => item.kind === "evidence" || item.kind === "error");
  // Prefer session beside any artifact path; else scan decisive runPointer facts.
  let sessionFile: string | undefined;
  for (const item of summoned.terminal?.artifacts ?? []) {
    if (typeof item.path === "string" && item.path.includes(`${runId}@`)) {
      const { join, dirname } = await import("node:path");
      sessionFile = join(dirname(dirname(item.path)), "session", "session.jsonl");
      break;
    }
  }
  if (sessionFile === undefined) {
    const pointer = (summoned.terminal?.roleOutcome as { runPointer?: unknown } | undefined)?.runPointer;
    if (typeof pointer === "string" && pointer.trim() !== "") {
      const { join } = await import("node:path");
      sessionFile = join(pointer, "session", "session.jsonl");
    }
  }
  if (sessionFile === undefined) return undefined;
  const { readFile } = await import("node:fs/promises");
  let text: string;
  try {
    text = await readFile(sessionFile, "utf8");
  } catch (error) {
    // Missing session is "no usage"; I/O/permission failures stay loud.
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw error;
  }
  let rows: Array<{ type?: string; message?: { role?: string; usage?: Usage } }>;
  try {
    rows = text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        type?: string;
        message?: { role?: string; usage?: Usage };
      });
  } catch (error) {
    throw new Error(
      `nested auditor session usage parse failed (${sessionFile}): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let total = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const row of rows) {
    if (row.type !== "message" || row.message?.role !== "assistant") continue;
    const usage = row.message.usage;
    if (usage === undefined) continue;
    total += usage.totalTokens ?? 0;
    input += usage.input ?? 0;
    output += usage.output ?? 0;
    cacheRead += usage.cacheRead ?? 0;
    cacheWrite += usage.cacheWrite ?? 0;
  }
  if (total <= 0 && input <= 0 && output <= 0) return undefined;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: total > 0 ? total : input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

async function projectAuditorTerminal(summoned: PublicSummonResult): Promise<ComplianceDecision> {
  const outcome = summoned.terminal?.roleOutcome;
  if (outcome === undefined) {
    throw new Error(`Auditor public summon produced no terminal (exit ${summoned.exitCode})`);
  }
  if (outcome.kind === "no_receipt") {
    const { status: _ignored, kind: _kind, role: _role, decisiveFacts: _facts, ...facts } = outcome;
    const usage = await usageFromSummonedAuditorSession(summoned);
    return {
      status: "no-receipt",
      ...facts,
      ...(usage === undefined ? {} : { usage }),
    };
  }
  if (outcome.kind === "failure") {
    // Preserve sealed candidate on the failure channel (#475 / #675): parent Judge
    // secondaryEvidence needs observation+candidate, not a bare diagnostic string.
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
      );
    }
    throw new Error(outcome.diagnostic);
  }
  if (outcome.kind === "accepted") {
    return readComplianceCandidate({
      status: outcome.status,
      ...outcome.decisiveFacts,
    });
  }
  throw new Error("Auditor public summon returned unusable terminal kind");
}

export async function runComplianceAudit(options: RunComplianceAuditOptions): Promise<ComplianceDecision> {
  const runDirectory = options.runDirectory ?? auditorRunDirectory(options.context);
  if (runDirectory === undefined) {
    throw new Error("Compliance audit requires a parent run directory pointer");
  }
  const prompt = options.serializedInput ?? AUDITOR_DOSSIER_PROMPT;
  const summon =
    options.summonAuditor
    ?? testAuditorSummon()
    ?? (async (sourceRunDirectory: string) => {
      // Dynamic import avoids compliance ↔ public-cli circular init (TDZ).
      const { summonPublicRole } = await import("./public-role-summons.ts");
      let home: string | undefined;
      try {
        const { homeFromRunDirectory } = await import("./activation-ledger-topology.ts");
        home = homeFromRunDirectory(sourceRunDirectory);
      } catch {
        // resolveSummonHome falls back.
      }
      // Publish source-run for public auditor dossier tool registration (#675).
      // Scoped to this summon only — never leave a cross-run env residue.
      const priorSource = process.env.AK_ROLE_AUDITOR_SOURCE_RUN;
      process.env.AK_ROLE_AUDITOR_SOURCE_RUN = sourceRunDirectory;
      try {
        return await summonPublicRole({
          role: "auditor",
          argv: [`卷宗指针：${sourceRunDirectory}\n${prompt}`],
          cwd: options.context.cwd ?? process.cwd(),
          ...(home === undefined ? {} : { home }),
        });
      } finally {
        if (priorSource === undefined) delete process.env.AK_ROLE_AUDITOR_SOURCE_RUN;
        else process.env.AK_ROLE_AUDITOR_SOURCE_RUN = priorSource;
      }
    });
  const summoned = await summon(runDirectory);
  return await projectAuditorTerminal(summoned);
}
