/**
 * Factory board full view (S2).
 *
 * Unique render seam: (books, view, now) → HTML.
 * - books: explicit bookKey + ledgerDir (no git-remote guess)
 * - view: BoardSnapshot success OR loud binding/api error
 *
 * Reuses S1 tracer (`loadTicketTrajectoryRuns` + station HTML) for each ticket.
 * This module owns swimlanes, family aggregation, pending (zero-run), blocked
 * badges, and closed drill presentation — not four-state/cost (S3).
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  loadTicketTrajectoryRuns,
  renderTicketTrajectoryStationHtml,
  type TicketTrajectoryRun,
} from "./ticket-trajectory.ts";
import type { BoardSnapshot, SnapshotTicket, TicketIssueState } from "./ticket-snapshot.ts";

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
  pending: boolean;
  /** Incomplete blockers only (open blockers), for non-closed tickets. */
  activeBlockedBy: number[];
};

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
  const { ticket, runs, pending, activeBlockedBy: blockers } = input.prepared;
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
    runs.length > 0
      ? `<div class="trajectory" data-trajectory="true">${renderTicketTrajectoryStationHtml(runs)}</div>`
      : pending
        ? `<p class="pending-label" data-pending-label="true">待发（零卷）</p>`
        : `<p class="pending-label" data-empty-trajectory="true">no runs</p>`;

  const parentAttr =
    ticket.parentIssueNumber !== null
      ? ` data-parent-issue="${attr(String(ticket.parentIssueNumber))}"`
      : "";

  return [
    `<article class="ticket${input.nested ? " ticket-child" : ""}"`,
    ` data-ticket="${attr(String(ticket.issueNumber))}"`,
    ` data-book="${attr(input.bookKey)}"`,
    ` data-title="${attr(ticket.title)}"`,
    ` data-milestone="${attr(milestone)}"`,
    ` data-ticket-state="${attr(state)}"`,
    ` data-pending="${pending ? "true" : "false"}"`,
    ` data-blocked-by="${attr(blockedAttr)}"`,
    ` data-run-count="${attr(String(runs.length))}"`,
    parentAttr,
    `>`,
    `<header class="ticket-head">`,
    `<h3 class="ticket-title">#${escapeHtml(String(ticket.issueNumber))} · ${escapeHtml(ticket.title)}</h3>`,
    `<p class="ticket-meta">`,
    state === "closed" ? `<span class="state">closed</span>` : pending ? `<span class="state">待发</span>` : `<span class="state">open</span>`,
    milestone ? `<span class="milestone">milestone: ${escapeHtml(milestone)}</span>` : `<span class="milestone">milestone: —</span>`,
    badges,
    `</p>`,
    `</header>`,
    runs.length > 0
      ? `<details class="ticket-body" data-drill="${attr(String(ticket.issueNumber))}"${state === "closed" ? " open" : ""}><summary>轨迹 · ${runs.length} run(s)</summary>${trajectory}</details>`
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
    `>`,
    `<header class="family-head">`,
    `<h2 class="family-title">族 #${escapeHtml(String(input.parent.ticket.issueNumber))} · ${escapeHtml(input.parent.ticket.title)}</h2>`,
    `<p class="family-agg">`,
    `<span>子轨迹 ${childCount}</span>`,
    `<span>待发 ${pendingCount}</span>`,
    `<span>收官 ${closedCount}</span>`,
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
): Promise<PreparedTicket> {
  const runs = await loadTicketTrajectoryRuns(ledgerDir, ticket.issueNumber);
  const pending = ticket.state !== "closed" && runs.length === 0;
  return {
    ticket,
    runs,
    pending,
    activeBlockedBy: activeBlockedBy(ticket),
  };
}

async function renderLaneHtml(bookKey: string, ledgerDir: string, tickets: readonly SnapshotTicket[]): Promise<string> {
  const prepared = new Map<number, PreparedTicket>();
  for (const ticket of tickets) {
    prepared.set(ticket.issueNumber, await prepareTicket(ledgerDir, ticket));
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
    familyHtml,
    topHtml,
    `</section>`,
  ].join("\n");
}

function boardStyles(): string {
  return `
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.45; }
  body { margin: 0 auto; padding: 1rem; max-width: 72rem; }
  header.page { margin-bottom: 1rem; }
  .generated { font-size: 0.9rem; opacity: 0.8; }
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

/**
 * Unique S2 seam: books + snapshot-or-error + now → HTML.
 * Read-only against every ledger.
 */
export async function renderFactoryBoardHtml(
  books: readonly FactoryBoardBook[],
  view: FactoryBoardView,
  now: Date,
): Promise<string> {
  if (!Array.isArray(books)) {
    throw new Error("books must be an array");
  }
  if (!isRecord(view) || typeof view.ok !== "boolean") {
    throw new Error("view must be a FactoryBoardView");
  }
  const generatedAt = now.toISOString();
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
    laneHtmlParts.push(await renderLaneHtml(book.bookKey, resolve(book.ledgerDir), bookSnap.tickets));
  }

  // Preserve caller book order for empty-snapshot books still listed in books? Only snapshot books form lanes.

  return `<!DOCTYPE html>
<html lang="zh-CN" data-generated-at="${attr(generatedAt)}" data-board="true">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>工厂进度板</title>
<style>${boardStyles()}
</style>
</head>
<body>
<header class="page">
  <h1>工厂进度板 · 驿传轨迹</h1>
  <p class="generated">generated-at <time datetime="${attr(generatedAt)}">${escapeHtml(generatedAt)}</time></p>
</header>
<main data-lane-count="${laneHtmlParts.length}">
${laneHtmlParts.join("\n") || "<p data-empty-board=\"true\">no books in snapshot</p>"}
</main>
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
}): Promise<{ outputPath: string; html: string }> {
  const gate = await assertOutputOutsideAllLedgers(input.books, input.outputPath);
  const html = await renderFactoryBoardHtml(input.books, input.view, input.now);
  const outputPath = await writeHtmlAtomically(gate.outputAbsolute, html, gate.ledgerRoots);
  return { outputPath, html };
}
