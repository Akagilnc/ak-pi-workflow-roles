/**
 * Factory board full view (S2+S3).
 *
 * Unique render seam: (books, view, now) → HTML.
 * - books: explicit bookKey + ledgerDir (no git-remote guess)
 * - view: BoardSnapshot success OR loud binding/api error
 * - now: injected clock for unaccepted bands, leg age, wall-now rule
 *
 * Reuses S1 tracer (`loadTicketTrajectoryRuns` + station HTML) for each ticket.
 * Owns swimlanes, family aggregation, blocked badges, closed drill, and S3
 * latest-run four-state / wallclock / cost aggregation (no parallel receipt parser).
 *
 * Page lifecycle: startFactoryBoardPage owns refresh regeneration to an explicit
 * output path outside every ledger and declares the bound; one-shot write does
 * not advertise refresh. Snapshot bindings stay fixed; each tick re-reads ledgers.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  DEFAULT_REFRESH_BOUNDARY_SECONDS,
  loadTicketTrajectoryRuns,
  renderTicketTrajectoryStationHtml,
  type TicketTrajectoryRun,
  type TrajectoryClock,
  type TrajectoryScheduler,
} from "./ticket-trajectory.ts";
import type { BoardSnapshot, SnapshotTicket, TicketIssueState } from "./ticket-snapshot.ts";

/** Unaccepted latest-run mtime bands (page-visible thresholds). */
export const UNACCEPTED_FLYING_MS = 2 * 60 * 1000;
export const UNACCEPTED_WATCH_MS = 15 * 60 * 1000;

/** Same declared refresh bound as the S1 trajectory surface (seconds). */
export { DEFAULT_REFRESH_BOUNDARY_SECONDS };

/** Injected clock + scheduler for the production board lifecycle. */
export type FactoryBoardClock = TrajectoryClock;
export type FactoryBoardScheduler = TrajectoryScheduler;

export type FactoryBoardPageHandle = {
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

/** Latest-run four-state (blocked is a badge, never a state). */
export type TicketCurrentState =
  | "closed"
  | "pending"
  | "unaccepted-flying"
  | "unaccepted-watch"
  | "unaccepted-suspect"
  | "accepted-awaiting";

export type FactoryBoardBook = {
  bookKey: string;
  ledgerDir: string;
};

export type FactoryBoardError = {
  kind: "binding" | "api";
  message: string;
  bookKey?: string;
};

export type FactoryBoardView =
  | { ok: true; snapshot: BoardSnapshot }
  | { ok: false; error: FactoryBoardError };

type PreparedTicket = {
  ticket: SnapshotTicket;
  runs: TicketTrajectoryRun[];
  /** Display runs with wallMs applying the latest-unaccepted→now rule. */
  displayRuns: TicketTrajectoryRun[];
  pending: boolean;
  currentState: TicketCurrentState;
  /** Incomplete blockers only (open blockers), for non-closed tickets. */
  activeBlockedBy: number[];
  costUsd: number;
  totalTokens: number;
  /** Cumulative construction wall (runs + axis legs). */
  wallMs: number;
  /** First run start → now (open) or issue closedAt (closed); never last ledger record. */
  landingCycleMs: number;
  /** Present only for unaccepted latest-run states. */
  legAgeMs?: number;
  lastActivityAt?: string;
  lastActivityMtimeMs?: number;
};

function formatUsd(value: number): string {
  return Number.isFinite(value) ? String(value) : "0";
}

function wallMsBetween(startedAt: string | undefined, endedAtIso: string | undefined): number {
  if (!startedAt || !endedAtIso) return 0;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAtIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return end - start;
}

function sortRunsByStart(runs: readonly TicketTrajectoryRun[]): TicketTrajectoryRun[] {
  return [...runs].sort((a, b) => {
    const at = a.startedAt ?? "";
    const bt = b.startedAt ?? "";
    if (at !== bt) return at.localeCompare(bt);
    return a.runId.localeCompare(b.runId);
  });
}

function unacceptedBand(mtimeMs: number, nowMs: number): TicketCurrentState {
  const age = Math.max(0, nowMs - mtimeMs);
  // Authority: <2min flying / 2–15min watch / >15min suspect (exact 15 stays watch).
  if (age < UNACCEPTED_FLYING_MS) return "unaccepted-flying";
  if (age <= UNACCEPTED_WATCH_MS) return "unaccepted-watch";
  return "unaccepted-suspect";
}

/**
 * Current state is decided only by the latest run (session-start order).
 * Historical unaccepted runs never flip the state; blocked is not a state.
 */
export function decideTicketCurrentState(input: {
  ticketState: TicketIssueState;
  runs: readonly TicketTrajectoryRun[];
  now: Date;
}): TicketCurrentState {
  if (input.ticketState === "closed") return "closed";
  if (input.runs.length === 0) return "pending";
  const latest = sortRunsByStart(input.runs).at(-1)!;
  if (!latest.hasResult) return unacceptedBand(latest.mtimeMs, input.now.getTime());
  return "accepted-awaiting";
}

function enrichRunsForBoard(
  runs: readonly TicketTrajectoryRun[],
  currentState: TicketCurrentState,
  now: Date,
): TicketTrajectoryRun[] {
  const sorted = sortRunsByStart(runs);
  const latest = sorted.at(-1);
  const extendLatest =
    latest !== undefined &&
    !latest.hasResult &&
    (currentState === "unaccepted-flying" ||
      currentState === "unaccepted-watch" ||
      currentState === "unaccepted-suspect");
  const nowIso = now.toISOString();
  return sorted.map((run) => {
    const isLatestUnaccepted = extendLatest && run.runId === latest!.runId;
    const endIso = isLatestUnaccepted ? nowIso : run.endedAt;
    const wallMs = wallMsBetween(run.startedAt, endIso);
    return { ...run, wallMs };
  });
}

function aggregateTicketMetrics(
  displayRuns: readonly TicketTrajectoryRun[],
  ticket: Pick<SnapshotTicket, "state" | "closedAt">,
  now: Date,
): { costUsd: number; totalTokens: number; wallMs: number; landingCycleMs: number } {
  let costUsd = 0;
  let totalTokens = 0;
  let wallMs = 0;
  let firstStart: string | undefined;
  for (const run of displayRuns) {
    costUsd += run.costUsd;
    totalTokens += run.totalTokens;
    wallMs += (run.wallMs ?? wallMsBetween(run.startedAt, run.endedAt)) + run.axisWallMs;
    if (run.startedAt && (firstStart === undefined || run.startedAt < firstStart)) {
      firstStart = run.startedAt;
    }
  }
  let landingCycleMs = 0;
  if (firstStart) {
    if (ticket.state === "closed") {
      // Authority (#136): 落地周期 = 首 run 起点至 now/关票 — closure, not last ledger record.
      if (!ticket.closedAt) {
        throw new Error("closed ticket landing cycle requires closedAt");
      }
      landingCycleMs = wallMsBetween(firstStart, ticket.closedAt);
    } else {
      landingCycleMs = wallMsBetween(firstStart, now.toISOString());
    }
  }
  return { costUsd, totalTokens, wallMs, landingCycleMs };
}

function currentStateLabel(state: TicketCurrentState): string {
  switch (state) {
    case "closed":
      return "closed";
    case "pending":
      return "待发";
    case "unaccepted-flying":
      return "未受理·在飞";
    case "unaccepted-watch":
      return "未受理·观察";
    case "unaccepted-suspect":
      return "未受理·疑挂";
    case "accepted-awaiting":
      return "已交卷待派";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
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

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(".."));
}

function activeBlockedBy(ticket: SnapshotTicket): number[] {
  if (ticket.state === "closed") return [];
  return ticket.blockedBy
    .filter((edge) => edge.state === "open")
    .map((edge) => edge.issueNumber)
    .sort((a, b) => a - b);
}

/** First duplicated bookKey in order, or null when all unique. */
function firstDuplicateBookKey(keys: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return null;
}

function renderErrorHtml(error: FactoryBoardError, generatedAt: string): string {
  const bookAttr =
    error.bookKey !== undefined && error.bookKey !== ""
      ? ` data-error-book="${attr(error.bookKey)}"`
      : "";
  return `<!DOCTYPE html>
<html lang="zh-CN" data-generated-at="${attr(generatedAt)}" data-board-error="${attr(error.kind)}"${bookAttr}>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Factory board error</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.45; }
  body { margin: 0 auto; padding: 1.25rem; max-width: 40rem; }
  .error {
    border: 2px solid tomato;
    background: color-mix(in srgb, tomato 12%, Canvas);
    border-radius: 0.5rem;
    padding: 1rem;
  }
  h1 { margin-top: 0; font-size: 1.25rem; }
  pre { white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body>
<main class="error" data-board-error="${attr(error.kind)}"${bookAttr}>
  <h1>工厂进度板无法加载</h1>
  <p data-error-kind="${attr(error.kind)}">错误类型：${escapeHtml(error.kind)}</p>
  ${
    error.bookKey
      ? `<p data-error-book="${attr(error.bookKey)}">册：${escapeHtml(error.bookKey)}</p>`
      : ""
  }
  <pre data-error-message="${attr(error.message)}">${escapeHtml(error.message)}</pre>
  <p class="generated">generated-at <time datetime="${attr(generatedAt)}">${escapeHtml(generatedAt)}</time></p>
</main>
</body>
</html>
`;
}

function renderTicketArticle(input: {
  bookKey: string;
  prepared: PreparedTicket;
  nested: boolean;
}): string {
  const {
    ticket,
    runs,
    displayRuns,
    pending,
    currentState,
    activeBlockedBy: blockers,
    costUsd,
    totalTokens,
    wallMs,
    landingCycleMs,
    legAgeMs,
    lastActivityAt,
    lastActivityMtimeMs,
  } = input.prepared;
  const state: TicketIssueState = ticket.state;
  const milestone = ticket.milestone ?? "";
  const blockedAttr = blockers.join(" ");
  const badges = blockers
    .map(
      (n) =>
        `<span class="blocked-badge" data-blocked-badge="${attr(String(n))}" data-book="${attr(input.bookKey)}" data-ticket="${attr(String(ticket.issueNumber))}">等 #${escapeHtml(String(n))}</span>`,
    )
    .join(" ");
  const trajectory =
    displayRuns.length > 0
      ? `<div class="trajectory" data-trajectory="true">${renderTicketTrajectoryStationHtml(displayRuns)}</div>`
      : pending
        ? `<p class="pending-label" data-pending-label="true">待发（零卷）</p>`
        : `<p class="pending-label" data-empty-trajectory="true">no runs</p>`;

  const parentAttr =
    ticket.parentIssueNumber !== null
      ? ` data-parent-issue="${attr(String(ticket.parentIssueNumber))}"`
      : "";

  const unaccepted =
    currentState === "unaccepted-flying" ||
    currentState === "unaccepted-watch" ||
    currentState === "unaccepted-suspect";
  const activityBits =
    unaccepted && legAgeMs !== undefined
      ? [
          `<span class="leg-age" data-leg-age-ms="${attr(String(legAgeMs))}">腿龄 ${legAgeMs}ms</span>`,
          lastActivityAt
            ? `<span class="last-activity" data-last-activity-at="${attr(lastActivityAt)}"${lastActivityMtimeMs !== undefined ? ` data-last-activity-mtime-ms="${attr(String(lastActivityMtimeMs))}"` : ""}>末次活动 ${escapeHtml(lastActivityAt)}</span>`
            : lastActivityMtimeMs !== undefined
              ? `<span class="last-activity" data-last-activity-mtime-ms="${attr(String(lastActivityMtimeMs))}">末次活动 mtime</span>`
              : "",
        ].join("")
      : "";

  return [
    `<article class="ticket${input.nested ? " ticket-child" : ""} current-${attr(currentState)}"`,
    ` data-ticket="${attr(String(ticket.issueNumber))}"`,
    ` data-book="${attr(input.bookKey)}"`,
    ` data-title="${attr(ticket.title)}"`,
    ` data-milestone="${attr(milestone)}"`,
    ` data-ticket-state="${attr(state)}"`,
    ` data-current-state="${attr(currentState)}"`,
    ` data-pending="${pending ? "true" : "false"}"`,
    ` data-blocked-by="${attr(blockedAttr)}"`,
    ` data-run-count="${attr(String(runs.length))}"`,
    ` data-cost-usd="${attr(formatUsd(costUsd))}"`,
    ` data-total-tokens="${attr(String(totalTokens))}"`,
    ` data-wall-ms="${attr(String(wallMs))}"`,
    ` data-landing-cycle-ms="${attr(String(landingCycleMs))}"`,
    legAgeMs !== undefined ? ` data-leg-age-ms="${attr(String(legAgeMs))}"` : "",
    lastActivityAt ? ` data-last-activity-at="${attr(lastActivityAt)}"` : "",
    lastActivityMtimeMs !== undefined
      ? ` data-last-activity-mtime-ms="${attr(String(lastActivityMtimeMs))}"`
      : "",
    parentAttr,
    `>`,
    `<header class="ticket-head">`,
    `<h3 class="ticket-title">#${escapeHtml(String(ticket.issueNumber))} · ${escapeHtml(ticket.title)}</h3>`,
    `<p class="ticket-meta">`,
    `<span class="state" data-state-label="${attr(currentState)}">${escapeHtml(currentStateLabel(currentState))}</span>`,
    milestone ? `<span class="milestone">milestone: ${escapeHtml(milestone)}</span>` : `<span class="milestone">milestone: —</span>`,
    `<span class="cost" data-cost-label="true">$${escapeHtml(formatUsd(costUsd))} · ${totalTokens} tok</span>`,
    `<span class="wall" data-wall-label="true">施工墙钟 ${wallMs}ms</span>`,
    `<span class="landing" data-landing-label="true">落地周期 ${landingCycleMs}ms</span>`,
    activityBits,
    badges,
    `</p>`,
    `</header>`,
    runs.length > 0
      ? `<details class="ticket-body" data-drill="${attr(String(ticket.issueNumber))}"${state === "closed" ? " open" : ""}><summary>轨迹 · ${runs.length} run(s) · $${escapeHtml(formatUsd(costUsd))}</summary>${trajectory}</details>`
      : trajectory,
    `</article>`,
  ].join("");
}

function renderFamily(input: {
  bookKey: string;
  parent: PreparedTicket;
  /** Whole in-snapshot descendant set (not only direct children). */
  descendants: PreparedTicket[];
}): string {
  const childCount = input.descendants.length;
  const pendingCount = input.descendants.filter((c) => c.pending).length;
  const closedCount = input.descendants.filter((c) => c.ticket.state === "closed").length;
  // Family lane-entry burn = parent + every in-snapshot descendant (retains S2 nest;
  // child burns such as #130 participate in the sortable family key).
  const costUsd =
    input.parent.costUsd + input.descendants.reduce((sum, d) => sum + d.costUsd, 0);
  const totalTokens =
    input.parent.totalTokens + input.descendants.reduce((sum, d) => sum + d.totalTokens, 0);
  const childHtml = input.descendants
    .map((child) =>
      renderTicketArticle({ bookKey: input.bookKey, prepared: child, nested: true }),
    )
    .join("\n");
  const parentBlock = renderTicketArticle({
    bookKey: input.bookKey,
    prepared: input.parent,
    nested: false,
  });

  return [
    `<section class="family"`,
    ` data-family="true"`,
    ` data-book="${attr(input.bookKey)}"`,
    ` data-parent="${attr(String(input.parent.ticket.issueNumber))}"`,
    ` data-child-count="${attr(String(childCount))}"`,
    ` data-pending-count="${attr(String(pendingCount))}"`,
    ` data-closed-count="${attr(String(closedCount))}"`,
    ` data-cost-usd="${attr(formatUsd(costUsd))}"`,
    ` data-total-tokens="${attr(String(totalTokens))}"`,
    `>`,
    `<header class="family-head">`,
    `<h2 class="family-title">族 #${escapeHtml(String(input.parent.ticket.issueNumber))} · ${escapeHtml(input.parent.ticket.title)}</h2>`,
    `<p class="family-agg">`,
    `<span>子轨迹 ${childCount}</span>`,
    `<span>待发 ${pendingCount}</span>`,
    `<span>收官 ${closedCount}</span>`,
    `<span class="cost" data-family-cost-label="true">$${escapeHtml(formatUsd(costUsd))} · ${totalTokens} tok</span>`,
    `</p>`,
    `</header>`,
    `<div class="family-parent">${parentBlock}</div>`,
    `<details class="family-children" data-family-expand="${attr(String(input.parent.ticket.issueNumber))}" open>`,
    `<summary>展开子轨迹（${childCount}）</summary>`,
    childHtml,
    `</details>`,
    `</section>`,
  ].join("");
}

/** Direct in-snapshot children keyed by parent issue number. */
function buildDirectChildrenByParent(
  prepared: ReadonlyMap<number, PreparedTicket>,
): Map<number, PreparedTicket[]> {
  const childrenByParent = new Map<number, PreparedTicket[]>();
  for (const item of prepared.values()) {
    const parent = item.ticket.parentIssueNumber;
    if (parent === null) continue;
    if (!prepared.has(parent)) continue; // parent not in snapshot — child stays top-level
    const list = childrenByParent.get(parent) ?? [];
    list.push(item);
    childrenByParent.set(parent, list);
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.ticket.issueNumber - b.ticket.issueNumber);
  }
  return childrenByParent;
}

/**
 * Walk native parent edges from a root and collect every in-snapshot descendant
 * once (BFS). Intermediate parents are members of the root family, not new roots.
 */
function collectDescendants(
  rootIssueNumber: number,
  childrenByParent: ReadonlyMap<number, PreparedTicket[]>,
): PreparedTicket[] {
  const out: PreparedTicket[] = [];
  const seen = new Set<number>();
  const queue = [...(childrenByParent.get(rootIssueNumber) ?? [])];
  while (queue.length > 0) {
    const item = queue.shift()!;
    const n = item.ticket.issueNumber;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(item);
    const kids = childrenByParent.get(n);
    if (kids) queue.push(...kids);
  }
  out.sort((a, b) => a.ticket.issueNumber - b.ticket.issueNumber);
  return out;
}

async function prepareTicket(
  ledgerDir: string,
  ticket: SnapshotTicket,
  now: Date,
): Promise<PreparedTicket> {
  const runs = await loadTicketTrajectoryRuns(ledgerDir, ticket.issueNumber);
  const pending = ticket.state !== "closed" && runs.length === 0;
  const currentState = decideTicketCurrentState({
    ticketState: ticket.state,
    runs,
    now,
  });
  const displayRuns = enrichRunsForBoard(runs, currentState, now);
  const metrics = aggregateTicketMetrics(displayRuns, ticket, now);

  let legAgeMs: number | undefined;
  let lastActivityAt: string | undefined;
  let lastActivityMtimeMs: number | undefined;
  if (
    currentState === "unaccepted-flying" ||
    currentState === "unaccepted-watch" ||
    currentState === "unaccepted-suspect"
  ) {
    const latest = sortRunsByStart(runs).at(-1)!;
    lastActivityMtimeMs = latest.mtimeMs;
    // Newest parent/axis *content* activity (mtime stays on data-last-activity-mtime-ms).
    lastActivityAt =
      latest.lastActivityAt ??
      latest.endedAt ??
      (latest.mtimeMs > 0 ? new Date(latest.mtimeMs).toISOString() : undefined);
    if (latest.startedAt) {
      legAgeMs = wallMsBetween(latest.startedAt, now.toISOString());
    } else if (latest.mtimeMs > 0) {
      legAgeMs = Math.max(0, now.getTime() - latest.mtimeMs);
    } else {
      legAgeMs = 0;
    }
  }

  return {
    ticket,
    runs,
    displayRuns,
    pending,
    currentState,
    activeBlockedBy: activeBlockedBy(ticket),
    costUsd: metrics.costUsd,
    totalTokens: metrics.totalTokens,
    wallMs: metrics.wallMs,
    landingCycleMs: metrics.landingCycleMs,
    ...(legAgeMs !== undefined ? { legAgeMs } : {}),
    ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
    ...(lastActivityMtimeMs !== undefined ? { lastActivityMtimeMs } : {}),
  };
}

async function renderLaneHtml(
  bookKey: string,
  ledgerDir: string,
  tickets: readonly SnapshotTicket[],
  now: Date,
): Promise<string> {
  const prepared = new Map<number, PreparedTicket>();
  for (const ticket of tickets) {
    prepared.set(ticket.issueNumber, await prepareTicket(ledgerDir, ticket, now));
  }

  const childrenByParent = buildDirectChildrenByParent(prepared);

  // Tickets that appear as a child of any in-snapshot parent.
  const nestedInSnapshot = new Set<number>();
  for (const list of childrenByParent.values()) {
    for (const child of list) nestedInSnapshot.add(child.ticket.issueNumber);
  }

  // Family roots = in-snapshot tickets with descendants that are not themselves
  // nested under another in-snapshot parent. One rooted whole-family aggregate.
  const familyRoots = [...childrenByParent.keys()]
    .filter((parentNum) => !nestedInSnapshot.has(parentNum))
    .sort((a, b) => a - b);

  const renderedInFamily = new Set<number>();
  const familyHtml = familyRoots
    .map((rootNum) => {
      const parent = prepared.get(rootNum)!;
      const descendants = collectDescendants(rootNum, childrenByParent);
      renderedInFamily.add(rootNum);
      for (const d of descendants) renderedInFamily.add(d.ticket.issueNumber);
      return renderFamily({ bookKey, parent, descendants });
    })
    .join("\n");

  // Every ticket renders exactly once: family members are excluded from top-level.
  const topLevel = [...prepared.values()]
    .filter((item) => !renderedInFamily.has(item.ticket.issueNumber))
    .sort((a, b) => a.ticket.issueNumber - b.ticket.issueNumber);

  const topHtml = topLevel
    .map((item) => renderTicketArticle({ bookKey, prepared: item, nested: false }))
    .join("\n");

  return [
    `<section class="lane" data-lane="${attr(bookKey)}" data-book="${attr(bookKey)}">`,
    `<h2 class="lane-title">册 ${escapeHtml(bookKey)}</h2>`,
    `<div class="lane-tickets" data-lane-tickets="${attr(bookKey)}">`,
    familyHtml,
    topHtml,
    `</div>`,
    `</section>`,
  ].join("\n");
}

function boardStyles(): string {
  return `
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.45; }
  body { margin: 0 auto; padding: 1rem; max-width: 72rem; }
  header.page { margin-bottom: 1rem; }
  .generated { font-size: 0.9rem; opacity: 0.8; }
  .thresholds { font-size: 0.85rem; opacity: 0.9; display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; }
  .controls { margin: 0.5rem 0 0; display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; font-size: 0.9rem; }
  .lane {
    border: 1px solid color-mix(in srgb, CanvasText 22%, Canvas);
    border-radius: 0.6rem;
    padding: 0.85rem;
    margin: 1rem 0;
  }
  .lane-title { margin: 0 0 0.75rem; font-size: 1.2rem; }
  .family {
    border: 1px dashed color-mix(in srgb, CanvasText 28%, Canvas);
    border-radius: 0.5rem;
    padding: 0.65rem;
    margin: 0.75rem 0;
  }
  .family-title { margin: 0 0 0.35rem; font-size: 1.05rem; }
  .family-agg { margin: 0 0 0.5rem; display: flex; flex-wrap: wrap; gap: 0.75rem; font-size: 0.9rem; opacity: 0.9; }
  .ticket {
    border-top: 1px solid color-mix(in srgb, CanvasText 12%, Canvas);
    padding: 0.55rem 0;
  }
  .ticket-child { margin-left: 0.75rem; padding-left: 0.5rem; border-left: 2px solid color-mix(in srgb, CanvasText 18%, Canvas); }
  .ticket-title { margin: 0; font-size: 1rem; }
  .ticket-meta { margin: 0.25rem 0; display: flex; flex-wrap: wrap; gap: 0.5rem 0.85rem; font-size: 0.88rem; }
  .state { font-weight: 600; }
  .ticket.current-unaccepted-flying .state { color: color-mix(in srgb, seagreen 80%, CanvasText); }
  .ticket.current-unaccepted-watch .state { color: color-mix(in srgb, darkorange 85%, CanvasText); }
  .ticket.current-unaccepted-suspect .state { color: color-mix(in srgb, tomato 85%, CanvasText); }
  .ticket.current-pending .state { opacity: 0.85; }
  .ticket.current-accepted-awaiting .state { color: color-mix(in srgb, dodgerblue 75%, CanvasText); }
  .ticket.current-closed .state { opacity: 0.75; }
  .blocked-badge {
    display: inline-block;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    background: color-mix(in srgb, darkorange 30%, Canvas);
    font-size: 0.8rem;
  }
  .pending-label { margin: 0.25rem 0; opacity: 0.85; }
  .station { border: 1px solid color-mix(in srgb, CanvasText 16%, Canvas); border-radius: 0.4rem; padding: 0.5rem; margin: 0.4rem 0; }
  .station-title { margin: 0 0 0.35rem; font-size: 0.95rem; }
  .run { padding: 0.35rem 0; border-top: 1px solid color-mix(in srgb, CanvasText 10%, Canvas); }
  .run:first-of-type { border-top: 0; }
  .run-head { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; justify-content: space-between; }
  .run-id { font-family: ui-monospace, monospace; font-size: 0.85rem; word-break: break-all; }
  .run-model { font-size: 0.8rem; opacity: 0.85; }
  .run-meta { margin: 0.2rem 0; font-size: 0.85rem; display: flex; flex-wrap: wrap; gap: 0.65rem; }
  .ledger { margin: 0.2rem 0 0; font-size: 0.75rem; word-break: break-all; }
  @media (max-width: 640px) {
    body { padding: 0.75rem; }
    .ticket-child { margin-left: 0.35rem; }
  }
`;
}

function boardSortScript(): string {
  // Presentation-only reorder; machine facts stay on data-* attrs.
  // Singular render-seam comparator lives only in this embedded page script.
  // Family lane entries carry aggregate data-cost-usd (parent + descendants) so nested
  // per-ticket burns (e.g. #130 under #78) participate without flattening the S2 nest.
  return `<script>
(function () {
  var sel = document.querySelector('[data-sort-control]');
  if (!sel) return;
  function costOf(el) {
    var v = el.getAttribute('data-cost-usd');
    var n = v == null ? 0 : Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  function ticketNo(el) {
    // Tickets use data-ticket; family sections use data-parent (root issue).
    var v = el.getAttribute('data-ticket');
    if (v == null || v === '') v = el.getAttribute('data-parent');
    var n = v == null ? 0 : Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  function compareEntries(a, b, mode) {
    if (mode === 'cost-desc') {
      var d = costOf(b) - costOf(a);
      if (d !== 0) return d;
    } else if (mode === 'cost-asc') {
      var d2 = costOf(a) - costOf(b);
      if (d2 !== 0) return d2;
    }
    return ticketNo(a) - ticketNo(b);
  }
  function sortKey(node) {
    if (node.nodeType !== 1) return null;
    var el = node;
    // Lane children only: family sections (aggregate burn) or standalone tickets.
    if (el.hasAttribute && el.hasAttribute('data-family')) {
      return el.hasAttribute('data-cost-usd') ? el : null;
    }
    if (el.hasAttribute && el.hasAttribute('data-ticket')) return el;
    return null;
  }
  sel.addEventListener('change', function () {
    var mode = sel.value;
    document.querySelectorAll('[data-lane-tickets]').forEach(function (lane) {
      var nodes = Array.prototype.filter.call(lane.children, function (n) {
        return n.nodeType === 1 && sortKey(n);
      });
      nodes.sort(function (a, b) {
        var ka = sortKey(a);
        var kb = sortKey(b);
        return compareEntries(ka, kb, mode);
      });
      nodes.forEach(function (n) { lane.appendChild(n); });
    });
  });
})();
</script>`;
}

/**
 * Unique S2 seam: books + snapshot-or-error + now → HTML.
 * Read-only against every ledger.
 * When refreshBoundarySeconds is a positive finite number, the page declares that
 * bound (backed by startFactoryBoardPage regeneration). One-shot omits it.
 */
export async function renderFactoryBoardHtml(
  books: readonly FactoryBoardBook[],
  view: FactoryBoardView,
  now: Date,
  options?: { refreshBoundarySeconds?: number },
): Promise<string> {
  if (!Array.isArray(books)) {
    throw new Error("books must be an array");
  }
  if (!isRecord(view) || typeof view.ok !== "boolean") {
    throw new Error("view must be a FactoryBoardView");
  }
  const generatedAt = now.toISOString();
  const refreshActive =
    options?.refreshBoundarySeconds !== undefined &&
    Number.isFinite(options.refreshBoundarySeconds) &&
    options.refreshBoundarySeconds > 0;
  const refreshBoundarySeconds = refreshActive ? options!.refreshBoundarySeconds! : undefined;
  if (!view.ok) {
    return renderErrorHtml(view.error, generatedAt);
  }

  // Fail closed on duplicate bookKey — never Map-last-wins across lanes/ledgers.
  const duplicateKey = firstDuplicateBookKey(books.map((b) => b.bookKey));
  if (duplicateKey !== null) {
    return renderErrorHtml(
      {
        kind: "binding",
        bookKey: duplicateKey,
        message: `duplicate bookKey in books: ${duplicateKey}`,
      },
      generatedAt,
    );
  }
  const duplicateSnapKey = firstDuplicateBookKey(view.snapshot.books.map((b) => b.bookKey));
  if (duplicateSnapKey !== null) {
    return renderErrorHtml(
      {
        kind: "binding",
        bookKey: duplicateSnapKey,
        message: `duplicate bookKey in snapshot: ${duplicateSnapKey}`,
      },
      generatedAt,
    );
  }

  const bookByKey = new Map(books.map((b) => [b.bookKey, b]));
  const laneHtmlParts: string[] = [];
  for (const bookSnap of view.snapshot.books) {
    const book = bookByKey.get(bookSnap.bookKey);
    if (!book) {
      return renderErrorHtml(
        {
          kind: "binding",
          bookKey: bookSnap.bookKey,
          message: `no ledger binding for book ${bookSnap.bookKey}`,
        },
        generatedAt,
      );
    }
    laneHtmlParts.push(
      await renderLaneHtml(book.bookKey, resolve(book.ledgerDir), bookSnap.tickets, now),
    );
  }

  // Preserve caller book order for empty-snapshot books still listed in books? Only snapshot books form lanes.

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
<html lang="zh-CN" data-generated-at="${attr(generatedAt)}" data-board="true" data-threshold-flying-ms="${attr(String(UNACCEPTED_FLYING_MS))}" data-threshold-watch-ms="${attr(String(UNACCEPTED_WATCH_MS))}"${lifecycleAttrs}>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>${refreshMeta}
<title>工厂进度板</title>
<style>${boardStyles()}
</style>
</head>
<body>
<header class="page">
  <h1>工厂进度板 · 驿传轨迹</h1>
  <p class="generated">generated-at <time datetime="${attr(generatedAt)}">${escapeHtml(generatedAt)}</time>${refreshNote}</p>
  <p class="thresholds" data-thresholds="true">
    <span>未受理阈值：</span>
    <span data-threshold-flying-ms="${attr(String(UNACCEPTED_FLYING_MS))}">&lt;${UNACCEPTED_FLYING_MS}ms 在飞</span>
    <span data-threshold-watch-ms="${attr(String(UNACCEPTED_WATCH_MS))}">${UNACCEPTED_FLYING_MS}–${UNACCEPTED_WATCH_MS}ms 观察</span>
    <span data-threshold-suspect="true">&gt;${UNACCEPTED_WATCH_MS}ms 疑挂</span>
  </p>
  <p class="controls">
    <label>排序
      <select data-sort-control="true">
        <option value="ticket-asc" selected>票号</option>
        <option value="cost-desc">烧钱↓</option>
        <option value="cost-asc">烧钱↑</option>
      </select>
    </label>
  </p>
</header>
<main data-lane-count="${laneHtmlParts.length}">
${laneHtmlParts.join("\n") || "<p data-empty-board=\"true\">no books in snapshot</p>"}
</main>
${boardSortScript()}
</body>
</html>
`;
}

async function assertOutputOutsideAllLedgers(
  books: readonly FactoryBoardBook[],
  outputPath: string,
): Promise<{ ledgerRoots: string[]; outputAbsolute: string }> {
  const outputAbsolute = resolve(outputPath);
  const ledgerRoots: string[] = [];
  for (const book of books) {
    const ledgerResolved = resolve(book.ledgerDir);
    let ledgerRoot: string;
    try {
      ledgerRoot = await realpath(ledgerResolved);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      ledgerRoot = ledgerResolved;
    }
    ledgerRoots.push(ledgerRoot);

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
    if (
      isPathInside(ledgerRoot, prospectiveReal) ||
      isPathInside(ledgerRoot, realPrefix) ||
      isPathInside(ledgerRoot, outputAbsolute)
    ) {
      throw new Error("factory board outputPath must be outside every ledger directory");
    }
  }
  return { ledgerRoots, outputAbsolute };
}

async function writeHtmlAtomically(outputAbsolute: string, html: string, ledgerRoots: string[]): Promise<string> {
  const parent = dirname(outputAbsolute);
  await mkdir(parent, { recursive: true });
  const parentReal = await realpath(parent);
  for (const root of ledgerRoots) {
    if (isPathInside(root, parentReal) || isPathInside(root, resolve(parentReal, basename(outputAbsolute)))) {
      throw new Error("factory board outputPath must be outside every ledger directory");
    }
  }
  const temporary = join(parent, `.factory-board-${randomUUID()}.html.tmp`);
  try {
    await writeFile(temporary, html, "utf8");
    await rename(temporary, outputAbsolute);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return realpath(outputAbsolute);
}

export async function writeFactoryBoardPage(input: {
  books: readonly FactoryBoardBook[];
  view: FactoryBoardView;
  now: Date;
  outputPath: string;
  refreshBoundarySeconds?: number;
}): Promise<{ outputPath: string; html: string }> {
  const gate = await assertOutputOutsideAllLedgers(input.books, input.outputPath);
  const html = await renderFactoryBoardHtml(
    input.books,
    input.view,
    input.now,
    input.refreshBoundarySeconds !== undefined
      ? { refreshBoundarySeconds: input.refreshBoundarySeconds }
      : undefined,
  );
  const outputPath = await writeHtmlAtomically(gate.outputAbsolute, html, gate.ledgerRoots);
  return { outputPath, html };
}

const defaultBoardScheduler: FactoryBoardScheduler = {
  every(ms, tick) {
    const timer = setInterval(tick, ms);
    timer.unref?.();
    return () => clearInterval(timer);
  },
};

/**
 * Production board lifecycle: write immediately, then regenerate on the declared
 * refresh boundary so the same viewing surface observes new runs / generated-at.
 * Snapshot bindings stay fixed; each tick re-reads ledgers (read-only).
 * Stop cancels further regeneration. A post-start regeneration failure faults the
 * lifecycle with the original cause (no silent continuation).
 */
export function startFactoryBoardPage(input: {
  books: readonly FactoryBoardBook[];
  view: FactoryBoardView;
  outputPath: string;
  refreshBoundarySeconds?: number;
  clock?: FactoryBoardClock;
  scheduler?: FactoryBoardScheduler;
}): FactoryBoardPageHandle {
  const refreshBoundarySeconds = input.refreshBoundarySeconds ?? DEFAULT_REFRESH_BOUNDARY_SECONDS;
  if (!(refreshBoundarySeconds > 0) || !Number.isFinite(refreshBoundarySeconds)) {
    throw new Error("refreshBoundarySeconds must be a positive finite number");
  }
  const clock = input.clock ?? (() => new Date());
  const scheduler = input.scheduler ?? defaultBoardScheduler;

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
      throw new Error("factory board page lifecycle already stopped");
    }
    if (lastRejection !== undefined) throw lastRejection;
    return writeFactoryBoardPage({
      books: input.books,
      view: input.view,
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
        throw lastRejection;
      }
      settleClean();
    },
  };
}
