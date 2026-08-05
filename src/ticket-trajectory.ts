/**
 * Single-ticket trajectory tracer (factory board S1).
 *
 * Mechanism, not a role: deterministic scan → HTML. Unique seam:
 *   (ledgerDir, ticketSnapshot, now) → HTML
 *
 * Station resolution (four-layer fallback):
 *   1) terminating tool name inside the session (ak_<role>_output)
 *   2) invocation.json role
 *   3) run-directory name heuristic
 *   4) unknown (still listed; never dropped)
 *
 * Receipt trust: only successful toolResults that pass typed contract
 * validation count as round results. Prior rejected attempts stay attempts.
 *
 * Page lifecycle: startTicketTrajectoryPage owns refresh regeneration to an
 * explicit output path outside the ledger and declares the bound; one-shot
 * write does not advertise refresh. Regeneration faults surface the original
 * cause via handle.closed / stop(). Caller stops the handle.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  AcceptedDetailsContractError,
  acceptedFacts,
  isTerminatingToolName,
  validateAcceptedDetails,
  type TerminatingToolName,
} from "./package-contracts/terminating-tools.ts";
import { PACKAGED_ROLE_REGISTRY } from "./packaged-role-registry.ts";

/** Declared refresh bound for the same viewing surface (seconds). */
export const DEFAULT_REFRESH_BOUNDARY_SECONDS = 30;

/** Minimal ticket snapshot stub for S1 (no GitHub adapter). */
export type TicketSnapshot = {
  issueNumber: number;
};

export type StationSource = "tool" | "invocation" | "name" | "unknown";

/** Injected clock + scheduler so tests drive the production lifecycle without wall sleep. */
export type TrajectoryClock = () => Date;
export type TrajectoryScheduler = {
  /** Schedule `tick` every `ms` milliseconds; return a cancel function. */
  every: (ms: number, tick: () => void) => () => void;
};

export type TicketTrajectoryPageHandle = {
  readonly outputPath: string;
  /** Settles when the first page write finishes (or rejects on first failure). */
  readonly started: Promise<{ outputPath: string; html: string }>;
  /**
   * Settles when the lifecycle ends.
   * Resolves on a clean stop with no regeneration fault; rejects with the
   * original cause when a post-start regeneration fails (or the initial write fails).
   */
  readonly closed: Promise<void>;
  /**
   * Stop further regeneration. In-flight write is awaited.
   * Re-throws the original regeneration failure when the lifecycle faulted.
   */
  stop: () => Promise<void>;
};

type SessionRow = Record<string, unknown>;

type ParsedRun = {
  runId: string;
  ledgerCoord: string;
  evidenceHref: string;
  startedAt?: string;
  station: string;
  stationSource: StationSource;
  attemptCount: number;
  hasResult: boolean;
  /** Receipt-level status when the terminating contract carries one. */
  resultStatus: string;
  /** Collector typed leg terminal states (distinct, stable order). */
  legStatuses: readonly string[];
  model: string;
  provider: string;
  thinking: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/** realpath when the node exists; lexical path only for recognized absence — never for other errors. */
async function realpathOrLexicalIfMissing(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isMissingPathError(error)) return path;
    throw error;
  }
}

const TOOL_TO_ROLE: ReadonlyMap<string, string> = new Map(
  PACKAGED_ROLE_REGISTRY.map((entry) => [entry.outputTool, entry.role]),
);

const NAME_PREFIX_ROLES: readonly string[] = PACKAGED_ROLE_REGISTRY.map((entry) => entry.role);

function roleFromToolName(toolName: string): string | undefined {
  return TOOL_TO_ROLE.get(toolName);
}

function roleFromRunName(runId: string): string | undefined {
  const base = runId.split("@")[0] ?? runId;
  const lower = base.toLowerCase();
  // plan-court / *-court* → judge (ticket-court family)
  if (/(^|[-_])court([-_]|$)/.test(lower) || lower.startsWith("plan-court")) return "judge";
  for (const role of NAME_PREFIX_ROLES) {
    if (lower === role || lower.startsWith(`${role}-`) || lower.startsWith(`${role}_`)) return role;
  }
  // review-* shorthand used heavily in the home ledger
  if (lower.startsWith("review")) return "reviewer";
  return undefined;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function attr(value: string): string {
  return escapeHtml(value);
}

/**
 * Read session JSONL with honest live-tail semantics:
 * a malformed line is tolerated only when it is an unfinished final
 * fragment at EOF (no record terminator after it). Any malformed line
 * completed by a line terminator must fail loudly with file and 1-based
 * line context — even when no non-empty record follows — never silently
 * under-count.
 */
export async function readLedgerSessionJsonl(path: string): Promise<SessionRow[]> {
  const text = await readFile(path, "utf8");
  // split keeps a trailing empty segment iff text ends with "\n", so
  // index < lines.length - 1 means this segment was terminated.
  const lines = text.split("\n");
  const rows: SessionRow[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      const completedByTerminator = index < lines.length - 1;
      if (completedByTerminator) {
        throw new Error(
          `malformed JSONL record in ${path} at line ${index + 1}: ${error.message}`,
        );
      }
      // unfinished fragment at EOF — keep prior complete rows
      break;
    }
    // Syntactically complete line: must be a session object. Silent omission
    // would under-count ledger evidence (failure honesty).
    if (!isRecord(row)) {
      const kind = row === null ? "null" : Array.isArray(row) ? "array" : typeof row;
      throw new Error(
        `complete non-object JSONL record in ${path} at line ${index + 1}: expected object, got ${kind}`,
      );
    }
    rows.push(row);
  }
  return rows;
}

function extractModelFields(rows: SessionRow[]): { model: string; provider: string; thinking: string } {
  let model = "";
  let provider = "";
  let thinking = "";
  for (const row of rows) {
    if (row.type === "model_change") {
      if (typeof row.provider === "string" && row.provider) provider = row.provider;
      if (typeof row.modelId === "string" && row.modelId) model = row.modelId;
    }
    if (row.type === "thinking_level_change" && typeof row.thinkingLevel === "string" && row.thinkingLevel) {
      thinking = row.thinkingLevel;
    }
    const message = isRecord(row.message) ? row.message : undefined;
    if (message?.role === "assistant") {
      if (typeof message.model === "string" && message.model) model = message.model;
      if (typeof message.provider === "string" && message.provider) provider = message.provider;
    }
  }
  return { model, provider, thinking };
}

function extractTerminatingLifecycle(rows: SessionRow[]): {
  attemptCount: number;
  toolNames: string[];
  hasResult: boolean;
  resultStatus: string;
  legStatuses: readonly string[];
} {
  let callAttempts = 0;
  let resultAttempts = 0;
  const toolNames: string[] = [];
  let hasResult = false;
  let resultStatus = "";
  let legStatuses: readonly string[] = [];

  for (const row of rows) {
    const message = isRecord(row.message) ? row.message : undefined;
    if (!message) continue;

    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!isRecord(part) || part.type !== "toolCall") continue;
        const name = part.name;
        if (typeof name === "string" && isTerminatingToolName(name)) {
          callAttempts += 1;
          toolNames.push(name);
        }
      }
    }

    if (message.role === "toolResult" && typeof message.toolName === "string" && isTerminatingToolName(message.toolName)) {
      resultAttempts += 1;
      toolNames.push(message.toolName);
      if (message.isError === true) continue;
      if (!isRecord(message.details)) continue;
      try {
        const details = validateAcceptedDetails(message.toolName as TerminatingToolName, message.details);
        const facts = acceptedFacts(message.toolName as TerminatingToolName, details);
        hasResult = true;
        resultStatus = facts.status ?? "";
        legStatuses = facts.legStatuses ?? [];
      } catch (error) {
        if (error instanceof AcceptedDetailsContractError) continue;
        throw error;
      }
    }
  }

  // Prefer toolCall count; fall back to toolResult count when calls were clipped away.
  const attemptCount = callAttempts > 0 ? callAttempts : resultAttempts;
  return { attemptCount, toolNames, hasResult, resultStatus, legStatuses };
}

/** Human-read formatting only — machines consume legStatuses typed field / data attr items. */
function formatLegStatusesForDisplay(legStatuses: readonly string[]): string {
  return legStatuses.join(", ");
}

type InvocationInfo = {
  role?: string;
  model?: string;
  provider?: string;
  thinking?: string;
};

async function readInvocation(runDir: string): Promise<InvocationInfo | undefined> {
  try {
    const raw = await readFile(join(runDir, "invocation.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return undefined;
    const info: InvocationInfo = {};
    if (typeof parsed.role === "string" && parsed.role.trim()) info.role = parsed.role.trim();
    if (typeof parsed.thinking === "string" && parsed.thinking.trim()) info.thinking = parsed.thinking.trim();
    if (typeof parsed.model === "string" && parsed.model.trim()) {
      const rawModel = parsed.model.trim();
      if (rawModel.includes("/")) {
        const slash = rawModel.indexOf("/");
        info.provider = rawModel.slice(0, slash);
        info.model = rawModel.slice(slash + 1);
      } else {
        info.model = rawModel;
      }
    }
    return info;
  } catch (error) {
    // Only genuine absence activates the invocation fallback. Malformed JSON and
    // unexpected IO failures retain their cause — never relabeled as "no invocation."
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

function resolveStation(input: {
  toolNames: string[];
  invocationRole?: string;
  runId: string;
}): { station: string; stationSource: StationSource } {
  for (const toolName of input.toolNames) {
    const role = roleFromToolName(toolName);
    if (role) return { station: role, stationSource: "tool" };
  }
  // Also accept tool names observed only via accepted results order
  if (input.invocationRole) {
    return { station: input.invocationRole, stationSource: "invocation" };
  }
  const byName = roleFromRunName(input.runId);
  if (byName) return { station: byName, stationSource: "name" };
  return { station: "unknown", stationSource: "unknown" };
}

async function listSessionFiles(sessionDir: string): Promise<string[]> {
  try {
    const entries = await readdir(sessionDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(sessionDir, entry.name))
      .sort();
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
}

async function parseRun(ledgerDir: string, issueNumber: number, runId: string): Promise<ParsedRun> {
  const runDir = join(ledgerDir, "issues", String(issueNumber), "runs", runId);
  const ledgerCoord = ["issues", String(issueNumber), "runs", runId].join("/");
  const evidenceTarget = await realpathOrLexicalIfMissing(runDir);
  const evidenceHref = pathToFileURL(evidenceTarget).href;
  const sessionFiles = await listSessionFiles(join(runDir, "session"));
  const rows: SessionRow[] = [];
  for (const file of sessionFiles) {
    rows.push(...(await readLedgerSessionJsonl(file)));
  }

  let startedAt: string | undefined;
  for (const row of rows) {
    if (row.type === "session" && typeof row.timestamp === "string") {
      startedAt = row.timestamp;
      break;
    }
    if (!startedAt && typeof row.timestamp === "string") startedAt = row.timestamp;
  }

  const lifecycle = extractTerminatingLifecycle(rows);
  const models = extractModelFields(rows);
  const invocation = await readInvocation(runDir);
  const { station, stationSource } = resolveStation({
    toolNames: lifecycle.toolNames,
    runId,
    ...(invocation?.role !== undefined ? { invocationRole: invocation.role } : {}),
  });

  // Session mechanical fields win; invocation.json fills gaps only.
  let { model, provider, thinking } = models;
  if (invocation) {
    if (!thinking && invocation.thinking) thinking = invocation.thinking;
    if (!provider && invocation.provider) provider = invocation.provider;
    if (!model && invocation.model) model = invocation.model;
  }

  return {
    runId,
    ledgerCoord,
    evidenceHref,
    ...(startedAt !== undefined ? { startedAt } : {}),
    station,
    stationSource,
    attemptCount: lifecycle.attemptCount,
    hasResult: lifecycle.hasResult,
    resultStatus: lifecycle.resultStatus,
    legStatuses: lifecycle.legStatuses,
    model,
    provider,
    thinking,
  };
}

async function listRunIds(ledgerDir: string, issueNumber: number): Promise<string[]> {
  const runsDir = join(ledgerDir, "issues", String(issueNumber), "runs");
  try {
    const entries = await readdir(runsDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
}

function renderHtml(input: {
  issueNumber: number;
  generatedAt: string;
  /** When set, page declares a refresh bound backed by active regeneration. Omit for one-shot. */
  refreshBoundarySeconds?: number;
  runs: ParsedRun[];
}): string {
  const refreshActive =
    input.refreshBoundarySeconds !== undefined &&
    Number.isFinite(input.refreshBoundarySeconds) &&
    input.refreshBoundarySeconds > 0;
  const refreshBoundarySeconds = refreshActive ? input.refreshBoundarySeconds! : undefined;
  // Group by station preserving first-seen chronological order.
  const stationOrder: string[] = [];
  const byStation = new Map<string, ParsedRun[]>();
  const sortedRuns = [...input.runs].sort((a, b) => {
    const at = a.startedAt ?? "";
    const bt = b.startedAt ?? "";
    if (at !== bt) return at.localeCompare(bt);
    return a.runId.localeCompare(b.runId);
  });
  for (const run of sortedRuns) {
    if (!byStation.has(run.station)) {
      byStation.set(run.station, []);
      stationOrder.push(run.station);
    }
    byStation.get(run.station)!.push(run);
  }

  const stationBlocks = stationOrder.map((station) => {
    const rounds = byStation.get(station)!;
    const stationLabel = station === "unknown" ? "未知站" : station;
    const roundHtml = rounds
      .map((run) => {
        const resultDisplay = run.hasResult
          ? run.resultStatus ||
            (run.legStatuses.length > 0 ? formatLegStatusesForDisplay(run.legStatuses) : "")
          : "";
        // Machine channel: space-separated closed-enum tokens (no custom status dialect).
        const legStatusesAttr = run.legStatuses.join(" ");
        return [
          `<article class="run"`,
          ` data-run-id="${attr(run.runId)}"`,
          ` data-station="${attr(run.station)}"`,
          ` data-station-source="${attr(run.stationSource)}"`,
          ` data-ledger-coord="${attr(run.ledgerCoord)}"`,
          ` data-attempt-count="${attr(String(run.attemptCount))}"`,
          ` data-has-result="${run.hasResult ? "true" : "false"}"`,
          ` data-result-status="${attr(run.resultStatus)}"`,
          ` data-leg-statuses="${attr(legStatusesAttr)}"`,
          ` data-model="${attr(run.model)}"`,
          ` data-provider="${attr(run.provider)}"`,
          ` data-thinking="${attr(run.thinking)}"`,
          `>`,
          `<header class="run-head">`,
          `<span class="run-id">${escapeHtml(run.runId)}</span>`,
          run.model || run.provider || run.thinking
            ? `<span class="run-model">${escapeHtml([run.provider, run.model].filter(Boolean).join("/"))}${run.thinking ? ` · ${escapeHtml(run.thinking)}` : ""}</span>`
            : "",
          `</header>`,
          `<p class="run-meta">`,
          `<span class="attempts">attempts: ${run.attemptCount}</span>`,
          run.hasResult
            ? `<span class="result">result: ${escapeHtml(resultDisplay)}</span>`
            : `<span class="result">result: (none — attempts only)</span>`,
          `</p>`,
          `<p class="ledger"><a data-ledger-link="${attr(run.ledgerCoord)}" href="${attr(run.evidenceHref)}">${escapeHtml(run.ledgerCoord)}</a></p>`,
          `</article>`,
        ].join("");
      })
      .join("\n");

    return [
      `<section class="station" data-station-block="${attr(station)}" data-round-count="${rounds.length}">`,
      `<h2 class="station-title">${escapeHtml(stationLabel)} · ${rounds.length} 轮</h2>`,
      roundHtml,
      `</section>`,
    ].join("\n");
  });

  const lifecycleAttrs = refreshActive
    ? ` data-lifecycle="refresh" data-refresh-boundary-seconds="${attr(String(refreshBoundarySeconds))}"`
    : ` data-lifecycle="oneshot"`;
  const refreshMeta = refreshActive
    ? `
<meta http-equiv="refresh" content="${attr(String(refreshBoundarySeconds))}"/>`
    : "";
  const refreshNote = refreshActive
    ? `\n    · refresh ≤ ${escapeHtml(String(refreshBoundarySeconds))}s`
    : "";

  return `<!DOCTYPE html>
<html lang="zh-CN"
  data-issue="${attr(String(input.issueNumber))}"
  data-generated-at="${attr(input.generatedAt)}"${lifecycleAttrs}
>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>${refreshMeta}
<title>Ticket #${escapeHtml(String(input.issueNumber))} trajectory</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.45; }
  body { margin: 0 auto; padding: 1rem; max-width: 52rem; }
  header.page { margin-bottom: 1rem; }
  .generated { font-size: 0.9rem; opacity: 0.8; }
  .station { border: 1px solid color-mix(in srgb, CanvasText 20%, Canvas); border-radius: 0.5rem; padding: 0.75rem; margin: 0.75rem 0; }
  .station-title { margin: 0 0 0.5rem; font-size: 1.1rem; }
  .run { padding: 0.5rem 0; border-top: 1px solid color-mix(in srgb, CanvasText 12%, Canvas); }
  .run:first-of-type { border-top: 0; }
  .run-head { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; justify-content: space-between; }
  .run-id { font-family: ui-monospace, monospace; font-size: 0.9rem; word-break: break-all; }
  .run-model { font-size: 0.85rem; opacity: 0.85; }
  .run-meta { margin: 0.25rem 0; font-size: 0.9rem; display: flex; flex-wrap: wrap; gap: 0.75rem; }
  .ledger { margin: 0.25rem 0 0; font-size: 0.8rem; word-break: break-all; }
  @media (max-width: 640px) {
    body { padding: 0.75rem; }
    .run-head { flex-direction: column; }
  }
</style>
</head>
<body>
<header class="page">
  <h1>Ticket #${escapeHtml(String(input.issueNumber))} · 驿传轨迹</h1>
  <p class="generated">generated-at <time datetime="${attr(input.generatedAt)}">${escapeHtml(input.generatedAt)}</time>${refreshNote}</p>
</header>
<main data-run-count="${sortedRuns.length}">
${stationBlocks.join("\n") || "<p data-empty=\"true\">no runs</p>"}
</main>
</body>
</html>
`;
}

/**
 * Unique production seam: pure scan of the ledger + snapshot + now → HTML.
 * Read-only against the ledger. Snapshot is the S1 minimal stub.
 */
export async function renderTicketTrajectoryHtml(
  ledgerDir: string,
  ticketSnapshot: TicketSnapshot,
  now: Date,
  options?: { refreshBoundarySeconds?: number },
): Promise<string> {
  if (!isRecord(ticketSnapshot) || typeof ticketSnapshot.issueNumber !== "number" || !Number.isInteger(ticketSnapshot.issueNumber) || ticketSnapshot.issueNumber < 1) {
    throw new Error("ticketSnapshot.issueNumber must be a positive integer");
  }
  const issueNumber = ticketSnapshot.issueNumber;
  const root = resolve(ledgerDir);
  const runIds = await listRunIds(root, issueNumber);
  const runs: ParsedRun[] = [];
  for (const runId of runIds) {
    runs.push(await parseRun(root, issueNumber, runId));
  }
  const generatedAt = now.toISOString();
  // One-shot by default: only an explicit positive bound declares self-refresh,
  // and only callers that actually regenerate (startTicketTrajectoryPage) pass it.
  return renderHtml({
    issueNumber,
    generatedAt,
    runs,
    ...(options?.refreshBoundarySeconds !== undefined
      ? { refreshBoundarySeconds: options.refreshBoundarySeconds }
      : {}),
  });
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(".."));
}

/**
 * Resolve the prospective on-disk target of outputPath and refuse any landing
 * inside the ledger — including when the path, a parent, or a trailing segment
 * is a symlink into the ledger tree.
 */
export async function assertTrajectoryOutputOutsideLedger(
  ledgerDir: string,
  outputPath: string,
): Promise<{ ledgerRoot: string; outputAbsolute: string; prospectiveReal: string }> {
  const ledgerResolved = resolve(ledgerDir);
  let ledgerRoot: string;
  try {
    ledgerRoot = await realpath(ledgerResolved);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    ledgerRoot = ledgerResolved;
  }
  const outputAbsolute = resolve(outputPath);

  // Walk up until an existing filesystem node is found; realpath that prefix
  // and rejoin the missing tail so symlink parents are fully followed.
  const missingTail: string[] = [];
  let cursor = outputAbsolute;
  for (;;) {
    try {
      await lstat(cursor);
      break;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) break;
      missingTail.push(basename(cursor));
      cursor = parent;
    }
  }

  let realPrefix: string;
  try {
    realPrefix = await realpath(cursor);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    realPrefix = resolve(cursor);
  }

  const prospectiveReal =
    missingTail.length === 0 ? realPrefix : resolve(realPrefix, ...missingTail.reverse());

  if (isPathInside(ledgerRoot, prospectiveReal) || isPathInside(ledgerRoot, realPrefix)) {
    throw new Error("ticket trajectory outputPath must be outside the ledger directory");
  }

  // Lexical absolute path must also stay outside (defense in depth before mkdir).
  if (isPathInside(ledgerRoot, outputAbsolute)) {
    throw new Error("ticket trajectory outputPath must be outside the ledger directory");
  }

  return { ledgerRoot, outputAbsolute, prospectiveReal };
}

/**
 * Write HTML to an explicit path outside the ledger without following an
 * existing destination inode (hard link / prior file). Temp file + rename
 * replaces the directory entry so a hard-linked ledger twin keeps its bytes.
 */
async function writeHtmlAtomicallyOutsideLedger(input: {
  ledgerRoot: string;
  outputAbsolute: string;
  html: string;
}): Promise<string> {
  const parent = dirname(input.outputAbsolute);
  await mkdir(parent, { recursive: true });

  // Re-resolve after mkdir: a race or symlink parent must still land outside.
  const parentReal = await realpath(parent);
  if (isPathInside(input.ledgerRoot, parentReal)) {
    throw new Error("ticket trajectory outputPath must be outside the ledger directory");
  }

  const destinationReal = resolve(parentReal, basename(input.outputAbsolute));
  if (isPathInside(input.ledgerRoot, destinationReal)) {
    throw new Error("ticket trajectory outputPath must be outside the ledger directory");
  }

  // Refuse to write through an existing symlink whose target is inside the ledger.
  try {
    const existing = await lstat(input.outputAbsolute);
    if (existing.isSymbolicLink()) {
      const target = await realpath(input.outputAbsolute);
      if (isPathInside(input.ledgerRoot, target)) {
        throw new Error("ticket trajectory outputPath must be outside the ledger directory");
      }
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }

  // Same-directory temp + rename: does not open/truncate an existing inode, so a
  // hard link from outputPath into the ledger cannot smuggle writes back home.
  const temporary = join(parent, `.ticket-trajectory-${randomUUID()}.html.tmp`);
  try {
    await writeFile(temporary, input.html, "utf8");
    await rename(temporary, input.outputAbsolute);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return realpath(input.outputAbsolute);
}

/**
 * Page write seam: render via the unique seam and write ONLY to an explicit
 * path outside the ledger. Caller owns output location.
 */
export async function writeTicketTrajectoryPage(input: {
  ledgerDir: string;
  ticketSnapshot: TicketSnapshot;
  now: Date;
  outputPath: string;
  refreshBoundarySeconds?: number;
}): Promise<{ outputPath: string; html: string }> {
  const gate = await assertTrajectoryOutputOutsideLedger(input.ledgerDir, input.outputPath);

  const html = await renderTicketTrajectoryHtml(
    input.ledgerDir,
    input.ticketSnapshot,
    input.now,
    input.refreshBoundarySeconds !== undefined
      ? { refreshBoundarySeconds: input.refreshBoundarySeconds }
      : undefined,
  );

  const outputPath = await writeHtmlAtomicallyOutsideLedger({
    ledgerRoot: gate.ledgerRoot,
    outputAbsolute: gate.outputAbsolute,
    html,
  });
  return { outputPath, html };
}

const defaultScheduler: TrajectoryScheduler = {
  every(ms, tick) {
    const timer = setInterval(tick, ms);
    // Allow the process to exit naturally if the caller forgets stop in scripts.
    timer.unref?.();
    return () => clearInterval(timer);
  },
};

/**
 * Production page lifecycle: write immediately, then regenerate on the declared
 * refresh boundary so the same viewing surface observes new runs / generated-at.
 * Stop cancels further regeneration. A post-start regeneration failure faults the
 * lifecycle with the original cause (no silent continuation). Ledger remains read-only.
 */
export function startTicketTrajectoryPage(input: {
  ledgerDir: string;
  ticketSnapshot: TicketSnapshot;
  outputPath: string;
  refreshBoundarySeconds?: number;
  clock?: TrajectoryClock;
  scheduler?: TrajectoryScheduler;
}): TicketTrajectoryPageHandle {
  const refreshBoundarySeconds = input.refreshBoundarySeconds ?? DEFAULT_REFRESH_BOUNDARY_SECONDS;
  if (!(refreshBoundarySeconds > 0) || !Number.isFinite(refreshBoundarySeconds)) {
    throw new Error("refreshBoundarySeconds must be a positive finite number");
  }
  const clock = input.clock ?? (() => new Date());
  const scheduler = input.scheduler ?? defaultScheduler;

  let stopped = false;
  let cancel: (() => void) | undefined;
  let inFlight: Promise<void> | undefined;
  let lastRejection: unknown;
  let closedSettled = false;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  // Prevent unhandled-rejection crashes when callers only await stop()/started.
  void closed.catch(() => undefined);

  const fault = (error: unknown): void => {
    if (lastRejection !== undefined) return;
    lastRejection = error;
    stopped = true;
    cancel?.();
    cancel = undefined;
    if (!closedSettled) {
      closedSettled = true;
      rejectClosed(error);
    }
  };

  const settleClean = (): void => {
    if (closedSettled) return;
    closedSettled = true;
    resolveClosed();
  };

  const writeOnce = async (): Promise<{ outputPath: string; html: string }> => {
    if (stopped && lastRejection === undefined) {
      throw new Error("ticket trajectory page lifecycle already stopped");
    }
    if (lastRejection !== undefined) throw lastRejection;
    return writeTicketTrajectoryPage({
      ledgerDir: input.ledgerDir,
      ticketSnapshot: input.ticketSnapshot,
      now: clock(),
      outputPath: input.outputPath,
      refreshBoundarySeconds,
    });
  };

  const queueWrite = (): void => {
    if (stopped || lastRejection !== undefined) return;
    inFlight = (inFlight ?? Promise.resolve()).then(async () => {
      if (stopped || lastRejection !== undefined) return;
      try {
        await writeOnce();
      } catch (error) {
        fault(error);
      }
    });
  };

  const started = writeOnce()
    .then((first) => {
      if (stopped || lastRejection !== undefined) return first;
      const intervalMs = Math.max(1, Math.round(refreshBoundarySeconds * 1000));
      cancel = scheduler.every(intervalMs, () => {
        queueWrite();
      });
      return first;
    })
    .catch((error) => {
      fault(error);
      throw error;
    });

  // Capture output path from the absolute resolution even before first write settles.
  const outputPath = resolve(input.outputPath);

  return {
    outputPath,
    started,
    closed,
    async stop() {
      stopped = true;
      cancel?.();
      cancel = undefined;
      await started.catch(() => undefined);
      if (inFlight) await inFlight.catch(() => undefined);
      if (lastRejection !== undefined) {
        // closed already rejected with the original cause
        throw lastRejection;
      }
      settleClean();
    },
  };
}
