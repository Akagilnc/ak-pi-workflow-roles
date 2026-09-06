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
  /**
   * Ticket identity the caller already holds. Omit it and this round reads the
   * summons and hands one back — the sole ticket-number source of truth
   * (ADR 0081 `initial-court-ticket-supplied` / `reuse-case-ticket-without-extra-llm`).
   */
  readonly ticketNumber?: number;
  /** Caller summons text this round understands when identity is not yet known. */
  readonly instruction?: string;
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
  /**
   * After this round names a ticket, load the GitHub issue face so the same
   * invocation can collect it. Omit when the caller already passed issueFace
   * or when this seat does not fetch faces (coder/fixer/judge/inspector).
   */
  readonly loadIssueFace?: (
    ticketNumber: number,
  ) => Promise<DiaristIssueFace>;
};

export type DiaristRunResult = {
  /** Identity this round worked under; undefined = the summons named no ticket. */
  readonly ticketNumber: number | undefined;
  /** Safeguard-cleaned source count before incremental filter. */
  readonly candidateCount: number;
  /** Blocks not yet on the volume — sole set sent to the collector this court. */
  readonly freshCount: number;
  readonly appended: number;
  readonly rejectedQuotes: number;
  readonly pointers: readonly RecordPointer[];
  readonly entries: readonly TicketProvenanceEntry[];
  /** Volume faces — absent when the round named no ticket (no volume is minted). */
  readonly humanViewFile?: string;
  readonly volumeRecordFile?: string;
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
 * Run one diarist pass: mechanical candidates → LLM collect → reverse-verify →
 * idempotent sitian append → human view refresh.
 * The same round carries ticket identity: an input ticketNumber is worked under
 * directly, otherwise the collector reads the caller's summons and names one.
 * A named ticket always ends with its volume + md established, including on the
 * empty and failed paths. A round that names none stays lawfully unbound and
 * mints nothing — no fake ticket, no volume.
 */
export async function runDiarist(input: DiaristRunInput): Promise<DiaristRunResult> {
  const homeOpt = input.home === undefined ? {} : { home: input.home };
  const known = input.ticketNumber;

  const rawBlocks = await loadSourceBlocks(input);
  // Safeguard only (notify filter + dedupe) — never prose-based exclusion.
  const safeguarded = mechanicalSafeguardPipeline(rawBlocks);
  // Incremental: only blocks whose entry identity is not yet on the volume
  // are offered to the collector (ADR 0075 refresh-every-court = 增量幂等).
  // An unknown identity has no volume to compare against — every block is fresh.
  const seen =
    known === undefined
      ? new Set<string>()
      : await loadSeenEntryIdentities(known, input.cwd, input.home);
  const fresh = safeguarded.filter(
    (block) => known === undefined || !seen.has(blockEntryIdentity(known, block)),
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

  // Nothing new to transcribe skips the round — but only once identity is known.
  // An unknown identity still asks, with an empty catalog if that is all there is:
  // the summons alone is enough for this round to name the ticket.
  if (known !== undefined && fresh.length === 0) {
    collectorStatus = "skipped-no-fresh";
  } else {
    try {
      collect = await collector({
        ...(known === undefined ? {} : { ticketNumber: known }),
        ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
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
      if (known === undefined) {
        // Identity was this round's work. Engine/parse failure is not 真无票
        // (失败诚实: do not wash an unidentified exception into unbound).
        throw error;
      }
      // Bound ticket: durable true-cause on the volume; the station continues.
      appendCollectorFailureDiagnostic({
        ticketNumber: known,
        cwd: input.cwd,
        ...homeOpt,
        collectorError,
      });
    }
  }

  const ticketNumber = known ?? collect?.ticketNumber;
  if (ticketNumber === undefined) {
    // 真无票: the collector named no ticket. Collector failure never reaches here.
    return {
      ticketNumber: undefined,
      candidateCount: safeguarded.length,
      freshCount: fresh.length,
      appended: 0,
      rejectedQuotes: 0,
      pointers: [],
      entries: [],
      collectorStatus,
      ...(collectorError === undefined ? {} : { collectorError }),
      ...(llmRawStdout === undefined ? {} : { llmRawStdout }),
    };
  }

  // Per-ticket volume exists for every named ticket, including empty/fail paths.
  const volumePaths = ensureTicketProvenanceVolume(ticketNumber, input.cwd, input.home);

  // Same round: once identity is known, load the issue face and collect those
  // blocks here. Do not return to the seat for a second runDiarist.
  let issueFace = input.issueFace;
  if (issueFace === undefined && input.loadIssueFace !== undefined) {
    issueFace = await input.loadIssueFace(ticketNumber);
  }
  const firstIdentities = new Set(
    fresh.map((block) => blockEntryIdentity(ticketNumber, block)),
  );
  const extraFresh =
    issueFace === undefined || input.issueFace !== undefined
      ? []
      : mechanicalSafeguardPipeline(
          await loadSourceBlocks({ ...input, issueFace }),
        ).filter(
          (block) =>
            !firstIdentities.has(blockEntryIdentity(ticketNumber, block)),
        );
  const batches: Array<{
    readonly blocks: readonly DiaristSourceBlock[];
    readonly collect: DiaristLlmCollectResult | undefined;
    readonly status: DiaristRunResult["collectorStatus"];
  }> = [{ blocks: fresh, collect, status: collectorStatus }];
  if (extraFresh.length > 0) {
    try {
      const extraCollect = await collector({
        ticketNumber,
        ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
        candidates: extraFresh,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      llmRawStdout = extraCollect.rawStdout;
      const extraStatus =
        extraCollect.selections.length === 0 ? "empty-selection" : "ok";
      if (extraStatus === "ok") collectorStatus = "ok";
      else if (collectorStatus !== "ok") collectorStatus = extraStatus;
      batches.push({
        blocks: extraFresh,
        collect: extraCollect,
        status: extraStatus,
      });
    } catch (error) {
      collectorStatus = "failed";
      collectorError =
        error instanceof Error ? error.message : String(error);
      appendCollectorFailureDiagnostic({
        ticketNumber,
        cwd: input.cwd,
        ...homeOpt,
        collectorError,
      });
    }
  }

  const anchorText = faceTextForAnchors(issueFace);
  const anchors: DiaristAnchorSet = buildDiaristAnchors({
    ticketNumber,
    ...(anchorText === undefined ? {} : { ticketBody: anchorText }),
  });

  const pointers: RecordPointer[] = [];
  const accepted: TicketProvenanceEntry[] = [];
  let rejectedQuotes = 0;
  const offered: string[] = [];

  for (const batch of batches) {
    if (batch.collect !== undefined && batch.status === "ok") {
      for (const selection of batch.collect.selections) {
        const block = batch.blocks[selection.candidateIndex];
        if (block === undefined) continue;
        const projected = blockToLlmEntry(block, {
          anchors,
          quotes: selection.quotes,
          ...(selection.note === undefined ? {} : { note: selection.note }),
        });
        if (!projected.ok) {
          rejectedQuotes += 1;
          const ptr = appendQuoteVerifyFailureDiagnostic({
            ticketNumber,
            cwd: input.cwd,
            ...homeOpt,
            cause: projected.cause,
          });
          pointers.push(ptr);
          continue;
        }
        const ptr = appendTicketProvenanceEntry({
          ticketNumber,
          cwd: input.cwd,
          ...homeOpt,
          entry: projected.entry,
          source: "diarist",
        });
        pointers.push(ptr);
        accepted.push(projected.entry);
      }
    }
    if (
      batch.collect !== undefined &&
      (batch.status === "ok" || batch.status === "empty-selection")
    ) {
      offered.push(
        ...batch.blocks.map((block) => blockEntryIdentity(ticketNumber, block)),
      );
    }
  }

  if (offered.length > 0) {
    recordOfferedIdentities({
      ticketNumber,
      cwd: input.cwd,
      ...homeOpt,
      identities: offered,
    });
  }

  // Refresh human view from the full volume (includes prior court runs).
  // Always write — empty courts still get the md face next to the JSONL.
  const volume = await readTicketProvenance(ticketNumber, input.cwd, input.home);
  const humanViewFile = writeTicketProvenanceHumanView({
    ticketNumber,
    cwd: input.cwd,
    ...homeOpt,
    entries: volume.entries,
  });

  return {
    ticketNumber,
    candidateCount: safeguarded.length + extraFresh.length,
    freshCount: fresh.length + extraFresh.length,
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
