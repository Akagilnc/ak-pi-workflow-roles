/**
 * 起居郎 pipeline step — ADR 0075 / #582.
 * Not a public seat: no soul, no locator, no gate attendance.
 * Runs as the court-pipeline station before countersign turn.
 */
import {
  blockToLlmEntry,
  blockToPrescreenEntry,
  buildDiaristAnchors,
  mechanicalSafeguardPipeline,
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
  resolveTicketProvenanceVolume,
  ticketProvenanceEntryIdentity,
  writeTicketProvenanceHumanView,
} from "./ticket-provenance.ts";
import type { TicketProvenanceEntry } from "./ticket-provenance-contracts.ts";
import { readSitianRecords, type RecordPointer } from "./sitian-facade.ts";

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
  /** Safeguard-cleaned source count before incremental filter. */
  readonly candidateCount: number;
  /** Blocks not yet on the volume — sole set sent to the collector this court. */
  readonly freshCount: number;
  readonly appended: number;
  readonly rejectedQuotes: number;
  readonly pointers: readonly RecordPointer[];
  readonly entries: readonly TicketProvenanceEntry[];
  readonly humanViewFile?: string;
  readonly collectorStatus:
    | "ok"
    | "skipped-no-collector"
    | "skipped-no-fresh"
    | "failed"
    | "empty-selection";
  readonly collectorError?: string;
  readonly llmRawStdout?: string;
};

/** Identities already committed on the ticket volume (incl. verify-fail residue). */
async function loadSeenEntryIdentities(
  ticketNumber: number,
  cwd: string,
): Promise<ReadonlySet<string>> {
  const { recordFile } = resolveTicketProvenanceVolume(ticketNumber, cwd);
  const { records } = await readSitianRecords(recordFile);
  const seen = new Set<string>();
  for (const record of records) {
    if (typeof record.identity === "string" && record.identity.length > 0) {
      seen.add(record.identity);
    }
  }
  return seen;
}

function blockEntryIdentity(
  ticketNumber: number,
  block: DiaristSourceBlock,
): string {
  return ticketProvenanceEntryIdentity({
    ticketNumber,
    sourceKind: block.sourceKind,
    sourceRef: block.sourceRef,
    transcript: block.transcript,
  });
}

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
  // Safeguard only (notify filter + dedupe) — never prose-based exclusion.
  const safeguarded = mechanicalSafeguardPipeline(rawBlocks);
  // Incremental: only blocks whose entry identity is not yet on the volume
  // are offered to the collector (ADR 0075 refresh-every-court = 增量幂等).
  const seen = await loadSeenEntryIdentities(input.ticketNumber, input.cwd);
  const fresh = safeguarded.filter(
    (block) => !seen.has(blockEntryIdentity(input.ticketNumber, block)),
  );

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
    if (fresh.length === 0) {
      collectorStatus = "skipped-no-fresh";
    } else {
      try {
        collect = await collector({
          ticketNumber: input.ticketNumber,
          candidates: fresh,
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
  }

  const pointers: RecordPointer[] = [];
  const accepted: TicketProvenanceEntry[] = [];
  let rejectedQuotes = 0;

  if (collect !== undefined && collectorStatus === "ok") {
    for (const selection of collect.selections) {
      // triage is human-face only — never a machine gate (collector contract).
      // Inclusion is solely: selection present + quote reverse-verify pass.
      const block = fresh[selection.candidateIndex];
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
    for (const block of fresh) {
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
    candidateCount: safeguarded.length,
    freshCount: fresh.length,
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
