/**
 * 起居郎 pipeline step — ADR 0075 / #582.
 * Not a public seat: no soul, no locator, no gate attendance.
 * Runs as the court-pipeline station before countersign turn.
 */
import { extractReferencedAdrPaths } from "./adr-path-refs.ts";
import {
  createGhApiRunner,
  createGhCollectorGitHubTransport,
  projectGhIssueBody,
  type CollectorGitHubTransport,
  type GhApiRunner,
} from "./collector-github.ts";
import {
  blockToLlmEntry,
  buildDiaristAnchors,
  mechanicalSafeguardPipeline,
  readAdrDecisionKeyBlocks,
  readCcSessionBlocks,
  readIssueFaceBlocks,
  type DiaristAnchorSet,
  type DiaristIssueFace,
  type DiaristSourceBlock,
} from "./diarist-mechanical.ts";
import {
  createHermesDiaristCollector,
  type DiaristLlmCollectResult,
} from "./diarist-llm-collector.ts";
import { parseGitHubOriginRemote } from "./reviewer-pinned-git.ts";
import {
  appendCollectorFailureDiagnostic,
  appendIssueSourceFailureDiagnostic,
  appendQuoteVerifyFailureDiagnostic,
  appendTicketProvenanceEntry,
  ensureTicketProvenanceVolume,
  readOfferedIdentities,
  readTicketProvenance,
  recordOfferedIdentities,
  resolveTicketProvenanceVolume,
  ticketProvenanceEntryIdentity,
  writeTicketProvenanceHumanView,
} from "./ticket-provenance.ts";
import type { TicketProvenanceEntry } from "./ticket-provenance-contracts.ts";
import { readSitianRecords, type RecordPointer } from "./sitian-facade.ts";
import { execFileSync } from "node:child_process";

export type { DiaristIssueFace } from "./diarist-mechanical.ts";

/** Typed reasons when bound-ticket issue face cannot be acquired honestly. */
export type DiaristIssueSourceReason =
  | "origin-unresolved"
  | "issue-unavailable"
  | "issue-not-json"
  | "issue-not-object"
  | "issue-is-pull-request"
  | "issue-body-invalid"
  | "comments-failed";

/** Bound-ticket issue source failure — not a soft degrade to empty face. */
export class DiaristIssueSourceError extends Error {
  readonly code = "diarist-issue-source" as const;
  readonly reason: DiaristIssueSourceReason;
  constructor(
    reason: DiaristIssueSourceReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DiaristIssueSourceError";
    this.reason = reason;
  }
}

/**
 * Issue-face fetch for the diarist station.
 * Production never soft-returns undefined (Reviewer Spec soft-fetch is not reused).
 * Test injectors may return undefined to simulate unavailability — station converts
 * that into a typed DiaristIssueSourceError + durable diagnostic.
 */
export type DiaristIssueFaceFetcher = (input: {
  readonly owner: string;
  readonly repo: string;
  readonly ticketNumber: number;
  readonly signal?: AbortSignal;
}) => Promise<DiaristIssueFace | undefined>;

export type DiaristRunInput = {
  readonly ticketNumber: number;
  readonly cwd: string;
  /** Explicit package home (admitted run / tests); never process.env.HOME (#604). */
  readonly home?: string;
  /**
   * Frozen GitHub issue face (body + comments). Production loads via shared gh seam.
   * Soft-unavailable → omit (no fake face from attachments).
   */
  readonly issueFace?: DiaristIssueFace;
  /** Extra cwd roots whose cc project folders are scanned. */
  readonly sessionCwds?: readonly string[];
  readonly signal?: AbortSignal;
  /** Package root for hermes collector method material resolution. */
  readonly packageRoot?: string;
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
  readonly collectorStatus:
    | "ok"
    | "skipped-no-fresh"
    | "failed"
    | "empty-selection";
  readonly collectorError?: string;
  readonly llmRawStdout?: string;
};

/**
 * Production issue-face capability over shared gh execution seams.
 * Body fetch/parse is sole-owned by projectGhIssueBody; this maps hard disposition
 * (typed DiaristIssueSourceError) instead of Reviewer Spec soft-undefined.
 * Comment list failures after body success keep true cause under comments-failed.
 */
export function createDiaristIssueFaceFetcher(options?: {
  readonly runner?: GhApiRunner;
  readonly transport?: CollectorGitHubTransport;
}): DiaristIssueFaceFetcher {
  const runner = options?.runner ?? createGhApiRunner();
  const transport = options?.transport ?? createGhCollectorGitHubTransport();
  return async (input) => {
    const projected = await projectGhIssueBody(runner, input);
    let body: string;
    if (projected.status === "available") {
      body = projected.body;
    } else if (projected.status === "unavailable") {
      if (projected.reason === "pull-request") {
        throw new DiaristIssueSourceError(
          "issue-is-pull-request",
          `ticket #${input.ticketNumber} resolves to a pull request, not an issue face`,
          projected.cause === undefined ? undefined : { cause: projected.cause },
        );
      }
      throw new DiaristIssueSourceError(
        "issue-unavailable",
        `issue face unavailable for ${input.owner}/${input.repo}#${input.ticketNumber}`,
        projected.cause === undefined ? undefined : { cause: projected.cause },
      );
    } else if (projected.reason === "not-json") {
      throw new DiaristIssueSourceError(
        "issue-not-json",
        `issue face payload is not JSON for ${input.owner}/${input.repo}#${input.ticketNumber}`,
        projected.cause === undefined ? undefined : { cause: projected.cause },
      );
    } else if (projected.reason === "not-object") {
      throw new DiaristIssueSourceError(
        "issue-not-object",
        `issue face payload must be a JSON object for ${input.owner}/${input.repo}#${input.ticketNumber}`,
      );
    } else {
      throw new DiaristIssueSourceError(
        "issue-body-invalid",
        `issue face body must be string or null for ${input.owner}/${input.repo}#${input.ticketNumber}`,
      );
    }
    let listed;
    try {
      listed = await transport.listIssueComments({
        owner: input.owner,
        repo: input.repo,
        prNumber: input.ticketNumber,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      throw new DiaristIssueSourceError(
        "comments-failed",
        `issue comments fetch failed for ${input.owner}/${input.repo}#${input.ticketNumber}`,
        { cause: error },
      );
    }
    const bodyUrl = `https://github.com/${input.owner}/${input.repo}/issues/${input.ticketNumber}`;
    return {
      body,
      bodyUrl,
      comments: listed.items.map((c) => ({
        id: c.id,
        body: c.body,
        createdAt: c.createdAt,
        htmlUrl: c.htmlUrl,
      })),
    };
  };
}

/** github.com owner/repo from project origin remote; undefined when absent/non-github. */
export function resolveDiaristGithubOrigin(
  projectRoot: string,
): { readonly owner: string; readonly repo: string } | undefined {
  let remoteUrl: string;
  try {
    remoteUrl = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return undefined;
  }
  if (remoteUrl.length === 0) return undefined;
  return parseGitHubOriginRemote(remoteUrl);
}

/**
 * Identities already processed for this ticket:
 * - volume record identities (selected / verify-fail residue)
 * - offered watermark (blocks shown to collector, selected or not)
 */
async function loadSeenEntryIdentities(
  ticketNumber: number,
  cwd: string,
  home?: string,
): Promise<ReadonlySet<string>> {
  const { recordFile } = resolveTicketProvenanceVolume(ticketNumber, cwd, home);
  const { records } = await readSitianRecords(recordFile);
  const seen = new Set<string>();
  for (const record of records) {
    if (typeof record.identity === "string" && record.identity.length > 0) {
      seen.add(record.identity);
    }
  }
  for (const identity of readOfferedIdentities(ticketNumber, cwd, home)) {
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
 * Single typed candidate stream: cc sessions + GitHub issue face/comments/decree + referenced ADRs.
 * Mechanical layer does not prose-filter for relevance (锚定宪法).
 * Attachments are never merged in as fake issue-body-comment.
 */
async function loadSourceBlocks(input: DiaristRunInput): Promise<DiaristSourceBlock[]> {
  const cwds = input.sessionCwds ?? [input.cwd];
  const blocks: DiaristSourceBlock[] = [...readCcSessionBlocks({ cwds })];
  if (input.issueFace !== undefined) {
    blocks.push(...readIssueFaceBlocks({ face: input.issueFace }));
    const faceText = [
      input.issueFace.body,
      ...input.issueFace.comments.map((c) => c.body),
    ].join("\n");
    const adrPaths = extractReferencedAdrPaths(faceText);
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

function faceTextForAnchors(face: DiaristIssueFace | undefined): string | undefined {
  if (face === undefined) return undefined;
  const parts = [face.body, ...face.comments.map((c) => c.body)].filter(
    (t) => t.trim() !== "",
  );
  if (parts.length === 0) return undefined;
  return parts.join("\n");
}

/**
 * Run one diarist pass for a ticket: mechanical candidates → LLM collect →
 * reverse-verify → idempotent sitian append → human view refresh.
 * Always establishes the per-ticket volume + md.
 */
export async function runDiarist(input: DiaristRunInput): Promise<DiaristRunResult> {
  const homeOpt = input.home === undefined ? {} : { home: input.home };
  // Per-ticket volume exists for every bound court, including empty/fail paths.
  const volumePaths = ensureTicketProvenanceVolume(input.ticketNumber, input.cwd, input.home);

  const anchorText = faceTextForAnchors(input.issueFace);
  const anchors: DiaristAnchorSet = buildDiaristAnchors({
    ticketNumber: input.ticketNumber,
    ...(anchorText === undefined ? {} : { ticketBody: anchorText }),
  });
  const rawBlocks = await loadSourceBlocks(input);
  // Safeguard only (notify filter + dedupe) — never prose-based exclusion.
  const safeguarded = mechanicalSafeguardPipeline(rawBlocks);
  // Incremental: only blocks whose entry identity is not yet on the volume
  // are offered to the collector (ADR 0075 refresh-every-court = 增量幂等).
  const seen = await loadSeenEntryIdentities(input.ticketNumber, input.cwd, input.home);
  const fresh = safeguarded.filter(
    (block) => !seen.has(blockEntryIdentity(input.ticketNumber, block)),
  );

  let collectorStatus: DiaristRunResult["collectorStatus"];
  let collectorError: string | undefined;
  let llmRawStdout: string | undefined;
  let collect: DiaristLlmCollectResult | undefined;

  // Production composition always runs the hermes collector (ADR 0075).
  // No injectable skip / alternate collector on this seam.
  const collector = createHermesDiaristCollector({
    cwd: input.cwd,
    ...(input.packageRoot === undefined ? {} : { packageRoot: input.packageRoot }),
  });

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
      // Watermark advances only after durable volume writes below — never
      // before selected entries / quote diagnostics are committed.
    } catch (error) {
      collectorStatus = "failed";
      collectorError =
        error instanceof Error ? error.message : String(error);
      // Durable true-cause on the ticket volume (append-only history).
      appendCollectorFailureDiagnostic({
        ticketNumber: input.ticketNumber,
        cwd: input.cwd,
        ...homeOpt,
        collectorError,
      });
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
        // Single diagnostic expression — never a disguised diary entry.
        const ptr = appendQuoteVerifyFailureDiagnostic({
          ticketNumber: input.ticketNumber,
          cwd: input.cwd,
          ...homeOpt,
          cause: projected.cause,
        });
        pointers.push(ptr);
        continue;
      }
      const ptr = appendTicketProvenanceEntry({
        ticketNumber: input.ticketNumber,
        cwd: input.cwd,
        ...homeOpt,
        entry: projected.entry,
        source: "diarist",
      });
      pointers.push(ptr);
      accepted.push(projected.entry);
    }
  }

  // Successful collector pass (incl. empty selection): mark all offered
  // identities only after the volume writes above, so a crash mid-commit
  // still retries the batch next court. Entry identity and quote-verify
  // diagnostic identity are stable — retry does not duplicate either.
  // Failure does not advance the watermark (retry honestly).
  if (
    collect !== undefined &&
    (collectorStatus === "ok" || collectorStatus === "empty-selection")
  ) {
    recordOfferedIdentities({
      ticketNumber: input.ticketNumber,
      cwd: input.cwd,
      ...homeOpt,
      identities: fresh.map((block) =>
        blockEntryIdentity(input.ticketNumber, block),
      ),
    });
  }

  // Refresh human view from the full volume (includes prior court runs).
  // Always write — empty courts still get the md face next to the JSONL.
  const volume = await readTicketProvenance(input.ticketNumber, input.cwd, input.home);
  const humanViewFile = writeTicketProvenanceHumanView({
    ticketNumber: input.ticketNumber,
    cwd: input.cwd,
    ...homeOpt,
    entries: volume.entries,
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
    collectorStatus,
    ...(collectorError === undefined ? {} : { collectorError }),
    ...(llmRawStdout === undefined ? {} : { llmRawStdout }),
  };
}
