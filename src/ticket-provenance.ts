/**
 * 起居录 volume helpers — ADR 0075 / #582.
 * Write/read via sitian facade only; no parallel destination logic.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
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
  projectTicketProvenanceDiagnostic,
  projectTicketProvenanceEntry,
  type TicketProvenanceDiagnostic,
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
  readonly cwd: string;
  readonly sessionParent: string;
  /** Original diarist row (or `{ original, unprojected: true }` envelope). */
  readonly payload: unknown;
  /** Explicit package home (tests / admitted run); never process.env.HOME (#604). */
  readonly home?: string;
  readonly host?: string;
  readonly source?: string;
};

function identityFromPayload(ticketNumber: number, payload: unknown): string {
  if (
    typeof payload === "object"
    && payload !== null
    && !Array.isArray(payload)
  ) {
    const record = payload as Record<string, unknown>;
    if (typeof record.sourceKind === "string" && typeof record.transcript === "string") {
      const sourceRef = typeof record.sourceRef === "object" && record.sourceRef !== null && !Array.isArray(record.sourceRef)
        ? record.sourceRef as TicketProvenanceIdentityInput["sourceRef"]
        : {};
      return ticketProvenanceEntryIdentity({
        ticketNumber,
        sourceKind: record.sourceKind,
        sourceRef,
        transcript: record.transcript,
      });
    }
  }
  return createHash("sha256")
    .update(`${String(ticketNumber)}\u0000${JSON.stringify(payload)}`, "utf8")
    .digest("hex");
}

/** Append one original row; returns existing pointer on identity hit. */
export function appendTicketProvenanceEntry(
  input: AppendTicketProvenanceInput,
): RecordPointer {
  const subject = ticketProvenanceSubject(input.ticketNumber);
  const identity = identityFromPayload(input.ticketNumber, input.payload);
  const record = typeof input.payload === "object" && input.payload !== null && !Array.isArray(input.payload)
    ? input.payload as Record<string, unknown>
    : undefined;
  const sourceRef = record !== undefined && typeof record.sourceRef === "object" && record.sourceRef !== null && !Array.isArray(record.sourceRef)
    ? record.sourceRef as { sessionFile?: unknown; entryId?: unknown }
    : undefined;
  return sitianReport({
    level: "event",
    kind: TICKET_PROVENANCE_KIND,
    identity,
    subject,
    cwd: input.cwd,
    sessionParent: input.sessionParent,
    ...(input.home === undefined ? {} : { home: input.home }),
    host: input.host ?? "diarist",
    source: input.source ?? "diarist",
    payload: input.payload,
    raw:
      sourceRef !== undefined
      && typeof sourceRef.sessionFile === "string"
      && (typeof sourceRef.entryId === "string" || typeof sourceRef.entryId === "number")
        ? {
            sessionFile: sourceRef.sessionFile,
            entryId: sourceRef.entryId,
          }
        : undefined,
  });
}

export type TicketProvenanceVolumePath = {
  readonly recordFile: string;
  readonly volumeDir: string;
  readonly humanViewFile: string;
};

/** Resolve volume paths for a ticket without writing. */
export function resolveTicketProvenanceVolume(
  ticketNumber: number,
  cwd: string,
  home?: string,
): TicketProvenanceVolumePath {
  const path = resolveSitianRecordPath({
    level: "event",
    kind: TICKET_PROVENANCE_KIND,
    subject: ticketProvenanceSubject(ticketNumber),
    cwd,
    ...(home === undefined ? {} : { home }),
  });
  return {
    recordFile: path.recordFile,
    volumeDir: path.sessionDir,
    humanViewFile: join(path.sessionDir, TICKET_PROVENANCE_HUMAN_VIEW),
  };
}

export type ReadTicketProvenanceResult = {
  /** Readable diary body entries only. */
  readonly entries: readonly TicketProvenanceEntry[];
  /**
   * Original payloads that did not project — kept beside typed entries (#836 / ADR 0075).
   * Never dropped from the volume.
   */
  readonly unprojected: readonly unknown[];
  /** Typed diagnostics on the same partition (collector/issue-source failures). */
  readonly diagnostics: readonly TicketProvenanceDiagnostic[];
  readonly records: readonly SitianRecord[];
  readonly recordFile: string;
  /** Rows that are neither body entry nor recognized diagnostic. */
  readonly skipped: number;
};

/** Read projected diary entries + diagnostics for a ticket (empty when volume absent). */
export async function readTicketProvenance(
  ticketNumber: number,
  cwd: string,
  home?: string,
): Promise<ReadTicketProvenanceResult> {
  const { recordFile } = resolveTicketProvenanceVolume(ticketNumber, cwd, home);
  const { records } = await readSitianRecords(recordFile);
  const entries: TicketProvenanceEntry[] = [];
  const unprojected: unknown[] = [];
  const diagnostics: TicketProvenanceDiagnostic[] = [];
  let skipped = 0;
  for (const record of records) {
    if (record.kind !== TICKET_PROVENANCE_KIND) {
      skipped += 1;
      continue;
    }
    // Diagnostics first — same partition, separate projection (never body).
    const diagnostic = projectTicketProvenanceDiagnostic(record.payload);
    if (diagnostic !== undefined) {
      diagnostics.push(diagnostic);
      continue;
    }
    const entry = projectTicketProvenanceEntry(record.payload);
    if (entry === undefined) {
      unprojected.push(record.payload);
      continue;
    }
    entries.push(entry);
  }
  return { entries, unprojected, diagnostics, records, recordFile, skipped };
}

/**
 * Fence long enough that any backtick run inside `text` cannot close the block.
 * Presentation helper only — not a machine contract; not exported.
 */
function markdownFenceFor(text: string): string {
  let longest = 0;
  const runs = text.match(/`+/g);
  if (runs !== null) {
    for (const run of runs) {
      if (run.length > longest) longest = run.length;
    }
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Render a local human-read markdown view from entries.
 * Presentation only — machines bite JSONL. No wording lock for consumers.
 */
export function renderTicketProvenanceMarkdown(input: {
  readonly ticketNumber: number;
  readonly entries: readonly TicketProvenanceEntry[];
  readonly unprojected?: readonly unknown[];
}): string {
  const unprojected = input.unprojected ?? [];
  const lines: string[] = [
    `# 起居录 · #${input.ticketNumber}`,
    "",
    `条目数：${input.entries.length + unprojected.length}`,
    "",
  ];
  let index = 0;
  for (const entry of input.entries) {
    index += 1;
    const sourceKind = typeof entry.sourceKind === "string" ? entry.sourceKind : "未投影";
    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "";
    lines.push(`## ${index}. ${sourceKind} · ${timestamp}`);
    lines.push("");
    const basis = entry.basis;
    const method =
      typeof basis === "object" && basis !== null && !Array.isArray(basis) && typeof basis.method === "string"
        ? basis.method
        : "未投影";
    lines.push(`- basis.method: \`${method}\``);
    if (
      typeof basis === "object" &&
      basis !== null &&
      !Array.isArray(basis) &&
      Array.isArray(basis.anchors) &&
      basis.anchors.length > 0
    ) {
      lines.push(`- anchors: ${basis.anchors.map((a) => `\`${String(a)}\``).join(", ")}`);
    }
    if (typeof basis === "object" && basis !== null && !Array.isArray(basis) && basis.note !== undefined) {
      lines.push(`- note: ${String(basis.note)}`);
    }
    const sourceRef =
      typeof entry.sourceRef === "object" && entry.sourceRef !== null && !Array.isArray(entry.sourceRef)
        ? entry.sourceRef as { sessionFile?: unknown; entryId?: unknown; path?: unknown; url?: unknown }
        : {};
    const refParts: string[] = [];
    if (sourceRef.sessionFile !== undefined) {
      refParts.push(`sessionFile=${String(sourceRef.sessionFile)}`);
    }
    if (sourceRef.entryId !== undefined) {
      refParts.push(`entryId=${String(sourceRef.entryId)}`);
    }
    if (sourceRef.path !== undefined) {
      refParts.push(`path=${String(sourceRef.path)}`);
    }
    if (sourceRef.url !== undefined) {
      refParts.push(`url=${String(sourceRef.url)}`);
    }
    if (refParts.length > 0) {
      lines.push(`- sourceRef: ${refParts.join(" · ")}`);
    }
    lines.push("");
    const transcript = typeof entry.transcript === "string" ? entry.transcript : JSON.stringify(entry);
    const fence = markdownFenceFor(transcript);
    lines.push(fence);
    lines.push(transcript);
    lines.push(fence);
    lines.push("");
  }
  for (const payload of unprojected) {
    index += 1;
    lines.push(`## ${index}. 未投影`);
    lines.push("");
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    const fence = markdownFenceFor(text);
    lines.push(fence);
    lines.push(text);
    lines.push(fence);
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
  home?: string,
): TicketProvenanceVolumePath {
  const volume = resolveTicketProvenanceVolume(ticketNumber, cwd, home);
  mkdirSync(volume.volumeDir, { recursive: true });
  // Append-open creates an absent volume without ever truncating rows committed
  // by a concurrent first writer.
  appendFileSync(volume.recordFile, "", "utf8");
  return volume;
}

/** Write the co-located human view next to the JSONL volume (derived, not dual-source).
 * Ensures volume dir exists so empty courts still get the md face. */
export function writeTicketProvenanceHumanView(input: {
  readonly ticketNumber: number;
  readonly cwd: string;
  readonly home?: string;
  readonly entries: readonly TicketProvenanceEntry[];
  readonly unprojected?: readonly unknown[];
}): string {
  const volume = ensureTicketProvenanceVolume(input.ticketNumber, input.cwd, input.home);
  const md = renderTicketProvenanceMarkdown({
    ticketNumber: input.ticketNumber,
    entries: input.entries,
    ...(input.unprojected === undefined ? {} : { unprojected: input.unprojected }),
  });
  writeFileSync(volume.humanViewFile, md, "utf8");
  return volume.humanViewFile;
}
