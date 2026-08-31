/**
 * 起居郎 pipeline step — ADR 0075 / #582.
 * Not a public seat: no soul, no locator, no gate attendance.
 * Runs as the court-pipeline station before countersign turn.
 */
import { extractReferencedAdrPaths } from "./adr-path-refs.ts";
import {
  blockToLlmEntry,
  buildDiaristAnchors,
  mechanicalSafeguardPipeline,
  readAdrDecisionKeyBlocks,
  readCcSessionBlocks,
  readTicketFaceBlocks,
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
  ensureTicketProvenanceVolume,
  readOfferedIdentities,
  readTicketProvenance,
  recordOfferedIdentities,
  resolveTicketProvenanceVolume,
  ticketProvenanceEntryIdentity,
  writeDiaristStationDiagnostic,
  writeTicketProvenanceHumanView,
} from "./ticket-provenance.ts";
import type { TicketProvenanceEntry } from "./ticket-provenance-contracts.ts";
import { readSitianRecords, type RecordPointer } from "./sitian-facade.ts";

export type DiaristRunInput = {
  readonly ticketNumber: number;
  readonly cwd: string;
  /** Ticket face body for face/decree/ADR source blocks + anchor extraction. */
  readonly ticketBody?: string;
  /** Provenance path for the ticket face (frozen attachment path). */
  readonly ticketBodyPath?: string;
  /** Extra cwd roots whose cc project folders are scanned. */
  readonly sessionCwds?: readonly string[];
  /** Override Claude projects root (tests). */
  readonly projectsRoot?: string;
  /** Pre-loaded source blocks (tests / alternate sources). Skips enum. */
  readonly blocks?: readonly DiaristSourceBlock[];
  /** Injected collector; default = hermes. `null` = skip LLM (no mechanical-only fallback). */
  readonly collector?: DiaristLlmCollector | null;
  readonly signal?: AbortSignal;
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
  readonly humanViewFile: string;
  readonly volumeRecordFile: string;
  readonly stationDiagnosticFile: string;
  readonly collectorStatus:
    | "ok"
    | "skipped-no-collector"
    | "skipped-no-fresh"
    | "failed"
    | "empty-selection";
  readonly collectorError?: string;
  readonly llmRawStdout?: string;
};

/**
 * Identities already processed for this ticket:
 * - volume record identities (selected / verify-fail residue)
 * - offered watermark (blocks shown to collector, selected or not)
 */
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
  for (const identity of readOfferedIdentities(ticketNumber, cwd)) {
    seen.add(identity);
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

/**
 * Single typed candidate stream: cc sessions + ticket face/decree + referenced ADRs.
 * Mechanical layer does not prose-filter for relevance (锚定宪法).
 */
async function loadSourceBlocks(input: DiaristRunInput): Promise<DiaristSourceBlock[]> {
  if (input.blocks !== undefined) return [...input.blocks];
  const cwds = input.sessionCwds ?? [input.cwd];
  const blocks: DiaristSourceBlock[] = [
    ...readCcSessionBlocks({
      cwds,
      ...(input.projectsRoot === undefined ? {} : { projectsRoot: input.projectsRoot }),
    }),
  ];
  if (input.ticketBody !== undefined && input.ticketBody.trim() !== "") {
    blocks.push(
      ...readTicketFaceBlocks({
        ticketBody: input.ticketBody,
        ...(input.ticketBodyPath === undefined ? {} : { sourcePath: input.ticketBodyPath }),
      }),
    );
    const adrPaths = extractReferencedAdrPaths(input.ticketBody);
    if (adrPaths.length > 0) {
      blocks.push(
        ...readAdrDecisionKeyBlocks({
          cwd: input.cwd,
          adrPaths,
        }),
      );
    }
  }
  return blocks;
}

/**
 * Run one diarist pass for a ticket: mechanical candidates → LLM collect →
 * reverse-verify → idempotent sitian append → human view refresh.
 * Always establishes the per-ticket volume + md + station diagnostic.
 */
export async function runDiarist(input: DiaristRunInput): Promise<DiaristRunResult> {
  // Per-ticket volume exists for every bound court, including empty/fail paths.
  const volumePaths = ensureTicketProvenanceVolume(input.ticketNumber, input.cwd);

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
        // Successful collector pass (incl. empty selection): mark all offered
        // identities so unselected blocks are not re-sent next court. Failure
        // does not advance the watermark (retry honestly).
        recordOfferedIdentities({
          ticketNumber: input.ticketNumber,
          cwd: input.cwd,
          identities: fresh.map((block) =>
            blockEntryIdentity(input.ticketNumber, block),
          ),
        });
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

  // Only a successful collect (ok / empty-selection already branched) with
  // selections present can enter the volume. empty-selection has collect with [].
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
  }

  // Refresh human view from the full volume (includes prior court runs).
  // Always write — empty courts still get the md face next to the JSONL.
  const volume = await readTicketProvenance(input.ticketNumber, input.cwd);
  const humanViewFile = writeTicketProvenanceHumanView({
    ticketNumber: input.ticketNumber,
    cwd: input.cwd,
    entries: volume.entries,
  });

  const stationDiagnosticFile = writeDiaristStationDiagnostic({
    ticketNumber: input.ticketNumber,
    cwd: input.cwd,
    diagnostic: {
      ticketNumber: input.ticketNumber,
      collectorStatus,
      candidateCount: safeguarded.length,
      freshCount: fresh.length,
      appended: accepted.length,
      rejectedQuotes,
      ...(collectorError === undefined ? {} : { collectorError }),
      recordedAt: new Date().toISOString(),
    },
  });

  return {
    ticketNumber: input.ticketNumber,
    candidateCount: safeguarded.length,
    freshCount: fresh.length,
    appended: accepted.length,
    rejectedQuotes,
    pointers,
    entries: volume.entries,
    humanViewFile,
    volumeRecordFile: volumePaths.recordFile,
    stationDiagnosticFile,
    collectorStatus,
    ...(collectorError === undefined ? {} : { collectorError }),
    ...(llmRawStdout === undefined ? {} : { llmRawStdout }),
  };
}
