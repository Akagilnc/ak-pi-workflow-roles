/**
 * 起居郎 pipeline step — ADR 0075 / #582.
 * Not a public seat: no soul, no locator, no gate attendance.
 * Runs as the court-pipeline station before countersign turn.
 */
import {
  blockToLlmEntry,
  blockToPrescreenEntry,
  buildDiaristAnchors,
  mechanicalCandidatePipeline,
  readCcSessionBlocks,
  type DiaristAnchorSet,
  type DiaristSourceBlock,
} from "./diarist-mechanical.ts";
import {
  createHermesDiaristCollector,
  type DiaristLlmCollector,
  type DiaristLlmCollectResult,
} from "./diarist-llm-collector.ts";
import {
  appendTicketProvenanceEntry,
  readTicketProvenance,
  writeTicketProvenanceHumanView,
} from "./ticket-provenance.ts";
import type { TicketProvenanceEntry } from "./ticket-provenance-contracts.ts";
import type { RecordPointer } from "./sitian-contracts.ts";

export type DiaristRunInput = {
  readonly ticketNumber: number;
  readonly cwd: string;
  /** Ticket face body for anchor extraction (「」 quotes). */
  readonly ticketBody?: string;
  /** Extra cwd roots whose cc project folders are scanned. */
  readonly sessionCwds?: readonly string[];
  /** Override Claude projects root (tests). */
  readonly projectsRoot?: string;
  /** Pre-loaded source blocks (tests / alternate sources). */
  readonly blocks?: readonly DiaristSourceBlock[];
  /** Injected collector; default = hermes. `null` = mechanical-only. */
  readonly collector?: DiaristLlmCollector | null;
  readonly signal?: AbortSignal;
  /**
   * When true (default), LLM-selected blocks are the only diary entries.
   * Mechanical candidates alone never become production relevance.
   * On collector failure/absence, volume is left unchanged (honest empty/stale).
   */
  readonly llmRequired?: boolean;
};

export type DiaristRunResult = {
  readonly ticketNumber: number;
  readonly candidateCount: number;
  readonly appended: number;
  readonly rejectedQuotes: number;
  readonly pointers: readonly RecordPointer[];
  readonly entries: readonly TicketProvenanceEntry[];
  readonly humanViewFile?: string;
  readonly collectorStatus:
    | "ok"
    | "skipped-no-collector"
    | "failed"
    | "empty-selection";
  readonly collectorError?: string;
  readonly llmRawStdout?: string;
};

async function loadSourceBlocks(input: DiaristRunInput): Promise<DiaristSourceBlock[]> {
  if (input.blocks !== undefined) return [...input.blocks];
  const cwds = input.sessionCwds ?? [input.cwd];
  return readCcSessionBlocks({
    cwds,
    ...(input.projectsRoot === undefined ? {} : { projectsRoot: input.projectsRoot }),
  });
}

/**
 * Run one diarist pass for a ticket: mechanical candidates → LLM collect →
 * reverse-verify → idempotent sitian append → human view refresh.
 */
export async function runDiarist(input: DiaristRunInput): Promise<DiaristRunResult> {
  const anchors: DiaristAnchorSet = buildDiaristAnchors({
    ticketNumber: input.ticketNumber,
    ...(input.ticketBody === undefined ? {} : { ticketBody: input.ticketBody }),
  });
  const rawBlocks = await loadSourceBlocks(input);
  const candidates = mechanicalCandidatePipeline(rawBlocks, anchors);

  const llmRequired = input.llmRequired !== false;
  let collectorStatus: DiaristRunResult["collectorStatus"] = "skipped-no-collector";
  let collectorError: string | undefined;
  let llmRawStdout: string | undefined;
  let collect: DiaristLlmCollectResult | undefined;

  const collector =
    input.collector === null
      ? undefined
      : input.collector === undefined
        ? createHermesDiaristCollector({ cwd: input.cwd })
        : input.collector;

  if (collector !== undefined) {
    try {
      collect = await collector({
        ticketNumber: input.ticketNumber,
        candidates,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      llmRawStdout = collect.rawStdout;
      collectorStatus =
        collect.selections.length === 0 ? "empty-selection" : "ok";
    } catch (error) {
      collectorStatus = "failed";
      collectorError =
        error instanceof Error ? error.message : String(error);
    }
  }

  const pointers: RecordPointer[] = [];
  const accepted: TicketProvenanceEntry[] = [];
  let rejectedQuotes = 0;

  if (collect !== undefined && collectorStatus === "ok") {
    for (const selection of collect.selections) {
      // Human-face irrelevant labels are not machine gates; still, skip them
      // so the volume stays decision-focused (collector asked to omit them).
      if (selection.triage === "irrelevant") continue;
      const block = candidates[selection.candidateIndex];
      if (block === undefined) continue;
      const projected = blockToLlmEntry(block, {
        anchors,
        quotes: selection.quotes,
        ...(selection.note === undefined ? {} : { note: selection.note }),
      });
      if (!projected.ok) {
        rejectedQuotes += 1;
        // Honest diagnostic residue — not a reader-facing diary entry.
        const ptr = appendTicketProvenanceEntry({
          ticketNumber: input.ticketNumber,
          cwd: input.cwd,
          entry: projected.diagnostic,
          source: "diarist-quote-verify",
        });
        pointers.push(ptr);
        continue;
      }
      const ptr = appendTicketProvenanceEntry({
        ticketNumber: input.ticketNumber,
        cwd: input.cwd,
        entry: projected.entry,
        source: "diarist",
      });
      pointers.push(ptr);
      accepted.push(projected.entry);
    }
  } else if (!llmRequired && collector === undefined) {
    // Explicit mechanical-only mode (tests / offline). Not production default.
    for (const block of candidates) {
      if (!block.isUserTurn) continue;
      const entry = blockToPrescreenEntry(block, anchors);
      const ptr = appendTicketProvenanceEntry({
        ticketNumber: input.ticketNumber,
        cwd: input.cwd,
        entry,
        source: "diarist-mechanical-only",
      });
      pointers.push(ptr);
      accepted.push(entry);
    }
  }

  // Refresh human view from the full volume (includes prior court runs).
  const volume = await readTicketProvenance(input.ticketNumber, input.cwd);
  let humanViewFile: string | undefined;
  if (volume.entries.length > 0 || accepted.length > 0) {
    humanViewFile = writeTicketProvenanceHumanView({
      ticketNumber: input.ticketNumber,
      cwd: input.cwd,
      entries: volume.entries,
    });
  }

  return {
    ticketNumber: input.ticketNumber,
    candidateCount: candidates.length,
    appended: accepted.length,
    rejectedQuotes,
    pointers,
    entries: volume.entries,
    ...(humanViewFile === undefined ? {} : { humanViewFile }),
    collectorStatus,
    ...(collectorError === undefined ? {} : { collectorError }),
    ...(llmRawStdout === undefined ? {} : { llmRawStdout }),
  };
}
