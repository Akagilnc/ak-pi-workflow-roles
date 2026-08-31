/**
 * 起居郎 mechanical safeguard band — ADR 0075 / #582.
 * Deterministic: source enum helpers, candidate anchors, dedup, notification
 * filter, and verbatim quote reverse-verify. Never a production relevance gate.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

import type {
  TicketProvenanceEntry,
  TicketProvenanceSourceKind,
  TicketProvenanceSourceRef,
} from "./ticket-provenance-contracts.ts";

/** One frozen source message/block available for collection. */
export type DiaristSourceBlock = {
  readonly sourceKind: TicketProvenanceSourceKind;
  readonly sourceRef: TicketProvenanceSourceRef;
  readonly transcript: string;
  readonly timestamp: string;
  /** True user turn (cc); assistant/system/tool are non-user. */
  readonly isUserTurn: boolean;
  /** Notification / system noise that mechanical filter drops. */
  readonly isNotification: boolean;
};

/** Anchor set used only for candidate prefilter and reverse-verify notes. */
export type DiaristAnchorSet = {
  readonly ticketNumber: number;
  /** Ticket face 「」 quotes ≥ min length, and free-form owner quotes. */
  readonly quotes: readonly string[];
  /** Title / domain keywords (起居录, diarist, …). */
  readonly keywords: readonly string[];
};

export const DEFAULT_DIARIST_KEYWORDS = Object.freeze([
  "起居录",
  "起居郎",
  "司天台",
  "ticket-provenance",
  "diarist",
] as const);

const DEFAULT_QUOTE_MIN = 6;

/**
 * Extract 「」 quotes from ticket face text for mechanical anchors.
 * Only quotes meeting min length are kept.
 */
export function extractCornerQuotes(
  text: string,
  minLength: number = DEFAULT_QUOTE_MIN,
): string[] {
  const out: string[] = [];
  const re = /「([^」]+)」/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const q = match[1]!.trim();
    if (q.length >= minLength) out.push(q);
  }
  return out;
}

/** Build the mechanical anchor set from ticket number + face body. */
export function buildDiaristAnchors(input: {
  readonly ticketNumber: number;
  readonly ticketBody?: string;
  readonly extraQuotes?: readonly string[];
  readonly keywords?: readonly string[];
}): DiaristAnchorSet {
  const fromBody =
    input.ticketBody === undefined ? [] : extractCornerQuotes(input.ticketBody);
  const quotes = [
    ...fromBody,
    ...(input.extraQuotes ?? []),
  ];
  // Dedupe while preserving order.
  const seen = new Set<string>();
  const uniqueQuotes: string[] = [];
  for (const q of quotes) {
    if (seen.has(q)) continue;
    seen.add(q);
    uniqueQuotes.push(q);
  }
  return {
    ticketNumber: input.ticketNumber,
    quotes: uniqueQuotes,
    keywords: [...(input.keywords ?? DEFAULT_DIARIST_KEYWORDS)],
  };
}

/** Drop notification/system noise blocks (typed flags only — no prose match). */
export function filterNotifications(
  blocks: readonly DiaristSourceBlock[],
): DiaristSourceBlock[] {
  return blocks.filter((b) => !b.isNotification);
}

function blockKey(block: DiaristSourceBlock): string {
  const r = block.sourceRef;
  return [
    block.sourceKind,
    r.sessionFile ?? "",
    r.entryId === undefined ? "" : String(r.entryId),
    r.path ?? "",
    r.url ?? "",
    createHash("sha256").update(block.transcript, "utf8").digest("hex").slice(0, 16),
  ].join("|");
}

/** Dedup by source pointer + transcript digest (compression replay ×N). */
export function dedupeSourceBlocks(
  blocks: readonly DiaristSourceBlock[],
): DiaristSourceBlock[] {
  const seen = new Set<string>();
  const out: DiaristSourceBlock[] = [];
  for (const block of blocks) {
    const key = blockKey(block);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(block);
  }
  return out;
}

/**
 * Verbatim reverse-verify: every quote must appear as a contiguous substring
 * of the source text. Spliced multi-span quotes fail (probe: 1/27).
 */
export type QuoteVerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failedQuotes: readonly string[] };

export function verifyQuotesVerbatim(
  sourceText: string,
  quotes: readonly string[],
): QuoteVerifyResult {
  const failed: string[] = [];
  for (const q of quotes) {
    if (q.length === 0) continue;
    if (!sourceText.includes(q)) failed.push(q);
  }
  if (failed.length === 0) return { ok: true };
  return { ok: false, failedQuotes: failed };
}

/**
 * Mechanical safeguard only — never a relevance gate (ADR 0075 / 锚定宪法).
 * filter notifications (typed) → dedupe. Semantic selection is LLM-only.
 * Anchors are retained for reverse-verify notes, not for exclusion.
 */
export function mechanicalSafeguardPipeline(
  blocks: readonly DiaristSourceBlock[],
  _anchors?: DiaristAnchorSet,
): DiaristSourceBlock[] {
  return dedupeSourceBlocks(filterNotifications(blocks));
}

/** @deprecated alias — same as mechanicalSafeguardPipeline (no prose exclusion). */
export function mechanicalCandidatePipeline(
  blocks: readonly DiaristSourceBlock[],
  anchors?: DiaristAnchorSet,
): DiaristSourceBlock[] {
  return mechanicalSafeguardPipeline(blocks, anchors);
}

/** Claude Code project-dir encoding: abs path with / → -. */
export function encodeClaudeProjectDir(cwd: string): string {
  const abs = cwd.startsWith("/") ? cwd : `/${cwd}`;
  return abs.replace(/\//g, "-");
}

export type ReadCcSessionOptions = {
  /** Override Claude projects root (tests). Default ~/.claude/projects. */
  readonly projectsRoot?: string;
  /** Working directories whose encoded project folders are scanned. */
  readonly cwds: readonly string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageText(message: unknown): string {
  if (typeof message === "string") return message;
  if (!isRecord(message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!isRecord(part)) continue;
    if (typeof part.text === "string") parts.push(part.text);
    else if (typeof part.content === "string") parts.push(part.content);
  }
  return parts.join("\n");
}

function isNotificationRow(type: string, text: string): boolean {
  if (type === "queue-operation" || type === "system" || type === "progress") {
    return true;
  }
  if (type === "user") {
    // Local command / meta noise common in cc transcripts.
    if (text.startsWith("<command-name>") || text.startsWith("<local-command-")) {
      return true;
    }
    if (text.startsWith("<command-message>") || text.startsWith("<command-args>")) {
      return true;
    }
  }
  return false;
}

/**
 * Enumerate cc session user/assistant turns under Claude projects roots.
 * cc-sessions-first source family (ADR 0075).
 */
export function readCcSessionBlocks(
  options: ReadCcSessionOptions,
): DiaristSourceBlock[] {
  const root = options.projectsRoot ?? join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return [];

  const blocks: DiaristSourceBlock[] = [];
  const dirs = new Set<string>();
  for (const cwd of options.cwds) {
    dirs.add(join(root, encodeClaudeProjectDir(cwd)));
  }
  // Also accept already-encoded folder names passed as cwd (test convenience).
  for (const cwd of options.cwds) {
    if (cwd.includes("projects")) continue;
    const direct = join(root, cwd);
    if (existsSync(direct)) dirs.add(direct);
  }

  for (const dir of dirs) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    let files: string[];
    try {
      files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of files) {
      const sessionFile = join(dir, name);
      let text: string;
      try {
        text = readFileSync(sessionFile, "utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
        const line = lines[lineNo]!;
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isRecord(parsed)) continue;
        const type = typeof parsed.type === "string" ? parsed.type : "";
        if (type !== "user" && type !== "assistant") continue;
        const transcript = messageText(parsed.message ?? parsed);
        if (transcript.trim() === "") continue;
        const entryId =
          typeof parsed.uuid === "string"
            ? parsed.uuid
            : typeof parsed.id === "string"
              ? parsed.id
              : `${basename(sessionFile)}:${lineNo + 1}`;
        const timestamp =
          typeof parsed.timestamp === "string"
            ? parsed.timestamp
            : new Date(0).toISOString();
        const notification = isNotificationRow(type, transcript);
        blocks.push({
          sourceKind: "cc-session",
          sourceRef: { sessionFile, entryId },
          transcript,
          timestamp,
          isUserTurn: type === "user",
          isNotification: notification,
        });
      }
    }
  }
  return blocks;
}

/** Map a mechanical candidate block into a diary entry (prescreen method). */
export function blockToPrescreenEntry(
  block: DiaristSourceBlock,
  anchors: DiaristAnchorSet,
): TicketProvenanceEntry {
  return {
    basis: {
      method: "mechanical-prescreen",
      anchors: [
        `#${anchors.ticketNumber}`,
        ...anchors.quotes.slice(0, 8),
        ...anchors.keywords,
      ],
    },
    sourceKind: block.sourceKind,
    sourceRef: block.sourceRef,
    transcript: block.transcript,
    timestamp: block.timestamp,
  };
}

/**
 * Build an llm-semantic entry after reverse-verify succeeds.
 * `quotes` are the LLM-claimed quotes that must be verbatim in transcript.
 */
export function blockToLlmEntry(
  block: DiaristSourceBlock,
  input: {
    readonly anchors: DiaristAnchorSet;
    readonly quotes: readonly string[];
    readonly note?: string;
  },
):
  | { readonly ok: true; readonly entry: TicketProvenanceEntry }
  | {
      readonly ok: false;
      readonly diagnostic: TicketProvenanceEntry;
      readonly failedQuotes: readonly string[];
    } {
  const verify = verifyQuotesVerbatim(block.transcript, input.quotes);
  if (!verify.ok) {
    return {
      ok: false,
      failedQuotes: verify.failedQuotes,
      diagnostic: {
        basis: {
          method: "quote-verify-failed",
          anchors: [`#${input.anchors.ticketNumber}`],
          note: `verbatim verify failed: ${verify.failedQuotes.join(" | ")}`,
        },
        sourceKind: block.sourceKind,
        sourceRef: block.sourceRef,
        transcript: block.transcript,
        timestamp: block.timestamp,
      },
    };
  }
  return {
    ok: true,
    entry: {
      basis: {
        method: "llm-semantic",
        anchors: [
          `#${input.anchors.ticketNumber}`,
          ...input.quotes.slice(0, 8),
        ],
        ...(input.note === undefined ? {} : { note: input.note }),
      },
      sourceKind: block.sourceKind,
      sourceRef: block.sourceRef,
      transcript: block.transcript,
      timestamp: block.timestamp,
    },
  };
}
