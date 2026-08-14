/**
 * A2 minimal example metric family — proves typed run facts + page registration.
 * B1 (or later) absorbs/replaces this probe; not a product metric.
 */
import type { SessionToolInterval } from "./ledger-session-read.ts";
import type { RunTerminalArtifactFile } from "./run-terminal-artifacts.ts";
import type { TaishiReadableRunFacts } from "./taishi-ledger.ts";
import { medianNumber } from "./taishi-median.ts";
import type { TaishiMetricFamilyModule } from "./taishi-metric-family.ts";

export type TaishiA2SeamProbeTerminal =
  | { readonly status: "absent" }
  | {
      readonly status: "present";
      readonly file: RunTerminalArtifactFile;
      /** Producer-owned role field from the typed terminal body (proves body face). */
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
  readonly frameSpanMs: number;
  readonly toolIntervals: readonly SessionToolInterval[];
  readonly terminal: TaishiA2SeamProbeTerminal;
};

export type TaishiA2SeamProbeSection = {
  readonly kind: "taishi-a2-seam-probe";
  readonly runs: readonly TaishiA2SeamProbeRun[];
  /** Even-sample mean of two middles when |runs| is even — shared median primitive. */
  readonly frameSpanMedianMs: number;
};

function frameSpanMs(facts: TaishiReadableRunFacts): number {
  return (
    Date.parse(facts.frameSpan.endedAt) - Date.parse(facts.frameSpan.startedAt)
  );
}

function projectTerminal(facts: TaishiReadableRunFacts): TaishiA2SeamProbeTerminal {
  if (facts.terminal.status === "absent") {
    return { status: "absent" };
  }
  const role = facts.terminal.body.role;
  if (typeof role !== "string" || role.trim() === "") {
    throw new Error(
      `a2 seam probe: present terminal missing producer role (${facts.runId})`,
    );
  }
  return {
    status: "present",
    file: facts.terminal.file,
    role,
  };
}

function projectRun(facts: TaishiReadableRunFacts): TaishiA2SeamProbeRun {
  return {
    runId: facts.runId,
    book: facts.book,
    role: facts.role,
    frameSpan: facts.frameSpan,
    frameSpanMs: frameSpanMs(facts),
    toolIntervals: facts.toolIntervals,
    terminal: projectTerminal(facts),
  };
}

export const a2SeamProbeFamily: TaishiMetricFamilyModule = {
  id: "a2-seam-probe",
  contribute(input) {
    const runs = [...input.runs]
      .map(projectRun)
      .sort((a, b) => {
        if (a.book !== b.book) return a.book.localeCompare(b.book);
        if (a.role !== b.role) return a.role.localeCompare(b.role);
        return a.runId.localeCompare(b.runId);
      });
    const frameSpanMedianMs = medianNumber(runs.map((run) => run.frameSpanMs));
    if (frameSpanMedianMs === undefined) {
      // No readable runs — omit section rather than invent vacancy metrics.
      return undefined;
    }
    const section: TaishiA2SeamProbeSection = {
      kind: "taishi-a2-seam-probe",
      runs,
      frameSpanMedianMs,
    };
    return { a2SeamProbe: section };
  },
};
