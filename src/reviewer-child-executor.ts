import { auditorRunDirectory } from "./auditor-dossier-tool.ts";
import type { HostContext } from "./host-contracts.ts";
import type { AcceptedReviewerLeg } from "./reviewer-dispatch.ts";
import type { PublicSummonResult } from "./public-role-summons.ts";
import type { ReviewerPromptText } from "./reviewer-prompt-identity.ts";
import type { Usage } from "@earendil-works/pi-ai";

export type EvidenceChildSummon = (argv: readonly string[]) => Promise<PublicSummonResult>;

/** Offline-test hook for public evidence-child summons; production leaves this undefined. */
let testEvidenceChildSummon: EvidenceChildSummon | undefined;

/** Install or clear the offline evidence-child summon hook (tests only). */
export function setTestEvidenceChildSummon(summon: EvidenceChildSummon | undefined): void {
  testEvidenceChildSummon = summon;
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
      evidenceChildFailure: "provider" as const,
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

/** Reviewer evidence leg via the public evidence-child activation path (#675). */
export async function executeReviewerChild(
  workspace: string,
  leg: AcceptedReviewerLeg,
  context: HostContext,
  options: ReviewerChildExecuteOptions = {},
): Promise<{ report: string; usage: Usage; prompt: ReviewerPromptText }> {
  try {
    const runDirectory = options.runDirectory ?? auditorRunDirectory(context);
    const pointer =
      runDirectory === undefined
        ? ""
        : `\n卷宗指针：${runDirectory}`;
    const argv = [`${String(leg.prompt)}${pointer}`];
    const summon =
      options.summonEvidenceChild
      ?? testEvidenceChildSummon
      ?? (async (nextArgv: readonly string[]) => {
        const { summonPublicRole } = await import("./public-role-summons.ts");
        return summonPublicRole({
          role: "evidence-child",
          argv: nextArgv,
          cwd: workspace,
        });
      });
    const summoned = await summon(argv);
    const report = reportFromSummon(summoned);
    return { report, usage: emptyUsage(), prompt: leg.prompt };
  } catch (error) {
    throw projectSharedChildFailure(error);
  }
}
