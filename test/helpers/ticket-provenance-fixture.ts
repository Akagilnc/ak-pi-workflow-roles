import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolveTicketProvenanceVolume } from "../../src/ticket-provenance.ts";
import { readSitianRecords } from "../../src/sitian-reader.ts";
import type {
  TicketProvenanceHeader,
  TicketProvenanceLine,
  TicketProvenanceSession,
} from "../../src/ticket-provenance-contracts.ts";
import { projectTicketProvenanceHeader } from "../../src/ticket-provenance-contracts.ts";

/** Test-only fixture helper to ensure a ticket volume directory and file exist. */
export function ensureTicketProvenanceVolume(
  ticketNumber: number,
  cwd: string,
  home?: string,
): { recordFile: string; volumeDir: string } {
  const path = resolveTicketProvenanceVolume(ticketNumber, cwd, home);
  mkdirSync(path.volumeDir, { recursive: true });
  appendFileSync(path.recordFile, "", "utf8");
  return path;
}

export type TicketProvenanceAppendRecord = {
  readonly identity: string;
  readonly sessions: readonly TicketProvenanceSession[];
  readonly lines: readonly TicketProvenanceLine[];
  readonly unprojectedRaw: readonly string[];
  readonly raw: string;
};

export type ReadTicketProvenanceRecordsResult = {
  readonly recordFile: string;
  readonly volumeDir: string;
  /** Legacy snapshot header if present; otherwise undefined (#1090 has no folded header). */
  readonly header: TicketProvenanceHeader | undefined;
  /** Dialogue lines from every append (+ legacy bare rows), in file order. */
  readonly lines: readonly TicketProvenanceLine[];
  /** Unprojected source bytes preserved inside append payloads (+ legacy bad rows). */
  readonly unprojectedRaw: readonly string[];
  /** Sitian ticket-provenance-append commits only. */
  readonly appends: readonly TicketProvenanceAppendRecord[];
  readonly records: readonly unknown[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Test-only fixture helper to read records from a ticket volume. */
export async function readTicketProvenanceRecords(
  ticketNumber: number,
  cwd: string,
  home?: string,
): Promise<ReadTicketProvenanceRecordsResult> {
  const { recordFile, volumeDir } = resolveTicketProvenanceVolume(
    ticketNumber,
    cwd,
    home,
  );
  const { records } = await readSitianRecords(recordFile);
  const lines: TicketProvenanceLine[] = [];
  const unprojectedRaw: string[] = [];
  const appends: TicketProvenanceAppendRecord[] = [];
  let header: TicketProvenanceHeader | undefined;

  const text = existsSync(recordFile) ? readFileSync(recordFile, "utf8") : "";
  const physical = text.split("\n");
  const identityToRaw = new Map<string, string>();
  for (const raw of physical) {
    if (!raw.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed) && typeof parsed.identity === "string") {
        identityToRaw.set(parsed.identity, raw);
      }
      if (header === undefined) {
        const projected = projectTicketProvenanceHeader(parsed);
        if (projected !== undefined) header = projected;
      }
      if (
        isRecord(parsed) &&
        parsed.kind === undefined &&
        typeof parsed.speaker === "string" &&
        typeof parsed.text === "string" &&
        Number.isInteger(parsed.s)
      ) {
        lines.push(parsed as unknown as TicketProvenanceLine);
      }
    } catch {
      unprojectedRaw.push(raw);
    }
  }

  for (const record of records) {
    if (!isRecord(record)) continue;
    const payload = record.payload;
    if (!isRecord(payload) || payload.type !== "ticket-provenance-append") {
      continue;
    }
    const sessions = Array.isArray(payload.sessions)
      ? (payload.sessions as TicketProvenanceSession[])
      : [];
    const appendLines: TicketProvenanceLine[] = [];
    const appendRaw: string[] = [];
    for (const entry of Array.isArray(payload.lines) ? payload.lines : []) {
      if (typeof entry === "string") {
        appendRaw.push(entry);
        unprojectedRaw.push(entry);
        continue;
      }
      if (!isRecord(entry)) continue;
      if (typeof entry.raw === "string") {
        appendRaw.push(entry.raw);
        unprojectedRaw.push(entry.raw);
        continue;
      }
      appendLines.push(entry as unknown as TicketProvenanceLine);
      lines.push(entry as unknown as TicketProvenanceLine);
    }
    const identity =
      typeof record.identity === "string" ? record.identity : "";
    appends.push({
      identity,
      sessions,
      lines: appendLines,
      unprojectedRaw: appendRaw,
      raw: identityToRaw.get(identity) ?? "",
    });
  }

  return {
    recordFile,
    volumeDir,
    header,
    lines,
    unprojectedRaw,
    appends,
    records,
  };
}
