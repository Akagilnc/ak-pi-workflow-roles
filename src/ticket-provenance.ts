/**
 * 起居录 volume helpers — ADR 0075 / #582.
 * Write/read via sitian facade only; no parallel destination logic.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  resolveSitianRecordPath,
  sitianReport,
  readSitianRecords,
  type RecordPointer,
  type SitianRecord,
} from "./sitian-facade.ts";
import {
  TICKET_PROVENANCE_HUMAN_VIEW,
  TICKET_PROVENANCE_KIND,
  TICKET_PROVENANCE_OFFERED_WATERMARK,
  projectTicketProvenanceEntry,
  type TicketProvenanceEntry,
  type TicketProvenanceIdentityInput,
} from "./ticket-provenance-contracts.ts";

/** Subject string for ticket-keyed volumes — history follows the ticket. */
export function ticketProvenanceSubject(ticketNumber: number): string {
  if (!Number.isSafeInteger(ticketNumber) || ticketNumber < 1) {
    throw new Error(`ticket-provenance subject requires a positive ticket number, got ${String(ticketNumber)}`);
  }
  return String(ticketNumber);
}

/**
 * Deterministic entry identity for sitian entry-level idempotency.
 * Same ticket + source pointer + transcript → same identity → no re-append.
 */
export function ticketProvenanceEntryIdentity(
  input: TicketProvenanceIdentityInput,
): string {
  const ref = input.sourceRef;
  const refKey = [
    ref.sessionFile ?? "",
    ref.entryId === undefined ? "" : String(ref.entryId),
    ref.path ?? "",
    ref.url ?? "",
  ].join("\u0001");
  const material = [
    String(input.ticketNumber),
    input.sourceKind,
    refKey,
    input.transcript,
  ].join("\u0000");
  return createHash("sha256").update(material, "utf8").digest("hex");
}

export type AppendTicketProvenanceInput = {
  readonly ticketNumber: number;
  readonly entry: TicketProvenanceEntry;
  readonly cwd: string;
  readonly host?: string;
  readonly source?: string;
};

/** Append one transcribed block; returns existing pointer on identity hit. */
export function appendTicketProvenanceEntry(
  input: AppendTicketProvenanceInput,
): RecordPointer {
  const subject = ticketProvenanceSubject(input.ticketNumber);
  const identity = ticketProvenanceEntryIdentity({
    ticketNumber: input.ticketNumber,
    sourceKind: input.entry.sourceKind,
    sourceRef: input.entry.sourceRef,
    transcript: input.entry.transcript,
  });
  return sitianReport({
    level: "event",
    kind: TICKET_PROVENANCE_KIND,
    identity,
    subject,
    cwd: input.cwd,
    host: input.host ?? "diarist",
    source: input.source ?? "diarist",
    payload: input.entry,
    raw:
      input.entry.sourceRef.sessionFile !== undefined &&
      input.entry.sourceRef.entryId !== undefined
        ? {
            sessionFile: input.entry.sourceRef.sessionFile,
            entryId: input.entry.sourceRef.entryId,
          }
        : undefined,
  });
}

export type TicketProvenanceVolumePath = {
  readonly recordFile: string;
  readonly volumeDir: string;
  readonly humanViewFile: string;
  readonly offeredWatermarkFile: string;
};

/** Resolve volume paths for a ticket without writing. */
export function resolveTicketProvenanceVolume(
  ticketNumber: number,
  cwd: string,
): TicketProvenanceVolumePath {
  const path = resolveSitianRecordPath({
    level: "event",
    kind: TICKET_PROVENANCE_KIND,
    subject: ticketProvenanceSubject(ticketNumber),
    cwd,
  });
  return {
    recordFile: path.recordFile,
    volumeDir: path.sessionDir,
    humanViewFile: join(path.sessionDir, TICKET_PROVENANCE_HUMAN_VIEW),
    offeredWatermarkFile: join(path.sessionDir, TICKET_PROVENANCE_OFFERED_WATERMARK),
  };
}

/** Typed cause of an offered-identity watermark read failure. */
export type TicketProvenanceWatermarkReason =
  | "unreadable"
  | "malformed-json"
  | "bad-shape";

/** Honest failure when the offered-identity watermark cannot be read as written. */
export class TicketProvenanceWatermarkError extends Error {
  readonly code = "ticket-provenance-watermark" as const;
  readonly reason: TicketProvenanceWatermarkReason;
  constructor(
    reason: TicketProvenanceWatermarkReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TicketProvenanceWatermarkError";
    this.reason = reason;
  }
}

/**
 * Read identities already offered to the collector (append-only watermark).
 * Absent file → empty set. Any non-empty line that is not a JSON object with a
 * non-empty string `identity` throws TicketProvenanceWatermarkError (失败诚实：
 * never interpret corruption as "unseen" and silently re-offer).
 */
export function readOfferedIdentities(
  ticketNumber: number,
  cwd: string,
): ReadonlySet<string> {
  const { offeredWatermarkFile } = resolveTicketProvenanceVolume(ticketNumber, cwd);
  if (!existsSync(offeredWatermarkFile)) return new Set();
  let text: string;
  try {
    text = readFileSync(offeredWatermarkFile, "utf8");
  } catch (error) {
    throw new TicketProvenanceWatermarkError(
      "unreadable",
      `ticket-provenance offered watermark unreadable (${offeredWatermarkFile})`,
      { cause: error },
    );
  }
  const seen = new Set<string>();
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new TicketProvenanceWatermarkError(
        "malformed-json",
        `ticket-provenance offered watermark malformed JSON at line ${index + 1} (${offeredWatermarkFile})`,
        { cause: error },
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof (parsed as { identity?: unknown }).identity !== "string" ||
      (parsed as { identity: string }).identity.length === 0
    ) {
      throw new TicketProvenanceWatermarkError(
        "bad-shape",
        `ticket-provenance offered watermark bad shape at line ${index + 1} (${offeredWatermarkFile})`,
      );
    }
    seen.add((parsed as { identity: string }).identity);
  }
  return seen;
}

/**
 * Append offered identities after a successful collector pass (selected or not).
 * Idempotent per identity within the file (skip already-present). Creates volume
 * dir only when writing the first watermark row.
 */
export function recordOfferedIdentities(input: {
  readonly ticketNumber: number;
  readonly cwd: string;
  readonly identities: readonly string[];
}): void {
  if (input.identities.length === 0) return;
  const { volumeDir, offeredWatermarkFile } = resolveTicketProvenanceVolume(
    input.ticketNumber,
    input.cwd,
  );
  const already = new Set(readOfferedIdentities(input.ticketNumber, input.cwd));
  const rows: string[] = [];
  for (const identity of input.identities) {
    if (identity.length === 0 || already.has(identity)) continue;
    rows.push(`${JSON.stringify({ identity })}\n`);
    already.add(identity);
  }
  if (rows.length === 0) return;
  mkdirSync(volumeDir, { recursive: true });
  appendFileSync(offeredWatermarkFile, rows.join(""), "utf8");
}

export type ReadTicketProvenanceResult = {
  readonly entries: readonly TicketProvenanceEntry[];
  readonly records: readonly SitianRecord[];
  readonly recordFile: string;
  /** Rows whose payload failed entry projection (kept for honesty, not washed). */
  readonly skipped: number;
};

/** Read all projected diary entries for a ticket (empty when volume absent). */
export async function readTicketProvenance(
  ticketNumber: number,
  cwd: string,
): Promise<ReadTicketProvenanceResult> {
  const { recordFile } = resolveTicketProvenanceVolume(ticketNumber, cwd);
  const { records } = await readSitianRecords(recordFile);
  const entries: TicketProvenanceEntry[] = [];
  let skipped = 0;
  for (const record of records) {
    if (record.kind !== TICKET_PROVENANCE_KIND) {
      skipped += 1;
      continue;
    }
    const entry = projectTicketProvenanceEntry(record.payload);
    if (entry === undefined) {
      skipped += 1;
      continue;
    }
    // quote-verify-failed is diagnostic residue — not a readable diary entry.
    if (entry.basis.method === "quote-verify-failed") {
      skipped += 1;
      continue;
    }
    entries.push(entry);
  }
  return { entries, records, recordFile, skipped };
}

/**
 * Render a local human-read markdown view from entries.
 * Presentation only — machines bite JSONL. No wording lock for consumers.
 */
export function renderTicketProvenanceMarkdown(input: {
  readonly ticketNumber: number;
  readonly entries: readonly TicketProvenanceEntry[];
}): string {
  const lines: string[] = [
    `# 起居录 · #${input.ticketNumber}`,
    "",
    `条目数：${input.entries.length}`,
    "",
  ];
  let index = 0;
  for (const entry of input.entries) {
    index += 1;
    lines.push(`## ${index}. ${entry.sourceKind} · ${entry.timestamp}`);
    lines.push("");
    lines.push(`- basis.method: \`${entry.basis.method}\``);
    if (entry.basis.anchors !== undefined && entry.basis.anchors.length > 0) {
      lines.push(`- anchors: ${entry.basis.anchors.map((a) => `\`${a}\``).join(", ")}`);
    }
    if (entry.basis.note !== undefined) {
      lines.push(`- note: ${entry.basis.note}`);
    }
    const refParts: string[] = [];
    if (entry.sourceRef.sessionFile !== undefined) {
      refParts.push(`sessionFile=${entry.sourceRef.sessionFile}`);
    }
    if (entry.sourceRef.entryId !== undefined) {
      refParts.push(`entryId=${String(entry.sourceRef.entryId)}`);
    }
    if (entry.sourceRef.path !== undefined) {
      refParts.push(`path=${entry.sourceRef.path}`);
    }
    if (entry.sourceRef.url !== undefined) {
      refParts.push(`url=${entry.sourceRef.url}`);
    }
    if (refParts.length > 0) {
      lines.push(`- sourceRef: ${refParts.join(" · ")}`);
    }
    lines.push("");
    lines.push("```");
    lines.push(entry.transcript);
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Ensure the per-ticket JSONL volume partition exists (empty file OK).
 * Every bound-ticket court establishes the volume even with zero diary entries
 * (ADR 0075 ticket-provenance-file — 每票一份起居录). Does not forge entries.
 */
export function ensureTicketProvenanceVolume(
  ticketNumber: number,
  cwd: string,
): TicketProvenanceVolumePath {
  const volume = resolveTicketProvenanceVolume(ticketNumber, cwd);
  mkdirSync(volume.volumeDir, { recursive: true });
  if (!existsSync(volume.recordFile)) {
    writeFileSync(volume.recordFile, "", "utf8");
  }
  return volume;
}

/** Filename for last diarist-station diagnostic (process state next to volume). */
export const TICKET_PROVENANCE_STATION_DIAGNOSTIC = "diarist-station.json" as const;

export type DiaristStationDiagnostic = {
  readonly ticketNumber: number;
  readonly collectorStatus: string;
  readonly candidateCount: number;
  readonly freshCount: number;
  readonly appended: number;
  readonly rejectedQuotes: number;
  readonly collectorError?: string;
  readonly recordedAt: string;
};

/** Persist last station outcome next to the volume (collector failure 真因留痕). */
export function writeDiaristStationDiagnostic(input: {
  readonly ticketNumber: number;
  readonly cwd: string;
  readonly diagnostic: DiaristStationDiagnostic;
}): string {
  const volume = ensureTicketProvenanceVolume(input.ticketNumber, input.cwd);
  const path = join(volume.volumeDir, TICKET_PROVENANCE_STATION_DIAGNOSTIC);
  writeFileSync(path, `${JSON.stringify(input.diagnostic, null, 2)}\n`, "utf8");
  return path;
}

/** Write the co-located human view next to the JSONL volume (derived, not dual-source).
 * Ensures volume dir exists so empty courts still get the md face. */
export function writeTicketProvenanceHumanView(input: {
  readonly ticketNumber: number;
  readonly cwd: string;
  readonly entries: readonly TicketProvenanceEntry[];
}): string {
  const volume = ensureTicketProvenanceVolume(input.ticketNumber, input.cwd);
  const md = renderTicketProvenanceMarkdown({
    ticketNumber: input.ticketNumber,
    entries: input.entries,
  });
  writeFileSync(volume.humanViewFile, md, "utf8");
  return volume.humanViewFile;
}
