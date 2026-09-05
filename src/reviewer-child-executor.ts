import { auditorRunDirectory } from "./auditor-dossier-tool.ts";
import type { HostContext } from "./host-contracts.ts";
import type { AcceptedReviewerLeg } from "./reviewer-dispatch.ts";
import type { PublicSummonResult } from "./public-role-summons.ts";
import type { ReviewerPromptText } from "./reviewer-prompt-identity.ts";
import type { Usage } from "@earendil-works/pi-ai";

export type EvidenceChildSummon = (argv: readonly string[]) => Promise<PublicSummonResult>;

const TEST_EVIDENCE_CHILD_SUMMON = Symbol.for("ak-roles.test-evidence-child-summon");

/** Install or clear the offline evidence-child summon hook (tests only). */
export function setTestEvidenceChildSummon(summon: EvidenceChildSummon | undefined): () => void {
  const slot = globalThis as Record<symbol, EvidenceChildSummon | undefined>;
  const previous = slot[TEST_EVIDENCE_CHILD_SUMMON];
  slot[TEST_EVIDENCE_CHILD_SUMMON] = summon;
  return () => {
    slot[TEST_EVIDENCE_CHILD_SUMMON] = previous;
  };
}

function testEvidenceChildSummon(): EvidenceChildSummon | undefined {
  return (globalThis as Record<symbol, EvidenceChildSummon | undefined>)[TEST_EVIDENCE_CHILD_SUMMON];
}

export type ReviewerChildExecuteOptions = Readonly<{
  signal?: AbortSignal;
  credentialScratchParent?: string;
  /** Parent run directory pointer (ADR 0079). */
  runDirectory?: string;
  /** @deprecated engine rides the public seat table (#675); retained for call-site compatibility. */
  packageRoot?: string;
  /**
   * Test seam for public-role summons. Production calls the shared public
   * activation path (#675).
   */
  summonEvidenceChild?: EvidenceChildSummon;
}>;

/**
 * Single conversion at the Reviewer adapter boundary: shared child classifications
 * become Reviewer failure classifications without a second error taxonomy.
 */
export function projectSharedChildFailure(error: unknown): unknown {
  if (typeof error === "object" && error !== null && "evidenceChildFailure" in error) {
    const classification = (error as { evidenceChildFailure?: unknown }).evidenceChildFailure;
    if (classification === "provider" || classification === "child" || classification === "unknown") {
      Object.assign(error, { reviewerFailure: classification });
    }
  }
  return error;
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function failureClassification(
  cause: string | undefined,
): "provider" | "child" | "unknown" {
  if (cause === "provider") return "provider";
  if (
    cause === "output"
    || cause === "timeout"
    || cause === "activation"
    || cause === "session"
    || cause === "unrecognized"
  ) {
    return "child";
  }
  return "unknown";
}

function reportFromSummon(summoned: PublicSummonResult): string {
  const outcome = summoned.terminal?.roleOutcome;
  if (outcome === undefined) {
    throw Object.assign(
      new Error(`Evidence-child public summon produced no terminal (exit ${summoned.exitCode})`),
      { evidenceChildFailure: "child" as const },
    );
  }
  if (outcome.kind === "failure") {
    throw Object.assign(new Error(outcome.diagnostic), {
      evidenceChildFailure: failureClassification(outcome.cause),
    });
  }
  if (outcome.kind === "accepted") {
    const report = outcome.decisiveFacts.report;
    if (typeof report === "string" && report.trim() !== "") return report;
  }
  throw Object.assign(
    new Error("Evidence-child public summon returned no report body"),
    { evidenceChildFailure: "child" as const },
  );
}

async function usageFromSummonedEvidenceChild(summoned: PublicSummonResult): Promise<Usage> {
  const pointer = (summoned.terminal?.roleOutcome as { runPointer?: unknown } | undefined)?.runPointer;
  const sessionFile =
    typeof pointer === "string" && pointer.trim() !== ""
      ? (await import("node:path")).join(pointer, "session", "session.jsonl")
      : undefined;
  if (sessionFile === undefined) return emptyUsage();
  try {
    const { readFile } = await import("node:fs/promises");
    const rows = (await readFile(sessionFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        type?: string;
        message?: { role?: string; usage?: Usage };
      });
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
    if (total <= 0 && input <= 0 && output <= 0) return emptyUsage();
    return {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens: total > 0 ? total : input + output + cacheRead + cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return emptyUsage();
    throw error;
  }
}

/** Reviewer evidence leg via the public evidence-child activation path (#675). */
export async function executeReviewerChild(
  workspace: string,
  leg: AcceptedReviewerLeg,
  context: HostContext,
  options: ReviewerChildExecuteOptions = {},
): Promise<{ report: string; usage: Usage; prompt: ReviewerPromptText }> {
  try {
    if (options.signal?.aborted) {
      throw Object.assign(new DOMException("The operation was aborted.", "AbortError"), {
        evidenceChildFailure: "child" as const,
      });
    }
    const runDirectory = options.runDirectory ?? auditorRunDirectory(context);
    const pointer =
      runDirectory === undefined
        ? ""
        : `\n卷宗指针：${runDirectory}`;
    const argv = [`${String(leg.prompt)}${pointer}`];
    const summon =
      options.summonEvidenceChild
      ?? testEvidenceChildSummon()
      ?? (async (nextArgv: readonly string[]) => {
        const { summonPublicRole } = await import("./public-role-summons.ts");
        // Parent run home owns nested public seats; leg workspace cwd is a bare worktree.
        let home: string | undefined;
        if (runDirectory !== undefined) {
          try {
            const { homeFromRunDirectory } = await import("./activation-ledger-topology.ts");
            home = homeFromRunDirectory(runDirectory);
          } catch {
            // resolveSummonHome falls back from cwd/package machine home.
          }
        }
        return summonPublicRole({
          role: "evidence-child",
          argv: nextArgv,
          cwd: workspace,
          ...(home === undefined ? {} : { home }),
          ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
        });
      });
    const summoned = await summon(argv);
    if (options.signal?.aborted) {
      throw Object.assign(new DOMException("The operation was aborted.", "AbortError"), {
        evidenceChildFailure: "child" as const,
      });
    }
    const report = reportFromSummon(summoned);
    const usage = await usageFromSummonedEvidenceChild(summoned);
    return { report, usage, prompt: leg.prompt };
  } catch (error) {
    throw projectSharedChildFailure(error);
  }
}
