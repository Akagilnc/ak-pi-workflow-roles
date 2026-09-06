/**
 * 起居郎 mechanical halves — ADR 0075 `diarist-is-role` / `diarist-collector-is-own-turn`.
 * Semantic collection is the diarist role's own LLM turn; this module keeps the
 * mechanical safeguard band only: source enumeration into a frozen catalog, and
 * the verbatim reverse-verify → idempotent sitian append → watermark commit.
 * No lifecycle here (ADR 0018): the seat prepares, the role envelope commits.
 */
import { readFileSync } from "node:fs";

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
import type { DiaristSelection } from "./diarist-contracts.ts";
import { parseGitHubOriginRemote } from "./reviewer-pinned-git.ts";
import {
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
import { readSitianRecords } from "./sitian-facade.ts";
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
 * Issue-face fetch for the diarist seat. Unavailability is a typed
 * DiaristIssueSourceError — there is no soft-undefined face.
 */
export type DiaristIssueFaceFetcher = (input: {
  readonly owner: string;
  readonly repo: string;
  readonly ticketNumber: number;
  readonly signal?: AbortSignal;
}) => Promise<DiaristIssueFace>;

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
 * Acquire the issue face for a bound ticket. Failures are typed and durable on
 * the ticket-provenance volume, then propagated — never washed into empty face.
 */
export async function loadDiaristIssueFace(input: {
  readonly ticketNumber: number;
  readonly projectRoot: string;
  readonly home?: string;
  readonly fetcher?: DiaristIssueFaceFetcher;
}): Promise<DiaristIssueFace> {
  const persistAndThrow = (error: DiaristIssueSourceError): DiaristIssueSourceError => {
    appendIssueSourceFailureDiagnostic({
      ticketNumber: input.ticketNumber,
      cwd: input.projectRoot,
      ...(input.home === undefined ? {} : { home: input.home }),
      cause: error.message,
      reason: error.reason,
    });
    return error;
  };

  const origin = resolveDiaristGithubOrigin(input.projectRoot);
  if (origin === undefined) {
    throw persistAndThrow(
      new DiaristIssueSourceError(
        "origin-unresolved",
        `bound ticket #${input.ticketNumber} issue face requires a resolvable github.com origin remote`,
      ),
    );
  }

  const fetcher = input.fetcher ?? createDiaristIssueFaceFetcher();
  try {
    return await fetcher({
      owner: origin.owner,
      repo: origin.repo,
      ticketNumber: input.ticketNumber,
    });
  } catch (error) {
    throw persistAndThrow(
      error instanceof DiaristIssueSourceError
        ? error
        : new DiaristIssueSourceError(
            "issue-unavailable",
            `issue face fetch failed for ${origin.owner}/${origin.repo}#${input.ticketNumber}`,
            { cause: error },
          ),
    );
  }
}

/** One frozen candidate the diarist turn may select by index. */
export type DiaristSourceCandidate = DiaristSourceBlock & {
  readonly candidateIndex: number;
};

/**
 * Frozen per-ticket catalog handed to the diarist turn and re-read by the
 * envelope at accept time. Carries its own volume coordinates so neither side
 * re-derives them from ambient state.
 */
export type DiaristSourceCatalog = {
  readonly ticketNumber: number;
  readonly cwd: string;
  readonly home?: string;
  readonly candidates: readonly DiaristSourceCandidate[];
};

/**
 * Identities already processed for this ticket:
 * - volume record identities (selected / verify-fail residue)
 * - offered watermark (blocks shown to the diarist, selected or not)
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
function loadSourceBlocks(input: {
  readonly cwd: string;
  readonly issueFace?: DiaristIssueFace;
  readonly sessionCwds?: readonly string[];
}): DiaristSourceBlock[] {
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

export type PrepareDiaristSourceCatalogInput = {
  readonly ticketNumber: number;
  readonly cwd: string;
  /** Explicit package home (admitted run / tests); never process.env.HOME (#604). */
  readonly home?: string;
  /** Frozen GitHub issue face (body + comments) from the shared gh seam. */
  readonly issueFace?: DiaristIssueFace;
  /** Extra cwd roots whose cc project folders are scanned. */
  readonly sessionCwds?: readonly string[];
};

/**
 * Mechanical half A — source enumeration into a frozen catalog.
 * Establishes the per-ticket volume + human view for every bound run (ADR 0075
 * `ticket-provenance-file` 每票一份起居录), then offers only blocks whose entry
 * identity is not already on the volume or the offered watermark (增量幂等).
 */
export async function prepareDiaristSourceCatalog(
  input: PrepareDiaristSourceCatalogInput,
): Promise<DiaristSourceCatalog> {
  ensureTicketProvenanceVolume(input.ticketNumber, input.cwd, input.home);
  const volume = await readTicketProvenance(input.ticketNumber, input.cwd, input.home);
  writeTicketProvenanceHumanView({
    ticketNumber: input.ticketNumber,
    cwd: input.cwd,
    ...(input.home === undefined ? {} : { home: input.home }),
    entries: volume.entries,
  });

  const rawBlocks = loadSourceBlocks(input);
  // Safeguard only (notify filter + dedupe) — never prose-based exclusion.
  const safeguarded = mechanicalSafeguardPipeline(rawBlocks);
  const seen = await loadSeenEntryIdentities(input.ticketNumber, input.cwd, input.home);
  const fresh = safeguarded.filter(
    (block) => !seen.has(blockEntryIdentity(input.ticketNumber, block)),
  );

  return {
    ticketNumber: input.ticketNumber,
    cwd: input.cwd,
    ...(input.home === undefined ? {} : { home: input.home }),
    candidates: fresh.map((block, candidateIndex) => ({ ...block, candidateIndex })),
  };
}

export function serializeDiaristSourceCatalog(catalog: DiaristSourceCatalog): string {
  return JSON.stringify(catalog);
}

/** Read a frozen catalog written by the seat. Unreadable/malformed fails loudly. */
export function loadDiaristSourceCatalog(path: string): DiaristSourceCatalog {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`diarist source catalog is not an object (${path})`);
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.ticketNumber !== "number" || typeof record.cwd !== "string") {
    throw new Error(`diarist source catalog is missing ticket coordinates (${path})`);
  }
  if (!Array.isArray(record.candidates)) {
    throw new Error(`diarist source catalog is missing candidates (${path})`);
  }
  return parsed as DiaristSourceCatalog;
}

/**
 * 失败真因 — typed causes for submitted rows that never reached the volume.
 * Names the cause only; the per-row detail stays on the volume diagnostic.
 */
export type DiaristFailureCause =
  /** Row pointed at no candidate in this turn's frozen catalog. */
  | "unknown-candidate"
  /** Row's quotes failed verbatim reverse-verify. */
  | "quote-verify-rejected";

/** Honest machine facts about what this turn actually committed to the volume. */
export type DiaristCommitFacts = {
  readonly ticketNumber: number;
  /** Candidates offered to the diarist this turn. */
  readonly offered: number;
  /** Entries appended to the volume this turn. */
  readonly appended: number;
  /** Selections rejected by verbatim reverse-verify. */
  readonly rejectedQuotes: number;
  /** Offered identities newly written to the watermark this turn. */
  readonly watermarked: number;
  readonly volumeRecordFile: string;
  readonly humanViewFile: string;
  /**
   * What this turn's collection amounted to. A turn whose every row was
   * dropped is `nothing-appended`, never `empty-selection` — the diarist
   * selecting nothing and the safeguard band rejecting everything are
   * different events. Why rows were dropped is `failureCauses`.
   */
  readonly collectorStatus:
    | "ok"
    | "empty-selection"
    | "nothing-appended"
    | "skipped-no-fresh";
  /**
   * 失败真因: empty when every submitted row landed. Populated whenever rows
   * were dropped — including a partial turn whose collectorStatus is `ok`.
   */
  readonly failureCauses: readonly DiaristFailureCause[];
};

/**
 * Mechanical half B — commit the diarist turn's selections.
 * Verbatim reverse-verify → idempotent sitian append → watermark → human view.
 * Verify failure records a single typed diagnostic and drops that selection; it
 * never bounces the receipt (第 0 条) and never enters the volume as an entry.
 */
export async function commitDiaristSelections(input: {
  readonly catalog: DiaristSourceCatalog;
  readonly selections: readonly DiaristSelection[];
}): Promise<DiaristCommitFacts> {
  const { ticketNumber, cwd } = input.catalog;
  const homeOpt = input.catalog.home === undefined ? {} : { home: input.catalog.home };
  const volumePaths = ensureTicketProvenanceVolume(ticketNumber, cwd, input.catalog.home);

  const anchors: DiaristAnchorSet = buildDiaristAnchors({ ticketNumber });
  const accepted: TicketProvenanceEntry[] = [];
  let rejectedQuotes = 0;
  let unknownCandidate = false;

  for (const selection of input.selections) {
    const block = input.catalog.candidates[selection.candidateIndex];
    if (block === undefined) {
      unknownCandidate = true;
      continue;
    }
    const projected = blockToLlmEntry(block, {
      anchors,
      quotes: selection.quotes,
      ...(selection.note === undefined ? {} : { note: selection.note }),
    });
    if (!projected.ok) {
      rejectedQuotes += 1;
      // Single diagnostic expression — never a disguised diary entry.
      appendQuoteVerifyFailureDiagnostic({
        ticketNumber,
        cwd,
        ...homeOpt,
        cause: projected.cause,
      });
      continue;
    }
    appendTicketProvenanceEntry({
      ticketNumber,
      cwd,
      ...homeOpt,
      entry: projected.entry,
      source: "diarist",
    });
    accepted.push(projected.entry);
  }

  // Watermark advances only after the durable volume writes above, so a crash
  // mid-commit retries the batch on the next summons. Entry identity and
  // quote-verify diagnostic identity are stable — retry duplicates neither.
  const identities = input.catalog.candidates.map((block) =>
    blockEntryIdentity(ticketNumber, block),
  );
  const alreadyWatermarked = readOfferedIdentities(ticketNumber, cwd, input.catalog.home);
  const watermarked = identities.filter((identity) => !alreadyWatermarked.has(identity)).length;
  recordOfferedIdentities({ ticketNumber, cwd, ...homeOpt, identities });

  // Refresh the human view from the full volume (includes prior summons).
  const volume = await readTicketProvenance(ticketNumber, cwd, input.catalog.home);
  const humanViewFile = writeTicketProvenanceHumanView({
    ticketNumber,
    cwd,
    ...homeOpt,
    entries: volume.entries,
  });

  return {
    ticketNumber,
    offered: input.catalog.candidates.length,
    appended: accepted.length,
    rejectedQuotes,
    watermarked,
    volumeRecordFile: volumePaths.recordFile,
    humanViewFile,
    collectorStatus:
      input.catalog.candidates.length === 0
        ? "skipped-no-fresh"
        : accepted.length > 0
          ? "ok"
          : input.selections.length === 0
            ? "empty-selection"
            : "nothing-appended",
    failureCauses: [
      ...(unknownCandidate ? (["unknown-candidate"] as const) : []),
      ...(rejectedQuotes > 0 ? (["quote-verify-rejected"] as const) : []),
    ],
  };
}
