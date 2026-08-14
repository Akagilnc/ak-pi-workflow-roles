/**
 * A2 minimal example metric family — proves typed run facts + page registration.
 * B1 (or later) absorbs/replaces this probe; not a product metric.
 * Emits only seam witnesses (raw frame span / tool intervals / terminal face) —
 * no derived durations or aggregate metrics (ticket #334 零新指标).
 */
import type { SessionToolInterval } from "../ledger-session-read.ts";
import type { RunTerminalArtifactFile } from "../run-terminal-artifacts.ts";
import type { TaishiReadableRunFacts } from "../taishi-ledger.ts";
import type { TaishiMetricFamilyModule } from "../taishi-metric-family.ts";

export type TaishiA2SeamProbeTerminal =
  | { readonly status: "absent" }
  | {
      readonly status: "present";
      readonly file: RunTerminalArtifactFile;
      /** Producer-owned role already enforced by the terminal-face owner. */
      readonly role: string;
    };

export type TaishiA2SeamProbeRun = {
  readonly runId: string;
  readonly book: string;
  readonly role: string;
  readonly frameSpan: {
    readonly startedAt: string;
    readonly endedAt: string;
  };
  readonly toolIntervals: readonly SessionToolInterval[];
  readonly terminal: TaishiA2SeamProbeTerminal;
};

export type TaishiA2SeamProbeSection = {
  readonly kind: "taishi-a2-seam-probe";
  readonly runs: readonly TaishiA2SeamProbeRun[];
};

function projectTerminal(facts: TaishiReadableRunFacts): TaishiA2SeamProbeTerminal {
  if (facts.terminal.status === "absent") {
    return { status: "absent" };
  }
  // Single owner: readRunTerminalArtifact already required nonblank role
  // before classifyScopedRun retained a present face.
  return {
    status: "present",
    file: facts.terminal.file,
    role: facts.terminal.role,
  };
}

function projectRun(facts: TaishiReadableRunFacts): TaishiA2SeamProbeRun {
  return {
    runId: facts.runId,
    book: facts.book,
    role: facts.role,
    frameSpan: facts.frameSpan,
    toolIntervals: facts.toolIntervals,
    terminal: projectTerminal(facts),
  };
}

/** Discovered by taishi-metric-families loader (default export). */
const a2SeamProbeFamily: TaishiMetricFamilyModule = {
  id: "a2-seam-probe",
  contribute(input) {
    if (input.runs.length === 0) {
      // No readable runs — omit section rather than invent vacancy metrics.
      return undefined;
    }
    const runs = [...input.runs]
      .map(projectRun)
      .sort((a, b) => {
        if (a.book !== b.book) return a.book.localeCompare(b.book);
        if (a.role !== b.role) return a.role.localeCompare(b.role);
        return a.runId.localeCompare(b.runId);
      });
    const section: TaishiA2SeamProbeSection = {
      kind: "taishi-a2-seam-probe",
      runs,
    };
    return { a2SeamProbe: section };
  },
};

export default a2SeamProbeFamily;
