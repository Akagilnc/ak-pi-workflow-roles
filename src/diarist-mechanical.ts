/**
 * 起居郎 mechanical safeguard band — ADR 0075 / #582.
 * Deterministic: source enum helpers, candidate anchors, dedup, notification
 * filter, and verbatim quote reverse-verify. Never a production relevance gate.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";

import {
  pathContainedIn,
  physicallyContainedIn,
} from "./activation-ledger-topology.ts";
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

/** Anchor set used only for reverse-verify notes (never a relevance gate). */
export type DiaristAnchorSet = {
  readonly ticketNumber: number;
  /** Ticket face 「」 quotes ≥ min length. */
  readonly quotes: readonly string[];
};

export const DEFAULT_QUOTE_MIN = 6;

/** Typed cause when an enumerated source path cannot be read or interpreted. */
export type DiaristSourceReadReason =
  | "readdir-failed"
  | "file-unreadable"
  | "jsonl-line-unparseable"
  | "adr-missing"
  | "adr-unreadable"
  | "adr-escape";

export class DiaristSourceReadError extends Error {
  readonly code = "diarist-source-read" as const;
  readonly reason: DiaristSourceReadReason;
  readonly sourcePath: string;
  constructor(
    reason: DiaristSourceReadReason,
    sourcePath: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DiaristSourceReadError";
    this.reason = reason;
    this.sourcePath = sourcePath;
  }
}

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
}): DiaristAnchorSet {
  const fromBody =
    input.ticketBody === undefined ? [] : extractCornerQuotes(input.ticketBody);
  const quotes = [...fromBody, ...(input.extraQuotes ?? [])];
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
 */
export function mechanicalSafeguardPipeline(
  blocks: readonly DiaristSourceBlock[],
): DiaristSourceBlock[] {
  return dedupeSourceBlocks(filterNotifications(blocks));
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
 * Directory/file/non-empty JSONL line failures throw DiaristSourceReadError
 * (失败诚实：不得把未读懂洗成没有来源块).
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
    if (!existsSync(dir)) continue;
    let dirStat;
    try {
      dirStat = statSync(dir);
    } catch (error) {
      throw new DiaristSourceReadError(
        "readdir-failed",
        dir,
        `diarist cc session dir unstatable (${dir})`,
        { cause: error },
      );
    }
    if (!dirStat.isDirectory()) continue;

    let files: string[];
    try {
      files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
    } catch (error) {
      throw new DiaristSourceReadError(
        "readdir-failed",
        dir,
        `diarist cc session dir unreadable (${dir})`,
        { cause: error },
      );
    }

    for (const name of files) {
      const sessionFile = join(dir, name);
      let text: string;
      try {
        text = readFileSync(sessionFile, "utf8");
      } catch (error) {
        throw new DiaristSourceReadError(
          "file-unreadable",
          sessionFile,
          `diarist cc session file unreadable (${sessionFile})`,
          { cause: error },
        );
      }
      const lines = text.split("\n");
      for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
        const line = lines[lineNo]!;
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          throw new DiaristSourceReadError(
            "jsonl-line-unparseable",
            sessionFile,
            `diarist cc session JSONL line ${lineNo + 1} unparseable (${sessionFile})`,
            { cause: error },
          );
        }
        // Unknown row shape (not user/assistant) is ignored — not a read failure.
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

/** One frozen GitHub issue comment for the issue-face candidate stream. */
export type DiaristIssueComment = {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
  readonly htmlUrl: string;
};

/**
 * Frozen GitHub issue face (body + comments) for diarist source enum.
 * Soft-unavailable fetch yields undefined upstream — never invent face from attachments.
 */
export type DiaristIssueFace = {
  readonly body: string;
  readonly bodyUrl: string;
  readonly comments: readonly DiaristIssueComment[];
};

/**
 * Issue body + comments + 「」 decree spans as typed source blocks.
 * Each block keeps its own sourceRef (url / comment id) — never merge attachments here.
 */
export function readIssueFaceBlocks(input: {
  readonly face: DiaristIssueFace;
  readonly timestamp?: string;
}): DiaristSourceBlock[] {
  const fallbackTs = input.timestamp ?? new Date(0).toISOString();
  const blocks: DiaristSourceBlock[] = [];
  const body = input.face.body;
  if (body.trim() !== "") {
    blocks.push({
      sourceKind: "issue-body-comment",
      sourceRef: { url: input.face.bodyUrl, entryId: "body" },
      transcript: body,
      timestamp: fallbackTs,
      isUserTurn: true,
      isNotification: false,
    });
    const quotes = extractCornerQuotes(body);
    for (let i = 0; i < quotes.length; i += 1) {
      const q = quotes[i]!;
      blocks.push({
        sourceKind: "ticket-decree-block",
        sourceRef: { url: input.face.bodyUrl, entryId: `decree-${i + 1}` },
        transcript: q,
        timestamp: fallbackTs,
        isUserTurn: true,
        isNotification: false,
      });
    }
  }
  for (const comment of input.face.comments) {
    if (comment.body.trim() === "") continue;
    blocks.push({
      sourceKind: "issue-body-comment",
      sourceRef: {
        url: comment.htmlUrl,
        entryId: comment.id,
      },
      transcript: comment.body,
      timestamp: comment.createdAt || fallbackTs,
      isUserTurn: true,
      isNotification: false,
    });
  }
  return blocks;
}

/** Relative root every ADR decision-key read must stay under (ADR 0038). */
export const DIARIST_ADR_ROOT_REL = "docs/adr" as const;

/**
 * Read applicable ADR files as decision-key source blocks.
 * Real IO seam owns lexical + physical containment under cwd/docs/adr (ADR 0038).
 * Missing / unreadable / escape → typed DiaristSourceReadError (失败诚实).
 */
export function readAdrDecisionKeyBlocks(input: {
  readonly cwd: string;
  readonly adrPaths: readonly string[];
  readonly timestamp?: string;
}): DiaristSourceBlock[] {
  const timestamp = input.timestamp ?? new Date(0).toISOString();
  const blocks: DiaristSourceBlock[] = [];
  const cwdAbs = resolve(input.cwd);
  const adrRootAbs = resolve(cwdAbs, DIARIST_ADR_ROOT_REL);
  let adrRootReal: string;
  try {
    // Prefer the real ADR root when it exists; otherwise fall back to cwd real
    // so physical checks still have a stable anchor before the first ADR file.
    adrRootReal = existsSync(adrRootAbs)
      ? realpathSync(adrRootAbs)
      : resolve(realpathSync(cwdAbs), DIARIST_ADR_ROOT_REL);
  } catch (error) {
    throw new DiaristSourceReadError(
      "adr-unreadable",
      cwdAbs,
      `diarist ADR root is not resolvable (${adrRootAbs})`,
      { cause: error },
    );
  }
  for (const rel of input.adrPaths) {
    const segments = rel.split(/[/\\]/);
    // Claimed path must sit under docs/adr/ with no traversal segments.
    if (
      segments[0] !== "docs" ||
      segments[1] !== "adr" ||
      segments.length < 3 ||
      segments.some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new DiaristSourceReadError(
        "adr-escape",
        resolve(cwdAbs, rel),
        `diarist referenced ADR escapes docs/adr (${rel})`,
      );
    }
    const abs = resolve(cwdAbs, rel);
    // Lexical containment under docs/adr before any read (ADR 0038).
    if (abs !== adrRootAbs && !pathContainedIn(adrRootAbs, abs)) {
      throw new DiaristSourceReadError(
        "adr-escape",
        abs,
        `diarist referenced ADR escapes docs/adr (${rel})`,
      );
    }
    if (!existsSync(abs)) {
      throw new DiaristSourceReadError(
        "adr-missing",
        abs,
        `diarist referenced ADR missing (${rel})`,
      );
    }
    let realAbs: string;
    try {
      realAbs = realpathSync(abs);
    } catch (error) {
      throw new DiaristSourceReadError(
        "adr-unreadable",
        abs,
        `diarist ADR path is not resolvable (${abs})`,
        { cause: error },
      );
    }
    if (realAbs !== adrRootReal && !physicallyContainedIn(adrRootReal, realAbs)) {
      throw new DiaristSourceReadError(
        "adr-escape",
        abs,
        `diarist referenced ADR escapes docs/adr physically (${rel})`,
      );
    }
    let text: string;
    try {
      text = readFileSync(realAbs, "utf8");
    } catch (error) {
      throw new DiaristSourceReadError(
        "adr-unreadable",
        realAbs,
        `diarist ADR file unreadable (${realAbs})`,
        { cause: error },
      );
    }
    if (text.trim() === "") continue;
    blocks.push({
      sourceKind: "adr-decision-key",
      sourceRef: { path: rel },
      transcript: text,
      timestamp,
      isUserTurn: true,
      isNotification: false,
    });
  }
  return blocks;
}

/**
 * Build an llm-semantic entry after reverse-verify succeeds.
 * `quotes` are the LLM-claimed quotes that must be verbatim in transcript.
 * basis.anchors record ticket # + mechanical/claimed quotes for audit only.
 * Failure returns failedQuotes only — caller records a single diagnostic (not a
 * disguised diary entry / dead basis.method).
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
      readonly failedQuotes: readonly string[];
      readonly cause: string;
    } {
  const verify = verifyQuotesVerbatim(block.transcript, input.quotes);
  if (!verify.ok) {
    return {
      ok: false,
      failedQuotes: verify.failedQuotes,
      cause: `verbatim verify failed: ${verify.failedQuotes.join(" | ")}`,
    };
  }
  // Ticket + mechanical face quotes + claimed quotes — reference/反验 only.
  const anchorNotes: string[] = [`#${input.anchors.ticketNumber}`];
  const seen = new Set<string>(anchorNotes);
  for (const q of [...input.anchors.quotes, ...input.quotes]) {
    if (seen.has(q)) continue;
    seen.add(q);
    anchorNotes.push(q);
    if (anchorNotes.length >= 12) break;
  }
  return {
    ok: true,
    entry: {
      basis: {
        method: "llm-semantic",
        anchors: anchorNotes,
        ...(input.note === undefined ? {} : { note: input.note }),
      },
      sourceKind: block.sourceKind,
      sourceRef: block.sourceRef,
      transcript: block.transcript,
      timestamp: block.timestamp,
    },
  };
}
