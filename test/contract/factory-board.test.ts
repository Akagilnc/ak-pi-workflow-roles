/**
 * S2 factory board — external behavior at:
 *   1) isolated BoardSnapshot → HTML (no network)
 *   2) snapshot adapter against injectable transport (no network)
 *
 * Live GitHub edge contract lives in test/integration/ticket-snapshot-live.test.ts.
 * Assertions read machine data-* keys only (anchoring constitution).
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes, watch as watchDirectory, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";

const execFileAsync = promisify(execFile);

import {
  DEFAULT_REFRESH_BOUNDARY_SECONDS,
  UNACCEPTED_FLYING_MS,
  UNACCEPTED_WATCH_MS,
  renderFactoryBoardHtml,
  startFactoryBoardPage,
  writeFactoryBoardPage,
  type FactoryBoardBook,
  type FactoryBoardScheduler,
  type FactoryBoardView,
} from "../../src/factory-board.ts";
import {
  createGhTicketSnapshotTransport,
  fetchBoardSnapshot,
  TicketSnapshotBindingError,
  type BoardSnapshot,
  type SnapshotTicket,
  type TicketSnapshotTransport,
} from "../../src/ticket-snapshot.ts";
import type { GhApiRunner, GhApiResponse } from "../../src/collector-github.ts";
import {
  acceptedFacts,
  isTerminatingToolName,
  validateAcceptedDetails,
  AcceptedDetailsContractError,
  type TerminatingToolName,
} from "../../src/package-contracts/terminating-tools.ts";

/** Page sort modes advertised by the embedded production control (not a board export). */
type BoardPageSortMode = "ticket-asc" | "cost-desc" | "cost-asc";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureLedger = join(packageRoot, "test/fixtures/ticket-trajectory/ledger");

async function treeFingerprint(root: string): Promise<string> {
  const h = createHash("sha256");
  async function walk(dir: string): Promise<void> {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const rel = path.slice(root.length + 1).split(sep).join("/");
      h.update(rel);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) h.update(await readFile(path));
      else if (entry.isSymbolicLink()) h.update(`symlink:${entry.name}`);
    }
  }
  await walk(root);
  return h.digest("hex");
}

/** Visible ticket-meta label for one ticket (data-*-label carries the issue number). */
function visibleTicketLabel(
  html: string,
  labelAttr: string,
  issueNumber: number,
  bookKey?: string,
): Record<string, string> | undefined {
  return elementsWith(html, labelAttr).find(
    (el) =>
      el[labelAttr] === String(issueNumber) &&
      (bookKey === undefined || el["data-book"] === bookKey),
  );
}

function elementsWith(html: string, dataAttr: string): Record<string, string>[] {
  const re = new RegExp(`<[^>]+\\b${dataAttr}="[^"]*"[^>]*>`, "g");
  const out: Record<string, string>[] = [];
  for (const tag of html.match(re) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/\b(data-[a-z0-9-]+|href)="([^"]*)"/g)) {
      attrs[m[1]!] = m[2]!;
    }
    out.push(attrs);
  }
  return out;
}

function attrsFromOpenTag(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(/\b(data-[a-z0-9-]+|class|href)="([^"]*)"/g)) {
    attrs[m[1]!] = m[2]!;
  }
  return attrs;
}

/**
 * Top-level lane sort entries from production HTML (family sections + non-nested tickets),
 * in document order. Nested ticket-child articles are excluded — they participate via family aggregate.
 */
function topLevelLaneEntries(html: string, bookKey: string): Array<Record<string, string>> {
  const marker = `data-lane-tickets="${bookKey}"`;
  const markerAt = html.indexOf(marker);
  assert.ok(markerAt >= 0, `missing lane ${bookKey}`);
  const contentStart = html.indexOf(">", markerAt) + 1;
  // lane-tickets closes at the first </div> that returns depth to 0 after optional nested divs.
  let depth = 1;
  let i = contentStart;
  let contentEnd = html.length;
  while (i < html.length) {
    const nextOpen = html.indexOf("<div", i);
    const nextClose = html.indexOf("</div>", i);
    if (nextClose < 0) break;
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth += 1;
      i = nextOpen + 4;
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      contentEnd = nextClose;
      break;
    }
    i = nextClose + 6;
  }
  const chunk = html.slice(contentStart, contentEnd);
  const entries: Array<{ index: number; attrs: Record<string, string> }> = [];
  for (const m of chunk.matchAll(/<section\b[^>]*\bdata-family="true"[^>]*>/g)) {
    entries.push({ index: m.index ?? 0, attrs: attrsFromOpenTag(m[0]!) });
  }
  for (const m of chunk.matchAll(/<article\b[^>]*\bdata-ticket="\d+"[^>]*>/g)) {
    const attrs = attrsFromOpenTag(m[0]!);
    const cls = attrs.class ?? "";
    if (cls.split(/\s+/).includes("ticket-child")) continue;
    // Family parent article sits inside the family section — skip non-top-level by requiring
    // the article is not nested under a family open that hasn't closed. Approximate: only
    // articles whose nearest preceding family/section state is outside. Simpler: skip any
    // article that appears between a family open and its matching close in chunk.
    entries.push({ index: m.index ?? 0, attrs, _article: true } as {
      index: number;
      attrs: Record<string, string>;
      _article?: boolean;
    });
  }
  // Drop articles that fall inside a family section span.
  const familySpans: Array<{ start: number; end: number }> = [];
  for (const m of chunk.matchAll(/<section\b[^>]*\bdata-family="true"[^>]*>/g)) {
    const start = m.index ?? 0;
    // Find matching </section> with nesting.
    let d = 1;
    let j = start + m[0]!.length;
    let end = chunk.length;
    while (j < chunk.length) {
      const open = chunk.indexOf("<section", j);
      const close = chunk.indexOf("</section>", j);
      if (close < 0) break;
      if (open >= 0 && open < close) {
        d += 1;
        j = open + 8;
        continue;
      }
      d -= 1;
      if (d === 0) {
        end = close;
        break;
      }
      j = close + 10;
    }
    familySpans.push({ start, end });
  }
  const filtered = entries.filter((e) => {
    if (!(e as { _article?: boolean })._article) return true;
    return !familySpans.some((s) => e.index > s.start && e.index < s.end);
  });
  filtered.sort((a, b) => a.index - b.index);
  return filtered.map((e) => e.attrs);
}

/**
 * Singular fake-DOM harness for the production board page script
 * (sort + project/family filters + unknown badge). One surface for every page-script test.
 */
class BoardSortElement {
  nodeType = 1;
  childNodes: BoardSortElement[] = [];
  parentNode: BoardSortElement | null = null;
  value = "";
  textContent = "";
  readonly style: Record<string, string> = {};
  private readonly attrs: Record<string, string>;
  private readonly listeners = new Map<string, Array<() => void>>();

  constructor(attrs: Record<string, string> = {}) {
    this.attrs = { ...attrs };
  }

  get children(): BoardSortElement[] {
    return this.childNodes;
  }

  get firstChild(): BoardSortElement | null {
    return this.childNodes[0] ?? null;
  }

  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name]! : null;
  }

  hasAttribute(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.attrs, name);
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }

  appendChild(child: BoardSortElement): BoardSortElement {
    if (child.parentNode) {
      const sibs = child.parentNode.childNodes;
      const idx = sibs.indexOf(child);
      if (idx >= 0) sibs.splice(idx, 1);
    }
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: BoardSortElement): BoardSortElement {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  addEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  dispatchEvent(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }

  private matches(selector: string): boolean {
    const m = selector.match(/^\[([a-z0-9-]+)(?:="([^"]*)")?\]$/);
    if (!m) return false;
    if (!this.hasAttribute(m[1]!)) return false;
    return m[2] === undefined || this.getAttribute(m[1]!) === m[2];
  }

  private walk(predicate: (el: BoardSortElement) => boolean, out: BoardSortElement[]): void {
    for (const child of this.childNodes) {
      if (predicate(child)) out.push(child);
      child.walk(predicate, out);
    }
  }

  querySelector(selector: string): BoardSortElement | null {
    const out: BoardSortElement[] = [];
    this.walk((el) => el.matches(selector), out);
    return out[0] ?? null;
  }

  querySelectorAll(selector: string): BoardSortElement[] {
    const out: BoardSortElement[] = [];
    this.walk((el) => el.matches(selector), out);
    return out;
  }
}

class BoardSortDocument {
  readonly root = new BoardSortElement();
  createElement(_tag: string): BoardSortElement {
    return new BoardSortElement();
  }
  querySelector(selector: string): BoardSortElement | null {
    return this.root.querySelector(selector);
  }
  querySelectorAll(selector: string): BoardSortElement[] {
    return this.root.querySelectorAll(selector);
  }
}

/**
 * Execute the production page sort control against lane entries parsed from the
 * rendered HTML (same script body the browser runs — not the TS comparator alone).
 */
function executeProductionBoardSort(
  html: string,
  bookKey: string,
  mode: BoardPageSortMode,
): Array<Record<string, string>> {
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch?.[1], "production board must embed sort script");
  const scriptBody = scriptMatch[1]!;

  const select = new BoardSortElement({ "data-sort-control": "true" });
  select.value = "ticket-asc";
  const lane = new BoardSortElement({ "data-lane-tickets": bookKey });
  for (const attrs of topLevelLaneEntries(html, bookKey)) {
    lane.appendChild(new BoardSortElement(attrs));
  }

  const document = {
    querySelector(sel: string): BoardSortElement | null {
      if (sel === "[data-sort-control]") return select;
      return null;
    },
    querySelectorAll(sel: string): BoardSortElement[] {
      if (sel === "[data-lane-tickets]") return [lane];
      return [];
    },
  };

  vm.runInNewContext(scriptBody, { document });
  select.value = mode;
  select.dispatchEvent("change");

  return lane.children.map((child) => {
    const out: Record<string, string> = {};
    for (const key of ["data-ticket", "data-parent", "data-family", "data-cost-usd", "data-book"]) {
      const v = child.getAttribute(key);
      if (v != null) out[key] = v;
    }
    return out;
  });
}

function laneSortIdentity(entry: Record<string, string>): number {
  if (entry["data-family"] === "true") return Number(entry["data-parent"]);
  return Number(entry["data-ticket"]);
}

function manualBoardScheduler(): {
  scheduler: FactoryBoardScheduler;
  ticks: Array<() => void>;
} {
  const ticks: Array<() => void> = [];
  const scheduler: FactoryBoardScheduler = {
    every(_ms, tick) {
      ticks.push(tick);
      return () => {
        const idx = ticks.indexOf(tick);
        if (idx >= 0) ticks.splice(idx, 1);
      };
    },
  };
  return { scheduler, ticks };
}

function ticket(
  partial: Partial<SnapshotTicket> & Pick<SnapshotTicket, "issueNumber" | "title" | "state">,
): SnapshotTicket {
  return {
    milestone: null,
    parentIssueNumber: null,
    blockedBy: [],
    closedAt: null,
    ...partial,
  };
}

function sampleSnapshot(): BoardSnapshot {
  return {
    books: [
      {
        bookKey: "roles",
        owner: "acme",
        repo: "roles",
        tickets: [
          ticket({
            issueNumber: 78,
            title: "family parent",
            state: "open",
            milestone: "m1",
          }),
          ticket({
            issueNumber: 127,
            title: "child with runs",
            state: "open",
            parentIssueNumber: 78,
            blockedBy: [],
          }),
          ticket({
            issueNumber: 128,
            title: "child blocked pending",
            state: "open",
            parentIssueNumber: 78,
            blockedBy: [{ issueNumber: 127, state: "open" }],
          }),
          ticket({
            issueNumber: 130,
            title: "closed child",
            state: "closed",
            parentIssueNumber: 78,
          }),
          ticket({
            issueNumber: 26,
            title: "roles lone 26",
            state: "open",
            milestone: "solo",
          }),
        ],
      },
      {
        bookKey: "orch",
        owner: "acme",
        repo: "orch",
        tickets: [
          ticket({
            issueNumber: 26,
            title: "orch lone 26",
            state: "open",
            milestone: "other",
          }),
        ],
      },
    ],
  };
}

async function booksWithLedgers(workspace: string): Promise<FactoryBoardBook[]> {
  const rolesLedger = join(workspace, "ledgers", "roles");
  const orchLedger = join(workspace, "ledgers", "orch");
  await cp(fixtureLedger, rolesLedger, { recursive: true });
  // orch: issue 26 with zero runs (pending)
  await mkdir(join(orchLedger, "issues", "26"), { recursive: true });
  // roles: ensure 128/130/26 exist as zero-run; 127 keeps fixture runs; 78 zero-run parent
  await mkdir(join(rolesLedger, "issues", "78"), { recursive: true });
  await mkdir(join(rolesLedger, "issues", "128"), { recursive: true });
  await mkdir(join(rolesLedger, "issues", "130"), { recursive: true });
  await mkdir(join(rolesLedger, "issues", "26"), { recursive: true });
  return [
    { bookKey: "roles", ledgerDir: rolesLedger },
    { bookKey: "orch", ledgerDir: orchLedger },
  ];
}

test("board lists title and milestone per ticket; same-number tickets stay in their lanes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-lanes-"));
  try {
    const books = await booksWithLedgers(workspace);
    const beforeRoles = await treeFingerprint(books[0]!.ledgerDir);
    const beforeOrch = await treeFingerprint(books[1]!.ledgerDir);
    const view: FactoryBoardView = { ok: true, snapshot: sampleSnapshot() };
    const html = await renderFactoryBoardHtml(books, view, new Date("2026-08-05T12:00:00.000Z"));

    assert.equal(await treeFingerprint(books[0]!.ledgerDir), beforeRoles);
    assert.equal(await treeFingerprint(books[1]!.ledgerDir), beforeOrch);

    assert.equal(elementsWith(html, "data-board-error").length, 0);
    assert.match(html, /data-generated-at="2026-08-05T12:00:00\.000Z"/);

    const lanes = elementsWith(html, "data-lane");
    assert.equal(lanes.length, 2);
    assert.ok(lanes.some((l) => l["data-lane"] === "roles"));
    assert.ok(lanes.some((l) => l["data-lane"] === "orch"));

    const tickets = elementsWith(html, "data-ticket");
    const roles26 = tickets.find((t) => t["data-book"] === "roles" && t["data-ticket"] === "26");
    const orch26 = tickets.find((t) => t["data-book"] === "orch" && t["data-ticket"] === "26");
    assert.ok(roles26, "roles #26 present");
    assert.ok(orch26, "orch #26 present");
    assert.equal(roles26["data-title"], "roles lone 26");
    assert.equal(roles26["data-milestone"], "solo");
    assert.equal(orch26["data-title"], "orch lone 26");
    assert.equal(orch26["data-milestone"], "other");

    // Lane sections must not cross-host the other book's #26.
    const rolesLaneAt = html.indexOf('data-lane="roles"');
    const orchLaneAt = html.indexOf('data-lane="orch"');
    assert.ok(rolesLaneAt >= 0 && orchLaneAt >= 0);
    const first = Math.min(rolesLaneAt, orchLaneAt);
    const second = Math.max(rolesLaneAt, orchLaneAt);
    const firstChunk = html.slice(first, second);
    const secondChunk = html.slice(second);
    if (rolesLaneAt < orchLaneAt) {
      assert.match(firstChunk, /data-book="roles"[^>]*data-ticket="26"|data-ticket="26"[^>]*data-book="roles"/);
      assert.doesNotMatch(firstChunk, /data-book="orch"[^>]*data-ticket="26"|data-ticket="26"[^>]*data-book="orch"/);
      assert.match(secondChunk, /data-book="orch"/);
    } else {
      assert.match(firstChunk, /data-book="orch"/);
      assert.match(secondChunk, /data-book="roles"/);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("family parent row aggregates structural counts and expands child trajectories", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-family-"));
  try {
    const books = await booksWithLedgers(workspace);
    const html = await renderFactoryBoardHtml(
      books,
      { ok: true, snapshot: sampleSnapshot() },
      new Date("2026-08-05T12:00:00.000Z"),
    );

    const family = elementsWith(html, "data-family").find(
      (el) => el["data-book"] === "roles" && el["data-parent"] === "78",
    );
    assert.ok(family, "family #78 present");
    // 3 children in snapshot under 78
    assert.equal(family["data-child-count"], "3");
    // 128 zero-run open → pending; 130 closed (not pending); 127 has runs
    assert.equal(family["data-pending-count"], "1");
    assert.equal(family["data-closed-count"], "1");

    // Children appear under family and reuse S1 tracer stations for #127
    const child127 = elementsWith(html, "data-ticket").find(
      (t) => t["data-book"] === "roles" && t["data-ticket"] === "127",
    );
    assert.ok(child127);
    assert.equal(child127["data-pending"], "false");
    assert.equal(child127["data-ticket-state"], "open");

    // S1 seam reused: #127 fixture stations present inside the board page
    const runs = elementsWith(html, "data-run-id");
    assert.ok(runs.some((r) => r["data-run-id"] === "plan-court-001@ak-roles-127"));
    assert.ok(runs.some((r) => r["data-station"] === "judge"));
    const planCourt = runs.find((r) => r["data-run-id"] === "plan-court-001@ak-roles-127");
    assert.equal(planCourt?.["data-has-result"], "true");
    assert.equal(planCourt?.["data-result-status"], "converged");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("zero-run tickets render as pending; blocked badge stacks on non-closed", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-pending-"));
  try {
    const books = await booksWithLedgers(workspace);
    const html = await renderFactoryBoardHtml(
      books,
      { ok: true, snapshot: sampleSnapshot() },
      new Date("2026-08-05T12:00:00.000Z"),
    );

    const t128 = elementsWith(html, "data-ticket").find(
      (t) => t["data-book"] === "roles" && t["data-ticket"] === "128",
    );
    assert.ok(t128);
    assert.equal(t128["data-pending"], "true");
    assert.equal(t128["data-ticket-state"], "open");
    // incomplete blocked_by edge → badge fact
    assert.equal(t128["data-blocked-by"], "127");

    const badges = elementsWith(html, "data-blocked-badge");
    assert.ok(badges.some((b) => b["data-blocked-badge"] === "127" && b["data-book"] === "roles" && b["data-ticket"] === "128"));

    // closed child is not pending and carries no blocked badge even if we add edges later
    const t130 = elementsWith(html, "data-ticket").find(
      (t) => t["data-book"] === "roles" && t["data-ticket"] === "130",
    );
    assert.ok(t130);
    assert.equal(t130["data-ticket-state"], "closed");
    assert.equal(t130["data-pending"], "false");
    assert.equal(t130["data-blocked-by"] ?? "", "");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("named closed tickets enter the board and remain drillable", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-closed-"));
  try {
    const books = await booksWithLedgers(workspace);
    // Add a closed non-family ticket with a run so drill shows trajectory
    const closedRunDir = join(books[0]!.ledgerDir, "issues", "99", "runs", "coder-x@demo", "session");
    await mkdir(closedRunDir, { recursive: true });
    await writeFile(
      join(closedRunDir, "session.jsonl"),
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "c99",
        timestamp: "2026-08-01T00:00:00.000Z",
        cwd: "/tmp",
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(books[0]!.ledgerDir, "issues", "99", "runs", "coder-x@demo", "invocation.json"),
      JSON.stringify({ role: "coder" }),
      "utf8",
    );

    const snapshot = sampleSnapshot();
    const roles = snapshot.books[0]!;
    const tickets = [
      ...roles.tickets,
      ticket({
        issueNumber: 99,
        title: "drilled closed",
        state: "closed",
        milestone: "done",
        // Closure after the sole run start — landing cycle uses this, not ledger end.
        closedAt: "2026-08-02T00:00:00.000Z",
      }),
    ];
    const view: FactoryBoardView = {
      ok: true,
      snapshot: {
        books: [{ ...roles, tickets }, snapshot.books[1]!],
      },
    };
    const html = await renderFactoryBoardHtml(books, view, new Date("2026-08-05T12:00:00.000Z"));
    const closed = elementsWith(html, "data-ticket").find(
      (t) => t["data-book"] === "roles" && t["data-ticket"] === "99",
    );
    assert.ok(closed, "closed #99 in snapshot is on the board");
    assert.equal(closed["data-ticket-state"], "closed");
    assert.equal(closed["data-title"], "drilled closed");
    assert.equal(closed["data-milestone"], "done");
    assert.ok(
      elementsWith(html, "data-run-id").some((r) => r["data-run-id"] === "coder-x@demo"),
      "closed ticket trajectory is drillable",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("binding or API failure renders loud error — never a silent empty board", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-error-"));
  try {
    const books = await booksWithLedgers(workspace);

    const bindingHtml = await renderFactoryBoardHtml(
      books,
      {
        ok: false,
        error: { kind: "binding", message: "book orch missing owner/repo binding", bookKey: "orch" },
      },
      new Date("2026-08-05T12:00:00.000Z"),
    );
    assert.equal(elementsWith(bindingHtml, "data-board-error")[0]?.["data-board-error"], "binding");
    assert.equal(elementsWith(bindingHtml, "data-error-book")[0]?.["data-error-book"], "orch");
    assert.equal(elementsWith(bindingHtml, "data-lane").length, 0);
    assert.equal(elementsWith(bindingHtml, "data-ticket").length, 0);
    assert.match(bindingHtml, /missing owner\/repo binding/i);

    const apiHtml = await renderFactoryBoardHtml(
      books,
      {
        ok: false,
        error: { kind: "api", message: "GitHub API 502 from upstream", bookKey: "roles" },
      },
      new Date("2026-08-05T12:00:00.000Z"),
    );
    assert.equal(elementsWith(apiHtml, "data-board-error")[0]?.["data-board-error"], "api");
    assert.equal(elementsWith(apiHtml, "data-lane").length, 0);
    assert.equal(elementsWith(apiHtml, "data-ticket").length, 0);
    assert.match(apiHtml, /GitHub API 502/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("snapshot adapter maps transport payloads into titled tickets with parent and blocked_by", async () => {
  const calls: Array<{ owner: string; repo: string; closedIssueNumbers: readonly number[] }> = [];
  const transport: TicketSnapshotTransport = {
    async listBookTickets(input) {
      calls.push({
        owner: input.owner,
        repo: input.repo,
        closedIssueNumbers: input.closedIssueNumbers,
      });
      if (input.owner === "acme" && input.repo === "roles") {
        return [
          {
            issueNumber: 78,
            title: "parent",
            state: "open",
            milestone: "m1",
            parentIssueNumber: null,
            closedAt: null,
            blockedBy: [],
          },
          {
            issueNumber: 127,
            title: "s1",
            state: "open",
            milestone: null,
            parentIssueNumber: 78,
            closedAt: null,
            blockedBy: [],
          },
          {
            issueNumber: 128,
            title: "s2",
            state: "open",
            milestone: null,
            parentIssueNumber: 78,
            closedAt: null,
            blockedBy: [{ issueNumber: 127, state: "open" }],
          },
          {
            issueNumber: 130,
            title: "s4",
            state: "closed",
            milestone: null,
            parentIssueNumber: 78,
            closedAt: "2026-08-05T04:03:43Z",
            blockedBy: [],
          },
        ];
      }
      if (input.owner === "acme" && input.repo === "orch") {
        return [
          {
            issueNumber: 26,
            title: "orch-26",
            state: "open",
            milestone: null,
            parentIssueNumber: null,
            closedAt: null,
            blockedBy: [],
          },
        ];
      }
      throw new Error(`unexpected repo ${input.owner}/${input.repo}`);
    },
  };

  const snapshot = await fetchBoardSnapshot({
    bindings: [
      { bookKey: "roles", owner: "acme", repo: "roles" },
      { bookKey: "orch", owner: "acme", repo: "orch" },
    ],
    closedIssueNumbersByBook: { roles: [130] },
    transport,
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { owner: "acme", repo: "roles", closedIssueNumbers: [130] });
  assert.deepEqual(calls[1], { owner: "acme", repo: "orch", closedIssueNumbers: [] });

  const roles = snapshot.books.find((b) => b.bookKey === "roles");
  assert.ok(roles);
  assert.equal(roles.owner, "acme");
  assert.equal(roles.repo, "roles");
  const byNum = new Map(roles.tickets.map((t) => [t.issueNumber, t]));
  assert.equal(byNum.get(78)?.title, "parent");
  assert.equal(byNum.get(78)?.milestone, "m1");
  assert.equal(byNum.get(127)?.parentIssueNumber, 78);
  assert.equal(byNum.get(128)?.parentIssueNumber, 78);
  assert.deepEqual(byNum.get(128)?.blockedBy, [{ issueNumber: 127, state: "open" }]);
  assert.equal(byNum.get(130)?.state, "closed");
  assert.equal(byNum.get(130)?.parentIssueNumber, 78);

  const orch = snapshot.books.find((b) => b.bookKey === "orch");
  assert.ok(orch);
  assert.equal(orch.tickets[0]?.issueNumber, 26);
});

test("snapshot adapter fails loudly on missing binding fields and transport errors", async () => {
  const transport: TicketSnapshotTransport = {
    async listBookTickets() {
      throw new Error("upstream boom");
    },
  };

  await assert.rejects(
    () =>
      fetchBoardSnapshot({
        bindings: [{ bookKey: "roles", owner: "", repo: "roles" }],
        transport,
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /binding/i);
      return true;
    },
  );

  await assert.rejects(
    () =>
      fetchBoardSnapshot({
        bindings: [{ bookKey: "roles", owner: "acme", repo: "roles" }],
        transport,
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /upstream boom|api|roles/i);
      return true;
    },
  );
});

test("page write lands outside every ledger and stays read-only on books", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-write-"));
  try {
    const books = await booksWithLedgers(workspace);
    const before = await Promise.all(books.map((b) => treeFingerprint(b.ledgerDir)));
    const outputPath = join(workspace, "out", "board.html");
    const written = await writeFactoryBoardPage({
      books,
      view: { ok: true, snapshot: sampleSnapshot() },
      now: new Date("2026-08-05T15:00:00.000Z"),
      outputPath,
    });
    assert.equal(written.outputPath, await realpath(outputPath));
    const html = await readFile(outputPath, "utf8");
    assert.match(html, /data-generated-at="2026-08-05T15:00:00\.000Z"/);
    for (let i = 0; i < books.length; i += 1) {
      assert.equal(await treeFingerprint(books[i]!.ledgerDir), before[i]);
    }
    await assert.rejects(
      () =>
        writeFactoryBoardPage({
          books,
          view: { ok: true, snapshot: sampleSnapshot() },
          now: new Date(),
          outputPath: join(books[0]!.ledgerDir, "inside.html"),
        }),
      /outside|ledger|output/i,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function runFactoryBoardCli(
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", join(packageRoot, "scripts/render-factory-board.ts"), ...args],
      { cwd: packageRoot, encoding: "utf8" },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number | string | null; stdout?: string; stderr?: string };
    const code = typeof err.code === "number" ? err.code : 1;
    return { code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

test("CLI --out alone writes binding error page and exits nonzero", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-cli-out-alone-"));
  try {
    const outputPath = join(workspace, "board.html");
    const result = await runFactoryBoardCli(["--out", outputPath]);
    assert.notEqual(result.code, 0, "must exit nonzero on missing --book");
    const html = await readFile(outputPath, "utf8");
    assert.equal(elementsWith(html, "data-board-error")[0]?.["data-board-error"], "binding");
    assert.equal(elementsWith(html, "data-lane").length, 0);
    assert.equal(elementsWith(html, "data-ticket").length, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("CLI malformed owner/repo with --out writes binding error page and exits nonzero", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-cli-malformed-"));
  try {
    const outputPath = join(workspace, "board.html");
    const result = await runFactoryBoardCli([
      "--book",
      "roles=/tmp/not-a-ledger:not-owner-repo",
      "--out",
      outputPath,
    ]);
    assert.notEqual(result.code, 0, "must exit nonzero on malformed owner/repo");
    const html = await readFile(outputPath, "utf8");
    assert.equal(elementsWith(html, "data-board-error")[0]?.["data-board-error"], "binding");
    assert.equal(elementsWith(html, "data-lane").length, 0);
    assert.equal(elementsWith(html, "data-ticket").length, 0);
    assert.match(html, /owner\/repo/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("duplicate bookKey bindings fail closed before API and never cross-wire lanes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-dup-book-"));
  try {
    const ledgerA = join(workspace, "ledger-a");
    const ledgerB = join(workspace, "ledger-b");
    await mkdir(join(ledgerA, "issues", "1"), { recursive: true });
    await mkdir(join(ledgerB, "issues", "1"), { recursive: true });
    const outputPath = join(workspace, "board.html");

    // CLI: two --book flags share one bookKey → binding error page, nonzero, no lanes.
    const cli = await runFactoryBoardCli([
      "--book",
      `roles=${ledgerA}:acme/repo-a`,
      "--book",
      `roles=${ledgerB}:acme/repo-b`,
      "--out",
      outputPath,
    ]);
    assert.notEqual(cli.code, 0, "duplicate bookKey must exit nonzero");
    const cliHtml = await readFile(outputPath, "utf8");
    assert.equal(elementsWith(cliHtml, "data-board-error")[0]?.["data-board-error"], "binding");
    assert.equal(elementsWith(cliHtml, "data-lane").length, 0);
    assert.equal(elementsWith(cliHtml, "data-ticket").length, 0);
    assert.match(cliHtml, /duplicate bookKey/i);

    // Adapter: reject before transport is touched.
    let transportCalls = 0;
    const transport: TicketSnapshotTransport = {
      async listBookTickets() {
        transportCalls += 1;
        throw new Error("transport must not run on duplicate bookKey");
      },
    };
    await assert.rejects(
      () =>
        fetchBoardSnapshot({
          bindings: [
            { bookKey: "roles", owner: "acme", repo: "repo-a" },
            { bookKey: "roles", owner: "acme", repo: "repo-b" },
          ],
          transport,
        }),
      (err: unknown) => {
        assert.ok(err instanceof TicketSnapshotBindingError);
        assert.equal(err.bookKey, "roles");
        assert.match(err.message, /duplicate bookKey/i);
        return true;
      },
    );
    assert.equal(transportCalls, 0, "no repository lookup on duplicate bookKey");

    // Renderer fail-closed: duplicate ledger books never Map-last-wins to wrong ledger.
    const renderHtml = await renderFactoryBoardHtml(
      [
        { bookKey: "roles", ledgerDir: ledgerA },
        { bookKey: "roles", ledgerDir: ledgerB },
      ],
      {
        ok: true,
        snapshot: {
          books: [
            {
              bookKey: "roles",
              owner: "acme",
              repo: "repo-a",
              tickets: [ticket({ issueNumber: 1, title: "a", state: "open" })],
            },
          ],
        },
      },
      new Date("2026-08-05T12:00:00.000Z"),
    );
    assert.equal(elementsWith(renderHtml, "data-board-error")[0]?.["data-board-error"], "binding");
    assert.equal(elementsWith(renderHtml, "data-lane").length, 0);
    assert.equal(elementsWith(renderHtml, "data-ticket").length, 0);

    // Renderer fail-closed: duplicate snapshot bookKeys.
    const snapDupHtml = await renderFactoryBoardHtml(
      [{ bookKey: "roles", ledgerDir: ledgerA }],
      {
        ok: true,
        snapshot: {
          books: [
            {
              bookKey: "roles",
              owner: "acme",
              repo: "repo-a",
              tickets: [ticket({ issueNumber: 1, title: "a", state: "open" })],
            },
            {
              bookKey: "roles",
              owner: "acme",
              repo: "repo-b",
              tickets: [ticket({ issueNumber: 2, title: "b", state: "open" })],
            },
          ],
        },
      },
      new Date("2026-08-05T12:00:00.000Z"),
    );
    assert.equal(elementsWith(snapDupHtml, "data-board-error")[0]?.["data-board-error"], "binding");
    assert.equal(elementsWith(snapDupHtml, "data-lane").length, 0);
    assert.equal(elementsWith(snapDupHtml, "data-ticket").length, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("nested A→B→C is one rooted whole-family with each ticket rendered once", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-nested-family-"));
  try {
    const ledgerDir = join(workspace, "ledger");
    for (const n of [10, 11, 12]) {
      await mkdir(join(ledgerDir, "issues", String(n)), { recursive: true });
    }
    const html = await renderFactoryBoardHtml(
      [{ bookKey: "roles", ledgerDir }],
      {
        ok: true,
        snapshot: {
          books: [
            {
              bookKey: "roles",
              owner: "acme",
              repo: "roles",
              tickets: [
                ticket({ issueNumber: 10, title: "root-A", state: "open" }),
                ticket({
                  issueNumber: 11,
                  title: "mid-B",
                  state: "open",
                  parentIssueNumber: 10,
                }),
                ticket({
                  issueNumber: 12,
                  title: "leaf-C",
                  state: "open",
                  parentIssueNumber: 11,
                }),
              ],
            },
          ],
        },
      },
      new Date("2026-08-05T12:00:00.000Z"),
    );

    const families = elementsWith(html, "data-family").filter((el) => el["data-book"] === "roles");
    assert.equal(families.length, 1, "exactly one root family for A→B→C");
    assert.equal(families[0]?.["data-parent"], "10");
    assert.equal(families[0]?.["data-child-count"], "2", "whole-family descendant count is two");

    const articles = elementsWith(html, "data-ticket").filter((t) => t["data-book"] === "roles");
    const byNum = new Map(articles.map((t) => [t["data-ticket"], t]));
    assert.equal(articles.length, 3, "exactly one article each for A/B/C");
    assert.ok(byNum.get("10"), "A present once");
    assert.ok(byNum.get("11"), "B present once");
    assert.ok(byNum.get("12"), "C present once");
    assert.equal(byNum.get("11")?.["data-parent-issue"], "10");
    assert.equal(byNum.get("12")?.["data-parent-issue"], "11");

    // Intermediate B must not spawn a second family root.
    assert.equal(
      elementsWith(html, "data-family").filter((el) => el["data-parent"] === "11").length,
      0,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// S3 — latest-run four-state, wallclock, cost (production seam only)
// ---------------------------------------------------------------------------

async function writeRunSession(
  ledgerDir: string,
  issueNumber: number,
  runId: string,
  rows: unknown[],
  options?: { invocationRole?: string; mtime?: Date; axisLegs?: Array<{ name: string; rows: unknown[] }> },
): Promise<string> {
  const sessionDir = join(ledgerDir, "issues", String(issueNumber), "runs", runId, "session");
  await mkdir(sessionDir, { recursive: true });
  const sessionPath = join(sessionDir, "session.jsonl");
  await writeFile(sessionPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  if (options?.invocationRole) {
    await writeFile(
      join(ledgerDir, "issues", String(issueNumber), "runs", runId, "invocation.json"),
      JSON.stringify({ role: options.invocationRole }),
      "utf8",
    );
  }
  if (options?.axisLegs) {
    const legsDir = join(sessionDir, "reviewer-legs");
    await mkdir(legsDir, { recursive: true });
    for (const leg of options.axisLegs) {
      const legPath = join(legsDir, `${leg.name}.jsonl`);
      await writeFile(legPath, leg.rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
      if (options.mtime) await utimes(legPath, options.mtime, options.mtime);
    }
  }
  if (options?.mtime) await utimes(sessionPath, options.mtime, options.mtime);
  return sessionPath;
}

function sessionHeader(ts: string, id = "s1"): unknown {
  return { type: "session", version: 3, id, timestamp: ts, cwd: "/tmp" };
}

function assistantUsage(ts: string, costTotal: number, totalTokens: number): unknown {
  return {
    type: "message",
    timestamp: ts,
    message: {
      role: "assistant",
      model: "m",
      provider: "p",
      content: [{ type: "text", text: "ok" }],
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
      },
    },
  };
}

/** Minimal accepted coder terminating result (typed contract). */
function acceptedCoderFinal(ts: string, costTotal = 0.01, totalTokens = 10): unknown[] {
  return [
    {
      type: "message",
      timestamp: ts,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "ak_coder_output", arguments: {} }],
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
        },
      },
    },
    {
      type: "message",
      timestamp: ts,
      message: {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "ak_coder_output",
        isError: false,
        content: [],
        details: {
          status: "completed",
          report: "done",
        },
      },
    },
  ];
}

test("S3 four-state is mutually exclusive and decided only by the latest run", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-s3-state-"));
  try {
    const ledgerDir = join(workspace, "ledger");
    const now = new Date("2026-08-05T12:00:00.000Z");
    const nowMs = now.getTime();

    // #1 closed with runs
    await writeRunSession(
      ledgerDir,
      1,
      "coder-done@x",
      [sessionHeader("2026-08-01T00:00:00.000Z"), ...acceptedCoderFinal("2026-08-01T00:01:00.000Z", 0.02, 20)],
      { mtime: new Date(nowMs - 60_000) },
    );
    // #2 pending zero-run open
    await mkdir(join(ledgerDir, "issues", "2"), { recursive: true });
    // #3 latest unaccepted flying (<2min mtime)
    await writeRunSession(
      ledgerDir,
      3,
      "coder-fly@x",
      [
        sessionHeader("2026-08-05T11:59:00.000Z"),
        assistantUsage("2026-08-05T11:59:30.000Z", 0.05, 50),
      ],
      { invocationRole: "coder", mtime: new Date(nowMs - 30_000) },
    );
    // #4 latest unaccepted watch (2–15min)
    await writeRunSession(
      ledgerDir,
      4,
      "coder-watch@x",
      [
        sessionHeader("2026-08-05T11:50:00.000Z"),
        assistantUsage("2026-08-05T11:51:00.000Z", 0.06, 60),
      ],
      { invocationRole: "coder", mtime: new Date(nowMs - 5 * 60_000) },
    );
    // #5 latest unaccepted suspect (>15min) — dead latest stays suspect
    await writeRunSession(
      ledgerDir,
      5,
      "coder-dead@x",
      [
        sessionHeader("2026-08-05T10:00:00.000Z"),
        assistantUsage("2026-08-05T10:05:00.000Z", 0.07, 70),
      ],
      { invocationRole: "coder", mtime: new Date(nowMs - 40 * 60_000) },
    );
    // #6 #127-morph: historical unaccepted then latest accepted → accepted-awaiting
    await writeRunSession(
      ledgerDir,
      6,
      "review-fail@x",
      [
        sessionHeader("2026-08-04T10:00:00.000Z"),
        assistantUsage("2026-08-04T10:10:00.000Z", 0.11, 100),
      ],
      { invocationRole: "reviewer", mtime: new Date(nowMs - 86_400_000) },
    );
    await writeRunSession(
      ledgerDir,
      6,
      "coder-ok@x",
      [
        sessionHeader("2026-08-05T08:00:00.000Z"),
        ...acceptedCoderFinal("2026-08-05T08:05:00.000Z", 0.22, 200),
      ],
      { mtime: new Date(nowMs - 3_600_000) },
    );
    // #7 pending + blocked badge (badge must not change state)
    await mkdir(join(ledgerDir, "issues", "7"), { recursive: true });
    // #8 exact 2min boundary → watch (flying is strict <2min)
    await writeRunSession(
      ledgerDir,
      8,
      "coder-exact-2@x",
      [
        sessionHeader("2026-08-05T11:58:00.000Z"),
        assistantUsage("2026-08-05T11:58:30.000Z", 0.01, 10),
      ],
      { invocationRole: "coder", mtime: new Date(nowMs - UNACCEPTED_FLYING_MS) },
    );
    // #9 exact 15min boundary → watch (suspect is strict >15min)
    await writeRunSession(
      ledgerDir,
      9,
      "coder-exact-15@x",
      [
        sessionHeader("2026-08-05T11:45:00.000Z"),
        assistantUsage("2026-08-05T11:45:30.000Z", 0.01, 10),
      ],
      { invocationRole: "coder", mtime: new Date(nowMs - UNACCEPTED_WATCH_MS) },
    );
    // #10 just over 15min → suspect
    await writeRunSession(
      ledgerDir,
      10,
      "coder-over-15@x",
      [
        sessionHeader("2026-08-05T11:44:00.000Z"),
        assistantUsage("2026-08-05T11:44:30.000Z", 0.01, 10),
      ],
      { invocationRole: "coder", mtime: new Date(nowMs - UNACCEPTED_WATCH_MS - 1) },
    );

    const html = await renderFactoryBoardHtml(
      [{ bookKey: "roles", ledgerDir }],
      {
        ok: true,
        snapshot: {
          books: [
            {
              bookKey: "roles",
              owner: "acme",
              repo: "roles",
              tickets: [
                ticket({
                  issueNumber: 1,
                  title: "closed",
                  state: "closed",
                  closedAt: "2026-08-02T00:00:00.000Z",
                }),
                ticket({ issueNumber: 2, title: "pending", state: "open" }),
                ticket({ issueNumber: 3, title: "fly", state: "open" }),
                ticket({ issueNumber: 4, title: "watch", state: "open" }),
                ticket({ issueNumber: 5, title: "suspect", state: "open" }),
                ticket({ issueNumber: 6, title: "127-morph", state: "open" }),
                ticket({
                  issueNumber: 7,
                  title: "blocked-pending",
                  state: "open",
                  blockedBy: [{ issueNumber: 6, state: "open" }],
                }),
                ticket({ issueNumber: 8, title: "exact-2", state: "open" }),
                ticket({ issueNumber: 9, title: "exact-15", state: "open" }),
                ticket({ issueNumber: 10, title: "over-15", state: "open" }),
              ],
            },
          ],
        },
      },
      now,
    );

    // Thresholds page-visible
    assert.equal(
      elementsWith(html, "data-threshold-flying-ms")[0]?.["data-threshold-flying-ms"],
      String(UNACCEPTED_FLYING_MS),
    );
    assert.equal(
      elementsWith(html, "data-threshold-watch-ms")[0]?.["data-threshold-watch-ms"],
      String(UNACCEPTED_WATCH_MS),
    );

    const by = (n: number) =>
      elementsWith(html, "data-ticket").find((t) => t["data-book"] === "roles" && t["data-ticket"] === String(n));

    assert.equal(by(1)?.["data-current-state"], "closed");
    assert.equal(by(2)?.["data-current-state"], "pending");
    assert.equal(by(2)?.["data-pending"], "true");
    assert.equal(by(3)?.["data-current-state"], "unaccepted-flying");
    assert.equal(by(4)?.["data-current-state"], "unaccepted-watch");
    assert.equal(by(5)?.["data-current-state"], "unaccepted-suspect");
    assert.equal(by(6)?.["data-current-state"], "accepted-awaiting");
    // blocked badge stacks; state remains pending
    assert.equal(by(7)?.["data-current-state"], "pending");
    assert.equal(by(7)?.["data-blocked-by"], "6");
    assert.ok(
      elementsWith(html, "data-blocked-badge").some(
        (b) => b["data-blocked-badge"] === "6" && b["data-ticket"] === "7",
      ),
    );

    // Unaccepted legs visibly expose leg age + last activity via dedicated label spans
    // (not only article projection attrs — deleting activityBits must fail these).
    const flyAge = visibleTicketLabel(html, "data-leg-age-label", 3, "roles");
    const flyAct = visibleTicketLabel(html, "data-last-activity-label", 3, "roles");
    assert.ok(flyAge, "flying ticket must render visible leg-age label");
    assert.ok(flyAct, "flying ticket must render visible last-activity label");
    assert.equal(Number(flyAge["data-leg-age-ms"]), 60_000);
    assert.ok(flyAct["data-last-activity-mtime-ms"] !== undefined);
    // Article projection stays aligned with the visible labels.
    assert.equal(by(3)?.["data-leg-age-ms"], flyAge["data-leg-age-ms"]);
    assert.equal(by(3)?.["data-last-activity-mtime-ms"], flyAct["data-last-activity-mtime-ms"]);

    assert.equal(by(5)?.["data-current-state"], "unaccepted-suspect");
    const suspectAge = visibleTicketLabel(html, "data-leg-age-label", 5, "roles");
    assert.ok(suspectAge, "suspect ticket must render visible leg-age label");
    assert.ok(Number(suspectAge["data-leg-age-ms"]) > UNACCEPTED_WATCH_MS);
    assert.ok(visibleTicketLabel(html, "data-last-activity-label", 5, "roles"));

    // Non-unaccepted states must not show leg-age / last-activity labels.
    for (const n of [1, 2, 6, 7]) {
      assert.equal(
        visibleTicketLabel(html, "data-leg-age-label", n, "roles"),
        undefined,
        `#${n} must not show leg-age label outside unaccepted bands`,
      );
      assert.equal(
        visibleTicketLabel(html, "data-last-activity-label", n, "roles"),
        undefined,
        `#${n} must not show last-activity label outside unaccepted bands`,
      );
    }

    // Exact threshold boundaries (authority: 2–15 watch inclusive at 15; >15 suspect)
    assert.equal(by(8)?.["data-current-state"], "unaccepted-watch");
    assert.equal(by(9)?.["data-current-state"], "unaccepted-watch");
    assert.equal(by(10)?.["data-current-state"], "unaccepted-suspect");
    for (const n of [4, 8, 9, 10]) {
      assert.ok(
        visibleTicketLabel(html, "data-leg-age-label", n, "roles"),
        `#${n} unaccepted band must show visible leg-age`,
      );
      assert.ok(
        visibleTicketLabel(html, "data-last-activity-label", n, "roles"),
        `#${n} unaccepted band must show visible last-activity`,
      );
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("S3 last activity projects newest parent/axis content timestamp", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-s3-activity-"));
  try {
    const ledgerDir = join(workspace, "ledger");
    const now = new Date("2026-08-05T12:00:00.000Z");
    // Parent last record 11:00; axis leg continues to 11:30 — activity must be 11:30, not parent endedAt.
    await writeRunSession(
      ledgerDir,
      40,
      "review-axis-newer@x",
      [
        sessionHeader("2026-08-05T10:00:00.000Z"),
        assistantUsage("2026-08-05T11:00:00.000Z", 0.1, 100),
      ],
      {
        invocationRole: "reviewer",
        mtime: new Date(now.getTime() - 30_000),
        axisLegs: [
          {
            name: "standards",
            rows: [
              sessionHeader("2026-08-05T10:05:00.000Z", "leg-s"),
              assistantUsage("2026-08-05T11:30:00.000Z", 0.2, 200),
            ],
          },
        ],
      },
    );

    const html = await renderFactoryBoardHtml(
      [{ bookKey: "roles", ledgerDir }],
      {
        ok: true,
        snapshot: {
          books: [
            {
              bookKey: "roles",
              owner: "acme",
              repo: "roles",
              tickets: [ticket({ issueNumber: 40, title: "axis-activity", state: "open" })],
            },
          ],
        },
      },
      now,
    );
    const t = elementsWith(html, "data-ticket").find((el) => el["data-ticket"] === "40");
    assert.ok(t);
    assert.match(t["data-current-state"] ?? "", /^unaccepted-/);
    assert.equal(t["data-last-activity-at"], "2026-08-05T11:30:00.000Z");
    assert.notEqual(t["data-last-activity-at"], "2026-08-05T11:00:00.000Z");
    // Visible last-activity label must carry the axis-newer timestamp (not article-only).
    const actLabel = visibleTicketLabel(html, "data-last-activity-label", 40);
    assert.ok(actLabel, "unaccepted ticket must render visible last-activity label");
    assert.equal(actLabel["data-last-activity-at"], "2026-08-05T11:30:00.000Z");
    assert.ok(visibleTicketLabel(html, "data-leg-age-label", 40), "visible leg-age label required");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("S3 wallclock: only current latest unaccepted ends at now; historical unaccepted stay capped", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-s3-wall-"));
  try {
    const ledgerDir = join(workspace, "ledger");
    // Historical unaccepted: 10:00–10:05 (=300000ms)
    await writeRunSession(
      ledgerDir,
      10,
      "old-unaccepted@x",
      [
        sessionHeader("2026-08-05T10:00:00.000Z"),
        assistantUsage("2026-08-05T10:05:00.000Z", 0.01, 10),
      ],
      { invocationRole: "coder", mtime: new Date("2026-08-05T10:05:00.000Z") },
    );
    // Latest unaccepted: 11:00–11:01; mtime stale enough for suspect but wall uses now
    await writeRunSession(
      ledgerDir,
      10,
      "latest-unaccepted@x",
      [
        sessionHeader("2026-08-05T11:00:00.000Z"),
        assistantUsage("2026-08-05T11:01:00.000Z", 0.02, 20),
      ],
      { invocationRole: "coder", mtime: new Date("2026-08-05T11:01:00.000Z") },
    );

    const nowA = new Date("2026-08-05T12:00:00.000Z");
    const nowB = new Date("2026-08-05T13:00:00.000Z");
    const view: FactoryBoardView = {
      ok: true,
      snapshot: {
        books: [
          {
            bookKey: "roles",
            owner: "acme",
            repo: "roles",
            tickets: [ticket({ issueNumber: 10, title: "wall", state: "open" })],
          },
        ],
      },
    };
    const htmlA = await renderFactoryBoardHtml([{ bookKey: "roles", ledgerDir }], view, nowA);
    const htmlB = await renderFactoryBoardHtml([{ bookKey: "roles", ledgerDir }], view, nowB);

    const oldA = elementsWith(htmlA, "data-run-id").find((r) => r["data-run-id"] === "old-unaccepted@x");
    const latestA = elementsWith(htmlA, "data-run-id").find((r) => r["data-run-id"] === "latest-unaccepted@x");
    const oldB = elementsWith(htmlB, "data-run-id").find((r) => r["data-run-id"] === "old-unaccepted@x");
    const latestB = elementsWith(htmlB, "data-run-id").find((r) => r["data-run-id"] === "latest-unaccepted@x");
    assert.ok(oldA && latestA && oldB && latestB);

    // Historical capped at last record: 5 minutes
    assert.equal(oldA["data-wall-ms"], "300000");
    assert.equal(oldB["data-wall-ms"], "300000", "historical unaccepted must not inflate with now");

    // Latest unaccepted: 11:00 → nowA 12:00 = 3600000; → nowB 13:00 = 7200000
    assert.equal(latestA["data-wall-ms"], "3600000");
    assert.equal(latestB["data-wall-ms"], "7200000");

    const ticketA = elementsWith(htmlA, "data-ticket").find((t) => t["data-ticket"] === "10");
    const ticketB = elementsWith(htmlB, "data-ticket").find((t) => t["data-ticket"] === "10");
    assert.ok(ticketA && ticketB);
    // Ticket construction wall = sum of run walls (no axis here)
    assert.equal(Number(ticketA["data-wall-ms"]), 300000 + 3600000);
    assert.equal(Number(ticketB["data-wall-ms"]), 300000 + 7200000);
    // Landing cycle is separate: first start 10:00 → now
    assert.equal(ticketA["data-landing-cycle-ms"], String(2 * 3600_000));
    assert.equal(ticketB["data-landing-cycle-ms"], String(3 * 3600_000));
    assert.notEqual(ticketA["data-landing-cycle-ms"], ticketA["data-wall-ms"]);
    // Visible wall + landing labels are distinct elements (并列显示); deleting either fails.
    const wallLabelA = visibleTicketLabel(htmlA, "data-wall-label", 10);
    const landLabelA = visibleTicketLabel(htmlA, "data-landing-label", 10);
    assert.ok(wallLabelA && landLabelA, "wall and landing must both render as visible labels");
    assert.equal(wallLabelA["data-wall-ms"], ticketA["data-wall-ms"]);
    assert.equal(landLabelA["data-landing-cycle-ms"], ticketA["data-landing-cycle-ms"]);
    assert.notEqual(wallLabelA["data-wall-ms"], landLabelA["data-landing-cycle-ms"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("S3 landing cycle: open ends at now; closed ends at closedAt not last ledger record", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-s3-landing-"));
  try {
    const ledgerDir = join(workspace, "ledger");
    // First run 10:00–10:30; second (last ledger) 11:00–11:15.
    await writeRunSession(
      ledgerDir,
      77,
      "first@x",
      [
        sessionHeader("2026-08-05T10:00:00.000Z"),
        ...acceptedCoderFinal("2026-08-05T10:30:00.000Z", 0.1, 100),
      ],
      { mtime: new Date("2026-08-05T10:30:00.000Z") },
    );
    await writeRunSession(
      ledgerDir,
      77,
      "last@x",
      [
        sessionHeader("2026-08-05T11:00:00.000Z"),
        ...acceptedCoderFinal("2026-08-05T11:15:00.000Z", 0.2, 200),
      ],
      { mtime: new Date("2026-08-05T11:15:00.000Z") },
    );

    const now = new Date("2026-08-05T14:00:00.000Z");
    // Closure deliberately later than the final run record (11:15).
    const closedAt = "2026-08-05T13:00:00.000Z";
    const books: FactoryBoardBook[] = [{ bookKey: "roles", ledgerDir }];

    const openHtml = await renderFactoryBoardHtml(
      books,
      {
        ok: true,
        snapshot: {
          books: [
            {
              bookKey: "roles",
              owner: "acme",
              repo: "roles",
              tickets: [ticket({ issueNumber: 77, title: "open-land", state: "open" })],
            },
          ],
        },
      },
      now,
    );
    const closedHtml = await renderFactoryBoardHtml(
      books,
      {
        ok: true,
        snapshot: {
          books: [
            {
              bookKey: "roles",
              owner: "acme",
              repo: "roles",
              tickets: [
                ticket({
                  issueNumber: 77,
                  title: "closed-land",
                  state: "closed",
                  closedAt,
                }),
              ],
            },
          ],
        },
      },
      now,
    );

    const openTicket = elementsWith(openHtml, "data-ticket").find((t) => t["data-ticket"] === "77");
    const closedTicket = elementsWith(closedHtml, "data-ticket").find(
      (t) => t["data-ticket"] === "77",
    );
    assert.ok(openTicket && closedTicket);

    // Construction wall = sum of run walls only (30m + 15m); independent of landing/now/closure.
    const constructionWallMs = 30 * 60_000 + 15 * 60_000;
    assert.equal(openTicket["data-wall-ms"], String(constructionWallMs));
    assert.equal(closedTicket["data-wall-ms"], String(constructionWallMs));

    // Open landing: first start 10:00 → injected now 14:00.
    assert.equal(openTicket["data-landing-cycle-ms"], String(4 * 3600_000));
    // Closed landing: first start 10:00 → closedAt 13:00 (not last ledger 11:15, not now 14:00).
    assert.equal(closedTicket["data-landing-cycle-ms"], String(3 * 3600_000));
    assert.notEqual(
      closedTicket["data-landing-cycle-ms"],
      String(Date.parse("2026-08-05T11:15:00.000Z") - Date.parse("2026-08-05T10:00:00.000Z")),
      "closed landing must not end at last ledger record",
    );
    assert.notEqual(
      closedTicket["data-landing-cycle-ms"],
      openTicket["data-landing-cycle-ms"],
      "closed landing must not keep stretching to injected now",
    );
    assert.notEqual(closedTicket["data-landing-cycle-ms"], closedTicket["data-wall-ms"]);
    assert.notEqual(openTicket["data-landing-cycle-ms"], openTicket["data-wall-ms"]);

    // Visible labels carry the same split (并列显示) for open and closed.
    for (const [html, expectedLand] of [
      [openHtml, openTicket["data-landing-cycle-ms"]],
      [closedHtml, closedTicket["data-landing-cycle-ms"]],
    ] as const) {
      const wallL = visibleTicketLabel(html, "data-wall-label", 77);
      const landL = visibleTicketLabel(html, "data-landing-label", 77);
      assert.ok(wallL && landL);
      assert.equal(wallL["data-wall-ms"], String(constructionWallMs));
      assert.equal(landL["data-landing-cycle-ms"], expectedLand);
      assert.notEqual(wallL["data-wall-ms"], landL["data-landing-cycle-ms"]);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("S3 cost/tokens aggregate per station and ticket; axis legs fold into station; sort control present", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-s3-cost-"));
  try {
    const ledgerDir = join(workspace, "ledger");
    const now = new Date("2026-08-05T12:00:00.000Z");

    // Reviewer parent + two axis legs
    await writeRunSession(
      ledgerDir,
      20,
      "review-axis@x",
      [
        sessionHeader("2026-08-05T09:00:00.000Z"),
        assistantUsage("2026-08-05T09:10:00.000Z", 1.0, 1000),
      ],
      {
        invocationRole: "reviewer",
        mtime: new Date(now.getTime() - 3600_000),
        axisLegs: [
          {
            name: "standards",
            rows: [
              sessionHeader("2026-08-05T09:01:00.000Z", "leg-s"),
              assistantUsage("2026-08-05T09:03:00.000Z", 0.25, 250),
            ],
          },
          {
            name: "spec",
            rows: [
              sessionHeader("2026-08-05T09:01:00.000Z", "leg-p"),
              assistantUsage("2026-08-05T09:04:00.000Z", 0.4, 400),
            ],
          },
        ],
      },
    );
    // Second ticket cheaper coder accepted
    await writeRunSession(
      ledgerDir,
      21,
      "coder-cheap@x",
      [
        sessionHeader("2026-08-05T08:00:00.000Z"),
        ...acceptedCoderFinal("2026-08-05T08:02:00.000Z", 0.05, 50),
      ],
      { mtime: new Date(now.getTime() - 7200_000) },
    );

    // #130-style multi-round auditor costs visible: two auditor runs on #22
    await writeRunSession(
      ledgerDir,
      22,
      "auditor-1@x",
      [
        sessionHeader("2026-08-05T07:00:00.000Z"),
        assistantUsage("2026-08-05T07:05:00.000Z", 0.3, 300),
      ],
      { invocationRole: "auditor", mtime: new Date(now.getTime() - 10_000_000) },
    );
    await writeRunSession(
      ledgerDir,
      22,
      "auditor-2@x",
      [
        sessionHeader("2026-08-05T07:30:00.000Z"),
        assistantUsage("2026-08-05T07:40:00.000Z", 0.5, 500),
      ],
      { invocationRole: "auditor", mtime: new Date(now.getTime() - 9_000_000) },
    );

    const html = await renderFactoryBoardHtml(
      [{ bookKey: "roles", ledgerDir }],
      {
        ok: true,
        snapshot: {
          books: [
            {
              bookKey: "roles",
              owner: "acme",
              repo: "roles",
              tickets: [
                ticket({ issueNumber: 20, title: "axis", state: "open" }),
                ticket({ issueNumber: 21, title: "cheap", state: "open" }),
                ticket({ issueNumber: 22, title: "multi-auditor", state: "open" }),
              ],
            },
          ],
        },
      },
      now,
    );

    const t20 = elementsWith(html, "data-ticket").find((t) => t["data-ticket"] === "20");
    const t21 = elementsWith(html, "data-ticket").find((t) => t["data-ticket"] === "21");
    const t22 = elementsWith(html, "data-ticket").find((t) => t["data-ticket"] === "22");
    assert.ok(t20 && t21 && t22);

    // Parent 1.0 + legs 0.25 + 0.4 = 1.65
    assert.equal(Number(t20["data-cost-usd"]), 1.65);
    assert.equal(Number(t20["data-total-tokens"]), 1650);
    assert.equal(Number(t21["data-cost-usd"]), 0.05);
    assert.equal(Number(t22["data-cost-usd"]), 0.8);
    assert.equal(Number(t22["data-total-tokens"]), 800);
    // Visible cost labels (not article attrs alone) carry the same burn figures.
    for (const [n, cost, tokens] of [
      [20, 1.65, 1650],
      [21, 0.05, 50],
      [22, 0.8, 800],
    ] as const) {
      const costLabel = visibleTicketLabel(html, "data-cost-label", n, "roles");
      assert.ok(costLabel, `#${n} must render visible cost label`);
      assert.equal(Number(costLabel["data-cost-usd"]), cost);
      assert.equal(Number(costLabel["data-total-tokens"]), tokens);
    }

    const axisRun = elementsWith(html, "data-run-id").find((r) => r["data-run-id"] === "review-axis@x");
    assert.ok(axisRun);
    assert.equal(Number(axisRun["data-cost-usd"]), 1.65);
    assert.equal(Number(axisRun["data-total-tokens"]), 1650);
    // axis wall = 2min + 3min = 300000; parent wall extended to now from 09:00 → 12:00 = 10800000
    assert.equal(Number(axisRun["data-axis-wall-ms"]), 2 * 60_000 + 3 * 60_000);

    const reviewerStation = elementsWith(html, "data-station-block").find(
      (s) => s["data-station-block"] === "reviewer",
    );
    assert.ok(reviewerStation);
    assert.equal(Number(reviewerStation["data-station-cost-usd"]), 1.65);
    // station wall includes parent wallMs + axisWallMs
    assert.equal(
      Number(reviewerStation["data-station-wall-ms"]),
      Number(axisRun["data-wall-ms"]) + Number(axisRun["data-axis-wall-ms"]),
    );

    const auditorStation = elementsWith(html, "data-station-block").find(
      (s) => s["data-station-block"] === "auditor",
    );
    assert.ok(auditorStation, "#130 multi-round auditor station visible");
    assert.equal(Number(auditorStation["data-station-cost-usd"]), 0.8);
    assert.equal(auditorStation["data-round-count"], "2");

    // Sort control present + production page script executes the claimed order
    assert.ok(elementsWith(html, "data-sort-control").length >= 1);
    assert.match(html, /cost-desc/);
    assert.match(html, /cost-asc/);
    // One-shot render does not advertise a refresh bound
    assert.equal(elementsWith(html, "data-lifecycle")[0]?.["data-lifecycle"], "oneshot");
    assert.equal(elementsWith(html, "data-refresh-boundary-seconds").length, 0);

    // costs: #20=1.65, #21=0.05, #22=0.8 — proved by running the embedded page control
    assert.deepEqual(
      executeProductionBoardSort(html, "roles", "cost-asc").map(laneSortIdentity),
      [21, 22, 20],
    );
    assert.deepEqual(
      executeProductionBoardSort(html, "roles", "cost-desc").map(laneSortIdentity),
      [20, 22, 21],
    );
    assert.deepEqual(
      executeProductionBoardSort(html, "roles", "ticket-asc").map(laneSortIdentity),
      [20, 21, 22],
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("S3 board projects no textual conclusion and excludes unlabelled narrative self-report", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-s3-conclusion-"));
  try {
    const ledgerDir = join(workspace, "ledger");
    const now = new Date("2026-08-05T12:00:00.000Z");
    // Session carries free-text assistant narrative + a model-claimed commitSha inside an
    // unaccepted attempt — board must not promote either into conclusion/self-report stats.
    await writeRunSession(
      ledgerDir,
      55,
      "narrative-noise@x",
      [
        sessionHeader("2026-08-05T11:00:00.000Z"),
        {
          type: "message",
          timestamp: "2026-08-05T11:05:00.000Z",
          message: {
            role: "assistant",
            model: "m",
            provider: "p",
            content: [
              {
                type: "text",
                text: "断势：趋势上升，建议加派。commitSha=deadbeefcafebabe",
              },
            ],
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 10,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
            },
          },
        },
      ],
      { invocationRole: "fixer", mtime: new Date(now.getTime() - 30_000) },
    );

    const html = await renderFactoryBoardHtml(
      [{ bookKey: "roles", ledgerDir }],
      {
        ok: true,
        snapshot: {
          books: [
            {
              bookKey: "roles",
              owner: "acme",
              repo: "roles",
              tickets: [ticket({ issueNumber: 55, title: "noise", state: "open" })],
            },
          ],
        },
      },
      now,
    );

    // Projection-field allowlist audit: no conclusion / trend / unlabelled self-report channels.
    for (const banned of [
      "data-conclusion",
      "data-divination",
      "data-trend",
      "data-forecast",
      "data-self-report",
      "data-narrative",
      "data-commit-sha",
      "data-commitsha",
    ]) {
      assert.equal(
        elementsWith(html, banned).length,
        0,
        `board must not project ${banned}`,
      );
      assert.doesNotMatch(html, new RegExp(`${banned}=`));
    }
    // Free-text assistant narrative must not be copied into the page body as a fact channel.
    assert.doesNotMatch(html, /断势/);
    assert.doesNotMatch(html, /趋势上升/);
    assert.doesNotMatch(html, /deadbeefcafebabe/);
    // Mechanical burn still projects; narrative does not ride along.
    const t = elementsWith(html, "data-ticket").find((el) => el["data-ticket"] === "55");
    assert.ok(t);
    assert.equal(Number(t["data-cost-usd"]), 0.01);
    assert.equal(Number(t["data-total-tokens"]), 10);
    assert.match(t["data-current-state"] ?? "", /^unaccepted-/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("S3 production sort: #130 per-ticket burn participates under native #78 family", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-s3-sort-family-"));
  try {
    const ledgerDir = join(workspace, "ledger");
    const now = new Date("2026-08-05T12:00:00.000Z");

    // #78 parent: tiny burn
    await writeRunSession(
      ledgerDir,
      78,
      "coder-parent@x",
      [
        sessionHeader("2026-08-05T08:00:00.000Z"),
        ...acceptedCoderFinal("2026-08-05T08:01:00.000Z", 0.01, 10),
      ],
      { mtime: new Date(now.getTime() - 7200_000) },
    );
    // #130 child under #78: large multi-round burn (the named authority ticket)
    await writeRunSession(
      ledgerDir,
      130,
      "review-hot-1@x",
      [
        sessionHeader("2026-08-05T07:00:00.000Z"),
        assistantUsage("2026-08-05T07:20:00.000Z", 2.0, 2000),
      ],
      { invocationRole: "reviewer", mtime: new Date(now.getTime() - 10_000_000) },
    );
    await writeRunSession(
      ledgerDir,
      130,
      "review-hot-2@x",
      [
        sessionHeader("2026-08-05T07:30:00.000Z"),
        assistantUsage("2026-08-05T07:50:00.000Z", 3.0, 3000),
      ],
      { invocationRole: "reviewer", mtime: new Date(now.getTime() - 9_000_000) },
    );
    // Standalone medium burner — without #130 in family aggregate, family would sort below this
    await writeRunSession(
      ledgerDir,
      50,
      "coder-mid@x",
      [
        sessionHeader("2026-08-05T09:00:00.000Z"),
        ...acceptedCoderFinal("2026-08-05T09:05:00.000Z", 1.0, 1000),
      ],
      { mtime: new Date(now.getTime() - 3600_000) },
    );
    // Standalone cheap
    await writeRunSession(
      ledgerDir,
      40,
      "coder-cheap@x",
      [
        sessionHeader("2026-08-05T10:00:00.000Z"),
        ...acceptedCoderFinal("2026-08-05T10:01:00.000Z", 0.05, 50),
      ],
      { mtime: new Date(now.getTime() - 1800_000) },
    );

    const html = await renderFactoryBoardHtml(
      [{ bookKey: "roles", ledgerDir }],
      {
        ok: true,
        snapshot: {
          books: [
            {
              bookKey: "roles",
              owner: "acme",
              repo: "roles",
              tickets: [
                ticket({ issueNumber: 78, title: "family parent", state: "open" }),
                ticket({
                  issueNumber: 130,
                  title: "hot child",
                  state: "closed",
                  parentIssueNumber: 78,
                  closedAt: "2026-08-05T04:03:43Z",
                }),
                ticket({ issueNumber: 50, title: "mid standalone", state: "open" }),
                ticket({ issueNumber: 40, title: "cheap standalone", state: "open" }),
              ],
            },
          ],
        },
      },
      now,
    );

    const family = elementsWith(html, "data-family").find((f) => f["data-parent"] === "78");
    const t130 = elementsWith(html, "data-ticket").find((t) => t["data-ticket"] === "130");
    const t78 = elementsWith(html, "data-ticket").find((t) => t["data-ticket"] === "78");
    const t50 = elementsWith(html, "data-ticket").find((t) => t["data-ticket"] === "50");
    assert.ok(family && t130 && t78 && t50);
    assert.equal(t130["data-parent-issue"], "78", "native #78 family edge retained");
    assert.equal(Number(t130["data-cost-usd"]), 5.0);
    assert.equal(Number(t78["data-cost-usd"]), 0.01);
    // Family aggregate includes #130 per-ticket burn (0.01 + 5.0)
    assert.equal(Number(family["data-cost-usd"]), 5.01);
    assert.ok(Number(family["data-cost-usd"]) > Number(t50["data-cost-usd"]));

    // Execute the production page control — family led by #130 burn sorts first on cost-desc
    const desc = executeProductionBoardSort(html, "roles", "cost-desc").map(laneSortIdentity);
    assert.deepEqual(desc, [78, 50, 40], "#78 family (carrying #130 burn) leads cost-desc");
    const asc = executeProductionBoardSort(html, "roles", "cost-asc").map(laneSortIdentity);
    assert.deepEqual(asc, [40, 50, 78]);

    // Counterfactual: parent-only costs (0.01 / 1.0 / 0.05) would bury the family on cost-desc.
    // Production order above differs because the family key carries #130's nested burn.
    assert.notDeepEqual(desc, [50, 40, 78], "aggregate #130 burn must move family off parent-only order");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("S3 frozen authentic #127 accepted-after-rejections is accepted-awaiting", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-s3-127-"));
  try {
    const rolesLedger = join(workspace, "ledgers", "roles");
    await cp(fixtureLedger, rolesLedger, { recursive: true });
    // Controlling frozen counterexample: multi-round unaccepted then latest accepted.
    // Shared S1 fixture keeps later unaccepted review-026 for other contracts; the
    // accepted-after-rejections freeze is the authentic prefix without that later run
    // and without synthetic appends or mutable true-home tail runs.
    await rm(join(rolesLedger, "issues", "127", "runs", "review-026@ak-roles-127"), {
      recursive: true,
      force: true,
    });
    const now = new Date("2026-08-05T12:00:00.000Z");
    const html = await renderFactoryBoardHtml(
      [{ bookKey: "roles", ledgerDir: rolesLedger }],
      {
        ok: true,
        snapshot: {
          books: [
            {
              bookKey: "roles",
              owner: "acme",
              repo: "roles",
              tickets: [ticket({ issueNumber: 127, title: "child with runs", state: "open" })],
            },
          ],
        },
      },
      now,
    );
    const t = elementsWith(html, "data-ticket").find((x) => x["data-ticket"] === "127");
    assert.ok(t);
    // Latest authentic run is fixer-apply-001 (accepted) after prior unaccepted reviews
    assert.equal(t["data-current-state"], "accepted-awaiting");
    const fixer = elementsWith(html, "data-run-id").find(
      (r) => r["data-run-id"] === "fixer-apply-001@ak-roles-127",
    );
    assert.ok(fixer);
    assert.equal(fixer["data-has-result"], "true");
    assert.equal(fixer["data-result-status"], "completed");
    // Prior unaccepted attempt remains visible and is not now-extended
    const zero = elementsWith(html, "data-run-id").find(
      (r) => r["data-run-id"] === "review-005s@ak-roles-127",
    );
    assert.ok(zero);
    assert.equal(zero["data-has-result"], "false");
    assert.equal(zero["data-wall-ms"], "337448");
    // Known fixture costs still roll up
    const plan = elementsWith(html, "data-run-id").find(
      (r) => r["data-run-id"] === "plan-court-001@ak-roles-127",
    );
    assert.ok(plan);
    assert.ok(Number(plan["data-cost-usd"]) > 0.9);
    const runCosts = elementsWith(html, "data-run-id").map((r) => Number(r["data-cost-usd"]));
    const sum = runCosts.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(Number(t["data-cost-usd"]) - sum) < 1e-9);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

/** Independent JSONL usage scan — not the board/trajectory loader — for true-home reconciliation. */
async function independentIssueUsage(ledgerDir: string, issueNumber: number): Promise<{
  runCount: number;
  reviewerRunCount: number;
  costUsd: number;
  totalTokens: number;
  reviewerCostUsd: number;
  reviewerTokens: number;
  axisWallMs: number;
}> {
  const runsDir = join(ledgerDir, "issues", String(issueNumber), "runs");
  let runIds: string[] = [];
  try {
    runIds = (await readdir(runsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        runCount: 0,
        reviewerRunCount: 0,
        costUsd: 0,
        totalTokens: 0,
        reviewerCostUsd: 0,
        reviewerTokens: 0,
        axisWallMs: 0,
      };
    }
    throw error;
  }

  const sumUsage = (rows: Record<string, unknown>[]): { cost: number; tokens: number } => {
    let cost = 0;
    let tokens = 0;
    for (const row of rows) {
      const message = row.message && typeof row.message === "object" ? (row.message as Record<string, unknown>) : undefined;
      const usageRaw =
        message && message.usage && typeof message.usage === "object"
          ? (message.usage as Record<string, unknown>)
          : row.usage && typeof row.usage === "object"
            ? (row.usage as Record<string, unknown>)
            : undefined;
      if (!usageRaw) continue;
      if (typeof usageRaw.totalTokens === "number" && Number.isFinite(usageRaw.totalTokens)) {
        tokens += usageRaw.totalTokens;
      }
      const costObj =
        usageRaw.cost && typeof usageRaw.cost === "object"
          ? (usageRaw.cost as Record<string, unknown>)
          : undefined;
      if (costObj && typeof costObj.total === "number" && Number.isFinite(costObj.total)) {
        cost += costObj.total;
      }
    }
    return { cost, tokens };
  };

  const readJsonl = async (path: string): Promise<Record<string, unknown>[]> => {
    const text = await readFile(path, "utf8");
    const out: Record<string, unknown>[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          out.push(parsed as Record<string, unknown>);
        }
      } catch {
        // Independent scan skips malformed lines the same way a human eyeball would continue.
      }
    }
    return out;
  };

  const spanWall = (rows: Record<string, unknown>[]): number => {
    const ts = rows
      .map((r) => r.timestamp)
      .filter((t): t is string => typeof t === "string" && t.length > 0);
    if (ts.length === 0) return 0;
    const start = Date.parse(ts[0]!);
    const end = Date.parse(ts[ts.length - 1]!);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
    return end - start;
  };

  let costUsd = 0;
  let totalTokens = 0;
  let reviewerRunCount = 0;
  let reviewerCostUsd = 0;
  let reviewerTokens = 0;
  let axisWallMs = 0;

  for (const runId of runIds) {
    const runDir = join(runsDir, runId);
    const sessionDir = join(runDir, "session");
    let parentFiles: string[] = [];
    try {
      parentFiles = (await readdir(sessionDir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
        .map((e) => join(sessionDir, e.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let axisFiles: string[] = [];
    try {
      const legsDir = join(sessionDir, "reviewer-legs");
      axisFiles = (await readdir(legsDir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
        .map((e) => join(legsDir, e.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    let runCost = 0;
    let runTokens = 0;
    let runAxisWall = 0;
    for (const f of parentFiles) {
      const u = sumUsage(await readJsonl(f));
      runCost += u.cost;
      runTokens += u.tokens;
    }
    for (const f of axisFiles) {
      const rows = await readJsonl(f);
      const u = sumUsage(rows);
      runCost += u.cost;
      runTokens += u.tokens;
      runAxisWall += spanWall(rows);
    }

    costUsd += runCost;
    totalTokens += runTokens;

    let role: string | undefined;
    try {
      const inv = JSON.parse(await readFile(join(runDir, "invocation.json"), "utf8")) as {
        role?: string;
      };
      if (typeof inv.role === "string") role = inv.role;
    } catch {
      // no invocation
    }
    const lower = runId.toLowerCase();
    const isReviewer =
      role === "reviewer" || lower.startsWith("review") || lower.startsWith("reviewer");
    if (isReviewer) {
      reviewerRunCount += 1;
      reviewerCostUsd += runCost;
      reviewerTokens += runTokens;
      axisWallMs += runAxisWall;
    }
  }

  return {
    runCount: runIds.length,
    reviewerRunCount,
    costUsd,
    totalTokens,
    reviewerCostUsd,
    reviewerTokens,
    axisWallMs,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Independent accepted-toolResult scan — uses package terminating-tool contracts only,
 * not the board/trajectory loader — so true-home #127 trajectory acceptance can reconcile
 * rendered result fields against ledger bytes without coupling to current-state selection.
 */
/**
 * Independent latest-run activity/mtime/acceptance probe for true-home active-leg
 * acceptance. Mirrors session-start ordering and content activity rules without
 * calling the board/trajectory loader (oracle must not share the code under test).
 */
async function independentLatestLegActivity(
  ledgerDir: string,
  issueNumber: number,
): Promise<{
  runId: string;
  startedAt?: string;
  lastActivityAt?: string;
  mtimeMs: number;
  hasAcceptedResult: boolean;
  acceptedResultStatus?: string;
} | undefined> {
  const runsDir = join(ledgerDir, "issues", String(issueNumber), "runs");
  let runIds: string[] = [];
  try {
    runIds = (await readdir(runsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (runIds.length === 0) return undefined;

  const readJsonl = async (path: string): Promise<Record<string, unknown>[]> => {
    const text = await readFile(path, "utf8");
    const out: Record<string, unknown>[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          out.push(parsed as Record<string, unknown>);
        }
      } catch {
        // Independent scan skips malformed lines.
      }
    }
    return out;
  };

  const listJsonl = async (dir: string): Promise<string[]> => {
    try {
      return (await readdir(dir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
        .map((e) => join(dir, e.name))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };

  const maxMtime = async (paths: readonly string[]): Promise<number> => {
    let max = 0;
    for (const path of paths) {
      try {
        const ms = (await lstat(path)).mtimeMs;
        if (Number.isFinite(ms) && ms > max) max = ms;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    return max;
  };

  type RunProbe = {
    runId: string;
    startedAt: string;
    lastActivityAt?: string;
    mtimeMs: number;
    hasAcceptedResult: boolean;
    acceptedResultStatus?: string;
  };
  const probes: RunProbe[] = [];

  for (const runId of runIds) {
    const sessionDir = join(runsDir, runId, "session");
    const parentFiles = await listJsonl(sessionDir);
    const axisFiles = await listJsonl(join(sessionDir, "reviewer-legs"));
    const parentRows: Record<string, unknown>[] = [];
    for (const f of parentFiles) parentRows.push(...(await readJsonl(f)));

    let startedAt: string | undefined;
    for (const row of parentRows) {
      if (row.type === "session" && typeof row.timestamp === "string") {
        startedAt = row.timestamp;
        break;
      }
      if (!startedAt && typeof row.timestamp === "string") startedAt = row.timestamp;
    }
    // Session-start order requires a start key; runs without timestamps sort last via "".
    const startKey = startedAt ?? "";

    let lastActivityAt: string | undefined;
    for (const row of parentRows) {
      if (typeof row.timestamp === "string" && row.timestamp) lastActivityAt = row.timestamp;
    }
    for (const f of axisFiles) {
      const legRows = await readJsonl(f);
      let legEnd: string | undefined;
      for (const row of legRows) {
        if (typeof row.timestamp === "string" && row.timestamp) legEnd = row.timestamp;
      }
      if (legEnd !== undefined && (lastActivityAt === undefined || legEnd > lastActivityAt)) {
        lastActivityAt = legEnd;
      }
    }

    let hasAcceptedResult = false;
    let acceptedResultStatus: string | undefined;
    for (const row of parentRows) {
      const message =
        row.message && typeof row.message === "object" && !Array.isArray(row.message)
          ? (row.message as Record<string, unknown>)
          : undefined;
      if (!message || message.role !== "toolResult") continue;
      if (typeof message.toolName !== "string" || !isTerminatingToolName(message.toolName)) continue;
      if (message.isError === true) continue;
      if (!message.details || typeof message.details !== "object" || Array.isArray(message.details)) {
        continue;
      }
      try {
        const details = validateAcceptedDetails(
          message.toolName as TerminatingToolName,
          message.details,
        );
        const facts = acceptedFacts(message.toolName as TerminatingToolName, details);
        hasAcceptedResult = true;
        acceptedResultStatus = facts.status ?? "";
      } catch (error) {
        if (error instanceof AcceptedDetailsContractError) continue;
        throw error;
      }
    }

    probes.push({
      runId,
      startedAt: startKey,
      ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
      mtimeMs: await maxMtime([...parentFiles, ...axisFiles]),
      hasAcceptedResult,
      ...(acceptedResultStatus !== undefined ? { acceptedResultStatus } : {}),
    });
  }

  probes.sort((a, b) => {
    if (a.startedAt !== b.startedAt) return a.startedAt.localeCompare(b.startedAt);
    return a.runId.localeCompare(b.runId);
  });
  const latest = probes.at(-1);
  if (!latest) return undefined;
  return {
    runId: latest.runId,
    ...(latest.startedAt ? { startedAt: latest.startedAt } : {}),
    ...(latest.lastActivityAt !== undefined ? { lastActivityAt: latest.lastActivityAt } : {}),
    mtimeMs: latest.mtimeMs,
    hasAcceptedResult: latest.hasAcceptedResult,
    ...(latest.acceptedResultStatus !== undefined
      ? { acceptedResultStatus: latest.acceptedResultStatus }
      : {}),
  };
}

/**
 * Discover any true-home issue whose latest run is still unaccepted.
 * Scans authentic home-ledger bytes only — no fixture plant, no mtime rewrite.
 * Returns undefined when every discovered latest run is accepted (or no runs).
 */
async function discoverTrueHomeUnacceptedActiveIssue(
  homeLedger: string,
): Promise<number | undefined> {
  const issuesDir = join(homeLedger, "issues");
  let issueNumbers: number[] = [];
  try {
    issueNumbers = (await readdir(issuesDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
      .map((e) => Number(e.name))
      .filter((n) => Number.isInteger(n) && n > 0)
      .sort((a, b) => a - b);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  // #127/#130 carry dedicated trajectory/cost assertions in the true-home suite;
  // do not double-book them as the flying sample even if their latest later flips.
  const reserved = new Set([127, 130]);
  for (const issueNumber of issueNumbers) {
    if (reserved.has(issueNumber)) continue;
    const leg = await independentLatestLegActivity(homeLedger, issueNumber);
    if (leg && !leg.hasAcceptedResult && leg.mtimeMs > 0) {
      return issueNumber;
    }
  }
  return undefined;
}

async function independentAcceptedTrajectory(
  ledgerDir: string,
  issueNumber: number,
): Promise<Array<{ runId: string; resultStatus: string }>> {
  const runsDir = join(ledgerDir, "issues", String(issueNumber), "runs");
  let runIds: string[] = [];
  try {
    runIds = (await readdir(runsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const accepted: Array<{ runId: string; resultStatus: string }> = [];
  for (const runId of runIds) {
    const sessionDir = join(runsDir, runId, "session");
    let files: string[] = [];
    try {
      files = (await readdir(sessionDir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
        .map((e) => join(sessionDir, e.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    let hasResult = false;
    let resultStatus = "";
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let row: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
          row = parsed as Record<string, unknown>;
        } catch {
          continue;
        }
        const message =
          row.message && typeof row.message === "object" && !Array.isArray(row.message)
            ? (row.message as Record<string, unknown>)
            : undefined;
        if (!message || message.role !== "toolResult") continue;
        if (typeof message.toolName !== "string" || !isTerminatingToolName(message.toolName)) {
          continue;
        }
        if (message.isError === true) continue;
        if (!message.details || typeof message.details !== "object" || Array.isArray(message.details)) {
          continue;
        }
        try {
          const details = validateAcceptedDetails(
            message.toolName as TerminatingToolName,
            message.details,
          );
          const facts = acceptedFacts(message.toolName as TerminatingToolName, details);
          hasResult = true;
          resultStatus = facts.status ?? "";
        } catch (error) {
          if (error instanceof AcceptedDetailsContractError) continue;
          throw error;
        }
      }
    }
    if (hasResult) accepted.push({ runId, resultStatus });
  }
  return accepted;
}

test("S3 true-home acceptance: #127 accepted trajectory, active leg, #130 cost reconciliation", async () => {
  const homeLedger =
    process.env.AK_FACTORY_BOARD_HOME_LEDGER?.trim() ||
    join(homedir(), ".ak-roles", "books", "ak-pi-workflow-roles");
  const home127 = join(homeLedger, "issues", "127");
  const home130 = join(homeLedger, "issues", "130");
  if (!(await pathExists(home130))) {
    // CI/agents without the owner true-home ledger skip; owner machine must run green.
    return;
  }

  const workspace = await mkdtemp(join(tmpdir(), "factory-board-s3-true-home-"));
  try {
    const ledgerDir = join(workspace, "ledger");

    // 1) Exact true-home #127 bytes — no fixture transplant, no tail deletion/substitution.
    // Accepted toolResult trajectory is asserted independently of whichever later run
    // currently controls current-state (frozen accepted-awaiting lives in its own test).
    assert.ok(
      await pathExists(home127),
      "true-home acceptance requires home #127 (authentic accepted-toolResult trajectory)",
    );
    await cp(home127, join(ledgerDir, "issues", "127"), {
      recursive: true,
      preserveTimestamps: true,
    });

    // 2) True-home #130 bytes (closed multi-round reviewer burn)
    await cp(home130, join(ledgerDir, "issues", "130"), {
      recursive: true,
      preserveTimestamps: true,
    });

    // 3) Genuine unaccepted active leg: discover any true-home issue whose *latest*
    // run is still unaccepted. Do not hard-pin a closed leg (#139 after judge-apply-008),
    // plant fixtures, or rewrite mtimes. When every true-home latest is accepted, skip
    // only the flying/active-leg assertions (honest N/A) and still green #127/#130.
    const activeIssue = await discoverTrueHomeUnacceptedActiveIssue(homeLedger);
    if (activeIssue !== undefined) {
      const homeActive = join(homeLedger, "issues", String(activeIssue));
      await cp(homeActive, join(ledgerDir, "issues", String(activeIssue)), {
        recursive: true,
        preserveTimestamps: true,
      });
    }

    // Plant zero-run #78 so native family edge is present for sort participation.
    await mkdir(join(ledgerDir, "issues", "78"), { recursive: true });

    const expected127 = await independentAcceptedTrajectory(ledgerDir, 127);
    assert.ok(
      expected127.length >= 1,
      "true-home #127 must contain at least one accepted terminating toolResult",
    );
    // Named authentic accepted receipt that exists on the owner true ledger.
    const namedFixer = expected127.find((r) => r.runId === "fixer-apply-001@ak-roles-127");
    assert.ok(namedFixer, "true-home #127 must keep named fixer-apply-001 accepted receipt");
    assert.equal(namedFixer.resultStatus, "completed");

    const expected130 = await independentIssueUsage(ledgerDir, 130);
    assert.ok(expected130.runCount >= 1, "#130 must have runs");
    assert.ok(expected130.reviewerRunCount >= 1, "#130 reviewer rounds present");

    // Independent true-home active-leg oracle (bytes + mtimes), not the board loader.
    // Present only when discovery found a genuinely unaccepted latest; otherwise N/A.
    const flyingOffsetMs = 30_000;
    assert.ok(
      flyingOffsetMs < UNACCEPTED_FLYING_MS,
      "probe offset must stay inside the flying band",
    );
    let now = new Date("2026-08-05T12:00:00.000Z");
    let activeLeg:
      | Awaited<ReturnType<typeof independentLatestLegActivity>>
      | undefined;
    let expectedDisplayActivityAt: string | undefined;
    let expectedLegAgeMs = 0;
    if (activeIssue !== undefined) {
      activeLeg = await independentLatestLegActivity(ledgerDir, activeIssue);
      assert.ok(activeLeg, `true-home #${activeIssue} must have at least one run`);
      assert.equal(
        activeLeg.hasAcceptedResult,
        false,
        `true-home #${activeIssue} latest ${activeLeg.runId} must be unaccepted (no accepted terminating toolResult)`,
      );
      assert.ok(
        activeLeg.mtimeMs > 0,
        `true-home #${activeIssue} latest ${activeLeg.runId} must expose session mtime`,
      );
      // Honest acceptance clock: freeze now just after preserved latest mtime so a genuinely
      // unaccepted true-home leg lands in the flying band (<2min) without utimes rewrite.
      now = new Date(activeLeg.mtimeMs + flyingOffsetMs);
      expectedDisplayActivityAt =
        activeLeg.lastActivityAt ??
        (activeLeg.mtimeMs > 0 ? new Date(activeLeg.mtimeMs).toISOString() : undefined);
      assert.ok(
        expectedDisplayActivityAt,
        `true-home #${activeIssue} latest must yield last-activity (content ts or mtime)`,
      );
      expectedLegAgeMs = activeLeg.startedAt
        ? Math.max(0, now.getTime() - Date.parse(activeLeg.startedAt))
        : Math.max(0, now.getTime() - activeLeg.mtimeMs);
    }

    const before = await treeFingerprint(ledgerDir);
    const books: FactoryBoardBook[] = [{ bookKey: "roles", ledgerDir }];
    const tickets = [
      ticket({ issueNumber: 78, title: "family parent", state: "open" as const }),
      ticket({
        issueNumber: 127,
        title: "127",
        state: "open" as const,
        parentIssueNumber: 78,
      }),
      ticket({
        issueNumber: 130,
        title: "130",
        state: "closed" as const,
        parentIssueNumber: 78,
        // Live GitHub closedAt for #130 — landing cycle ends here, not last ledger.
        closedAt: "2026-08-05T04:03:43Z",
      }),
      ...(activeIssue !== undefined
        ? [ticket({ issueNumber: activeIssue, title: "active", state: "open" as const })]
        : []),
    ];
    const view: FactoryBoardView = {
      ok: true,
      snapshot: {
        books: [
          {
            bookKey: "roles",
            owner: "Akagilnc",
            repo: "ak-pi-workflow-roles",
            tickets,
          },
        ],
      },
    };

    const outPath = join(workspace, "out", "board.html");
    const written = await writeFactoryBoardPage({ books, view, now, outputPath: outPath });
    const html = written.html;
    assert.equal(await treeFingerprint(ledgerDir), before, "true-home acceptance stays read-only");

    const t127 = elementsWith(html, "data-ticket").find((t) => t["data-ticket"] === "127");
    const t130 = elementsWith(html, "data-ticket").find((t) => t["data-ticket"] === "130");
    const family78 = elementsWith(html, "data-family").find((f) => f["data-parent"] === "78");
    assert.ok(t127 && t130 && family78);
    assert.equal(t130["data-parent-issue"], "78");
    assert.equal(t127["data-parent-issue"], "78");

    // #127 true trajectory: every independently accepted toolResult is rendered as accepted,
    // regardless of which later run owns data-current-state.
    const runs127 = elementsWith(html, "data-run-id").filter(
      (r) => (r["data-ledger-coord"] ?? "").includes("issues/127/runs/"),
    );
    assert.ok(runs127.length >= expected127.length, "board retains true-home #127 runs");
    for (const expected of expected127) {
      const row = runs127.find((r) => r["data-run-id"] === expected.runId);
      assert.ok(row, `true-home #127 accepted run visible: ${expected.runId}`);
      assert.equal(row["data-has-result"], "true", `${expected.runId} accepted toolResult`);
      assert.equal(
        row["data-result-status"],
        expected.resultStatus,
        `${expected.runId} status from accepted toolResult`,
      );
    }
    // Named anchor receipt stays projected even when later unaccepted/error runs control state.
    const namedOnBoard = runs127.find((r) => r["data-run-id"] === "fixer-apply-001@ak-roles-127");
    assert.equal(namedOnBoard?.["data-has-result"], "true");
    assert.equal(namedOnBoard?.["data-result-status"], "completed");
    assert.ok(
      t127["data-current-state"] === "accepted-awaiting" ||
        (t127["data-current-state"] ?? "").startsWith("unaccepted-"),
      "current state remains a mechanical latest-run partition; not asserted from fixture freeze",
    );

    // #130 totals reconcile with independent true-byte scan (human read-ledger oracle)
    assert.equal(Number(t130["data-run-count"]), expected130.runCount);
    assert.ok(Math.abs(Number(t130["data-cost-usd"]) - expected130.costUsd) < 1e-9);
    assert.equal(Number(t130["data-total-tokens"]), expected130.totalTokens);
    // Scope to #130 runs via ledger coord (run rows are nested <article>s, so ticket-level
    // HTML slicing on </article> is not a reliable station boundary).
    const runs130 = elementsWith(html, "data-run-id").filter(
      (r) => (r["data-ledger-coord"] ?? "").includes("issues/130/runs/"),
    );
    assert.equal(runs130.length, expected130.runCount);
    const reviewerRuns130 = runs130.filter((r) => r["data-station"] === "reviewer");
    assert.equal(reviewerRuns130.length, expected130.reviewerRunCount, "#130 御史台 multi-round runs");
    const boardReviewerCost = reviewerRuns130.reduce((s, r) => s + Number(r["data-cost-usd"]), 0);
    const boardReviewerTokens = reviewerRuns130.reduce(
      (s, r) => s + Number(r["data-total-tokens"]),
      0,
    );
    const boardReviewerAxisWall = reviewerRuns130.reduce(
      (s, r) => s + Number(r["data-axis-wall-ms"] ?? 0),
      0,
    );
    assert.ok(
      Math.abs(boardReviewerCost - expected130.reviewerCostUsd) < 1e-9,
      `#130 reviewer cost board=${boardReviewerCost} independent=${expected130.reviewerCostUsd}`,
    );
    assert.equal(boardReviewerTokens, expected130.reviewerTokens);
    assert.ok(Math.abs(boardReviewerAxisWall - expected130.axisWallMs) < 1);
    // Station block for reviewer must appear on the board (may share the page with other tickets).
    assert.ok(
      elementsWith(html, "data-station-block").some((s) => s["data-station-block"] === "reviewer"),
      "#130 御史台 station block rendered",
    );

    // Family aggregate burn includes #130; production page sort places the family by that burn
    const familyCost = Number(family78["data-cost-usd"]);
    assert.ok(familyCost + 1e-9 >= Number(t130["data-cost-usd"]));
    const sorted = executeProductionBoardSort(html, "roles", "cost-desc").map(laneSortIdentity);
    assert.ok(sorted.includes(78), "#78 family is a sort entry");
    // #130 is not a top-level lane entry (nested) but its burn moved the family key
    assert.ok(!sorted.includes(130), "#130 stays nested under family; burn rides aggregate");

    if (activeIssue === undefined || activeLeg === undefined) {
      // Honest N/A: no true-home latest remains unaccepted — skip flying assertions only.
      assert.ok(
        sorted.indexOf(78) < sorted.length,
        "#78 family carrying #130 still participates in page sort order",
      );
      return;
    }

    const tActive = elementsWith(html, "data-ticket").find(
      (t) => t["data-ticket"] === String(activeIssue),
    );
    assert.ok(tActive, `true-home active #${activeIssue} ticket rendered`);
    const activeCost = Number(tActive["data-cost-usd"]);
    assert.ok(sorted.includes(activeIssue), "active ticket remains a sort entry");
    if (familyCost > activeCost) {
      assert.equal(sorted[0], 78, "#78 family (with #130 burn) leads when it outburns active");
    } else {
      assert.ok(
        sorted.indexOf(78) < sorted.length,
        "#78 family carrying #130 still participates in page sort order",
      );
    }

    // Genuine unaccepted true-home leg: must be 在飞 under the honest acceptance clock,
    // with leg age + last activity *visibly* labeled (not article projection alone).
    assert.equal(
      tActive["data-current-state"],
      "unaccepted-flying",
      `true-home #${activeIssue} latest ${activeLeg.runId} must be 在飞 at honest now=${now.toISOString()} mtimeMs=${activeLeg.mtimeMs}`,
    );
    const visibleAge = visibleTicketLabel(html, "data-leg-age-label", activeIssue, "roles");
    const visibleAct = visibleTicketLabel(html, "data-last-activity-label", activeIssue, "roles");
    assert.ok(visibleAge, `true-home #${activeIssue} must render visible leg-age label`);
    assert.ok(visibleAct, `true-home #${activeIssue} must render visible last-activity label`);
    assert.equal(visibleAct["data-last-activity-at"], expectedDisplayActivityAt);
    assert.equal(visibleAct["data-last-activity-mtime-ms"], String(activeLeg.mtimeMs));
    assert.equal(Number(visibleAge["data-leg-age-ms"]), expectedLegAgeMs);
    assert.ok(Number(visibleAge["data-leg-age-ms"]) >= flyingOffsetMs);
    // Article projection remains consistent with the visible labels.
    assert.equal(tActive["data-last-activity-at"], visibleAct["data-last-activity-at"]);
    assert.equal(tActive["data-last-activity-mtime-ms"], visibleAct["data-last-activity-mtime-ms"]);
    assert.equal(tActive["data-leg-age-ms"], visibleAge["data-leg-age-ms"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("blockedBy connection paginates to completion and refuses silent truncation", async () => {
  const PAGE = 100; // must match transport page size
  const totalBlockers = PAGE + 5; // force a second page past the first-page boundary
  const firstPageNodes = Array.from({ length: PAGE }, (_, i) => ({
    number: 1000 + i,
    state: "OPEN",
  }));
  const secondPageNodes = Array.from({ length: totalBlockers - PAGE }, (_, i) => ({
    number: 1000 + PAGE + i,
    state: "OPEN",
  }));

  let openCalls = 0;
  let blockedPageCalls = 0;

  const runner: GhApiRunner = async (args) => {
    const queryArg = args.find((a, i) => args[i - 1] === "-f" && a.startsWith("query="));
    const query = queryArg?.slice("query=".length) ?? "";
    const afterArg = args.find((a, i) => args[i - 1] === "-f" && a.startsWith("after="));
    const after = afterArg?.slice("after=".length) ?? null;
    const numberArg = args.find((a, i) => args[i - 1] === "-F" && a.startsWith("number="));

    const ok = (data: unknown): GhApiResponse => ({
      status: 200,
      headers: {},
      bodyText: JSON.stringify({ data }),
    });

    // Follow-up blockedBy page query (has $number Int variable).
    if (query.includes("issue(number: $number)") && numberArg) {
      blockedPageCalls += 1;
      assert.equal(after, "cursor-page-1", "second blockedBy page uses endCursor");
      return ok({
        repository: {
          issue: {
            blockedBy: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: secondPageNodes,
            },
          },
        },
      });
    }

    // Open-issues list query.
    if (query.includes("issues(states: OPEN")) {
      openCalls += 1;
      return ok({
        repository: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                number: 42,
                title: "many blockers",
                state: "OPEN",
                closedAt: null,
                milestone: null,
                parent: null,
                blockedBy: {
                  pageInfo: { hasNextPage: true, endCursor: "cursor-page-1" },
                  nodes: firstPageNodes,
                },
              },
            ],
          },
        },
      });
    }

    throw new Error(`unexpected graphql query: ${query.slice(0, 120)}`);
  };

  const transport = createGhTicketSnapshotTransport(runner);
  const tickets = await transport.listBookTickets({
    owner: "acme",
    repo: "roles",
    closedIssueNumbers: [],
  });

  assert.equal(openCalls, 1);
  assert.equal(blockedPageCalls, 1, "must request the next blockedBy page");
  assert.equal(tickets.length, 1);
  const blocked = tickets[0]!.blockedBy;
  assert.equal(blocked.length, totalBlockers, "full blocker set, not first page only");
  assert.equal(blocked[0]?.issueNumber, 1000);
  assert.equal(blocked[blocked.length - 1]?.issueNumber, 1000 + totalBlockers - 1);

  // Missing pageInfo must fail loudly — never treat nodes as a complete set.
  const truncatedRunner: GhApiRunner = async () => ({
    status: 200,
    headers: {},
    bodyText: JSON.stringify({
      data: {
        repository: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                number: 7,
                title: "truncated",
                state: "OPEN",
                closedAt: null,
                milestone: null,
                parent: null,
                blockedBy: {
                  // no pageInfo — completeness cannot be established
                  nodes: [{ number: 1, state: "OPEN" }],
                },
              },
            ],
          },
        },
      },
    }),
  });
  await assert.rejects(
    () =>
      createGhTicketSnapshotTransport(truncatedRunner).listBookTickets({
        owner: "acme",
        repo: "roles",
        closedIssueNumbers: [],
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /pageInfo missing|completeness/i);
      return true;
    },
  );
});

test("snapshot adapter carries closedAt and refuses closed issues without it", async () => {
  const seenQueries: string[] = [];
  const runner: GhApiRunner = async (args) => {
    const queryArg = args.find((a, i) => args[i - 1] === "-f" && a.startsWith("query="));
    const query = queryArg?.slice("query=".length) ?? "";
    seenQueries.push(query);
    const ok = (data: unknown): GhApiResponse => ({
      status: 200,
      headers: {},
      bodyText: JSON.stringify({ data }),
    });

    if (query.includes("issues(states: OPEN")) {
      return ok({
        repository: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                number: 1,
                title: "open",
                state: "OPEN",
                closedAt: null,
                milestone: null,
                parent: null,
                blockedBy: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            ],
          },
        },
      });
    }

    if (query.includes("c0: issue(number: 2)")) {
      return ok({
        repository: {
          c0: {
            number: 2,
            title: "closed-ok",
            state: "CLOSED",
            closedAt: "2026-08-05T04:03:43Z",
            milestone: null,
            parent: null,
            blockedBy: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      });
    }

    throw new Error(`unexpected graphql query: ${query.slice(0, 120)}`);
  };

  const tickets = await createGhTicketSnapshotTransport(runner).listBookTickets({
    owner: "acme",
    repo: "roles",
    closedIssueNumbers: [2],
  });
  assert.ok(seenQueries.some((q) => /issues\(states: OPEN[\s\S]*closedAt/.test(q)));
  assert.ok(seenQueries.some((q) => /c0: issue\(number: 2\)[\s\S]*closedAt/.test(q)));
  assert.equal(tickets.find((t) => t.issueNumber === 1)?.closedAt, null);
  assert.equal(tickets.find((t) => t.issueNumber === 2)?.closedAt, "2026-08-05T04:03:43Z");

  const missingClosedAtRunner: GhApiRunner = async (args) => {
    const queryArg = args.find((a, i) => args[i - 1] === "-f" && a.startsWith("query="));
    const query = queryArg?.slice("query=".length) ?? "";
    if (query.includes("issues(states: OPEN")) {
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify({
          data: {
            repository: {
              issues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        }),
      };
    }
    if (query.includes("c0: issue(number: 9)")) {
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify({
          data: {
            repository: {
              c0: {
                number: 9,
                title: "closed-missing",
                state: "CLOSED",
                closedAt: null,
                milestone: null,
                parent: null,
                blockedBy: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            },
          },
        }),
      };
    }
    throw new Error(`unexpected graphql query: ${query.slice(0, 120)}`);
  };
  await assert.rejects(
    () =>
      createGhTicketSnapshotTransport(missingClosedAtRunner).listBookTickets({
        owner: "acme",
        repo: "roles",
        closedIssueNumbers: [9],
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /closedAt missing for closed issue/i);
      return true;
    },
  );
});

test("production factory-board lifecycle regenerates within refresh boundary and stops", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-refresh-"));
  try {
    const ledgerDir = join(workspace, "ledger");
    await writeRunSession(
      ledgerDir,
      10,
      "coder-first@x",
      [
        sessionHeader("2026-08-05T10:00:00.000Z"),
        ...acceptedCoderFinal("2026-08-05T10:01:00.000Z", 0.02, 20),
      ],
      { mtime: new Date("2026-08-05T10:01:00.000Z") },
    );

    const before = await treeFingerprint(ledgerDir);
    const outputPath = join(workspace, "out", "board.html");
    let nowMs = Date.parse("2026-08-05T16:00:00.000Z");
    const { scheduler, ticks } = manualBoardScheduler();
    const books: FactoryBoardBook[] = [{ bookKey: "roles", ledgerDir }];
    const view: FactoryBoardView = {
      ok: true,
      snapshot: {
        books: [
          {
            bookKey: "roles",
            owner: "acme",
            repo: "roles",
            tickets: [ticket({ issueNumber: 10, title: "live", state: "open" })],
          },
        ],
      },
    };

    const handle = startFactoryBoardPage({
      books,
      view,
      outputPath,
      refreshBoundarySeconds: 1,
      clock: () => new Date(nowMs),
      scheduler,
    });

    const first = await handle.started;
    assert.equal(first.outputPath, await realpath(outputPath));
    let html = await readFile(outputPath, "utf8");
    assert.equal(elementsWith(html, "data-lifecycle")[0]?.["data-lifecycle"], "refresh");
    assert.equal(
      elementsWith(html, "data-refresh-boundary-seconds")[0]?.["data-refresh-boundary-seconds"],
      "1",
    );
    assert.equal(
      elementsWith(html, "data-generated-at")[0]?.["data-generated-at"],
      "2026-08-05T16:00:00.000Z",
    );
    assert.equal(elementsWith(html, "data-run-id").length, 1);
    assert.equal(ticks.length, 1, "lifecycle arms a real scheduler tick");
    assert.equal(await treeFingerprint(ledgerDir), before, "initial render is read-only");

    // New run arrives in the ledger (test-owned mutation of the fixture copy).
    await writeRunSession(
      ledgerDir,
      10,
      "coder-second@x",
      [
        sessionHeader("2026-08-05T11:00:00.000Z"),
        ...acceptedCoderFinal("2026-08-05T11:02:00.000Z", 0.03, 30),
      ],
      { mtime: new Date("2026-08-05T11:02:00.000Z") },
    );
    const afterAdd = await treeFingerprint(ledgerDir);
    assert.notEqual(afterAdd, before);

    nowMs = Date.parse("2026-08-05T16:00:10.000Z");
    ticks[0]!();
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 20; i += 1) {
      html = await readFile(outputPath, "utf8");
      if (html.includes('data-generated-at="2026-08-05T16:00:10.000Z"')) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(
      elementsWith(html, "data-generated-at")[0]?.["data-generated-at"],
      "2026-08-05T16:00:10.000Z",
    );
    assert.ok(
      elementsWith(html, "data-run-id").some((r) => r["data-run-id"] === "coder-second@x"),
      "new run visible on the same factory-board surface within the declared bound",
    );
    assert.equal(elementsWith(html, "data-run-id").length, 2);
    assert.equal(
      await treeFingerprint(ledgerDir),
      afterAdd,
      "refresh regeneration must not mutate ledger bytes",
    );

    await handle.stop();
    assert.equal(ticks.length, 0, "stop cancels scheduler");
    const frozen = await readFile(outputPath, "utf8");
    const frozenAt = elementsWith(frozen, "data-generated-at")[0]?.["data-generated-at"];
    assert.equal(frozenAt, "2026-08-05T16:00:10.000Z");

    nowMs = Date.parse("2026-08-05T16:00:20.000Z");
    assert.equal(ticks.length, 0);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(await readFile(outputPath, "utf8"), frozen);
    assert.equal(await treeFingerprint(ledgerDir), afterAdd);

    assert.equal(DEFAULT_REFRESH_BOUNDARY_SECONDS, 30);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #162 kanban — yamen columns, escalate overlay, completed-column clusters
// ---------------------------------------------------------------------------

/** Minimal accepted judge terminating result (typed contract). */
function acceptedJudgeFinal(ts: string, verdict: unknown, costTotal = 0.01, totalTokens = 10): unknown[] {
  return [
    {
      type: "message",
      timestamp: ts,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "j1", name: "ak_judge_output", arguments: {} }],
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
        },
      },
    },
    {
      type: "message",
      timestamp: ts,
      message: {
        role: "toolResult",
        toolCallId: "j1",
        toolName: "ak_judge_output",
        isError: false,
        content: [],
        details: verdict,
      },
    },
  ];
}

/** Column container keys for one book, in document order (data-* only — no tag/nest coupling). */
function laneColumnOrder(html: string, bookKey: string): string[] {
  const order: string[] = [];
  for (const el of elementsWith(html, "data-column")) {
    if (el["data-book"] === bookKey && el["data-column"]) order.push(el["data-column"]);
  }
  return order;
}

/** Column-level entry identities (standalone ticket / family root / cluster), skipping nested cards. */
function columnEntryOrder(html: string, bookKey: string, columnKey: string): string[] {
  const out: string[] = [];
  // Walk open tags in document order; column-level entries carry data-placement and are not nested.
  for (const m of html.matchAll(/<[a-zA-Z][^>]*\bdata-placement="[^"]*"[^>]*>/g)) {
    const attrs = attrsFromOpenTag(m[0]!);
    if (attrs["data-book"] !== bookKey) continue;
    if (attrs["data-placement"] !== columnKey) continue;
    if (attrs["data-nested"] === "true") continue;
    if (attrs["data-family"] === "true") {
      out.push(attrs["data-parent"] ?? "?");
      continue;
    }
    if (attrs["data-family-cluster"] !== undefined) {
      out.push(attrs["data-family-cluster"]!);
      continue;
    }
    if (attrs["data-ticket"] !== undefined) {
      out.push(attrs["data-ticket"]!);
    }
  }
  return out;
}

function placementOf(html: string, bookKey: string, issueNumber: number): string | undefined {
  return elementsWith(html, "data-ticket").find(
    (t) => t["data-book"] === bookKey && t["data-ticket"] === String(issueNumber),
  )?.["data-placement"];
}

/** Breadcrumb steps for one ticket, ordered by data-breadcrumb-step. */
function breadcrumbStepsOf(html: string, issueNumber: number): Array<Record<string, string>> {
  const card = elementsWith(html, "data-ticket").find((t) => t["data-ticket"] === String(issueNumber));
  assert.ok(card, `ticket #${issueNumber}`);
  // Scope steps from this ticket marker until the next data-ticket marker.
  const marker = `data-ticket="${issueNumber}"`;
  const start = html.indexOf(marker);
  assert.ok(start >= 0, `ticket marker #${issueNumber}`);
  const after = html.slice(start);
  const next = after.slice(marker.length).search(/data-ticket="\d+"/);
  const scope = next >= 0 ? after.slice(0, marker.length + next) : after;
  const steps = elementsWith(scope, "data-breadcrumb-step");
  return steps.sort((a, b) => Number(a["data-breadcrumb-step"]) - Number(b["data-breadcrumb-step"]));
}

test("kanban placement totality: every ticket lands in its yamen column or the unknown set", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-kanban-place-"));
  try {
    const ledgerDir = join(workspace, "ledger");
    const now = new Date("2026-08-05T12:00:00.000Z");
    const nowMs = now.getTime();

    // #1 closed with an accepted coder run → 已完成
    await writeRunSession(
      ledgerDir, 1, "coder-done@x",
      [sessionHeader("2026-08-05T08:00:00.000Z"), ...acceptedCoderFinal("2026-08-05T08:05:00.000Z", 0.02, 20)],
      { mtime: new Date(nowMs - 14_400_000) },
    );
    // #2 open zero-run → 待发
    await mkdir(join(ledgerDir, "issues", "2"), { recursive: true });
    // #3 judge-only history, latest judge converged → 大理寺(审票)
    await writeRunSession(
      ledgerDir, 3, "plan-court-only@x",
      [sessionHeader("2026-08-05T09:00:00.000Z"), ...acceptedJudgeFinal("2026-08-05T09:05:00.000Z", { judgeStatus: "converged" }, 0.03, 30)],
      { mtime: new Date(nowMs - 10_200_000) },
    );
    // #4 coder first, then judge converged → 刑部(判卷)
    await writeRunSession(
      ledgerDir, 4, "coder-start@x",
      [sessionHeader("2026-08-05T08:00:00.000Z"), ...acceptedCoderFinal("2026-08-05T08:05:00.000Z", 0.01, 10)],
      { mtime: new Date(nowMs - 14_000_000) },
    );
    await writeRunSession(
      ledgerDir, 4, "judge-after-coder@x",
      [sessionHeader("2026-08-05T10:00:00.000Z"), ...acceptedJudgeFinal("2026-08-05T10:05:00.000Z", { judgeStatus: "converged" }, 0.04, 40)],
      { mtime: new Date(nowMs - 7_000_000) },
    );
    // #5 latest coder unaccepted flying (30s) → 将作监
    await writeRunSession(
      ledgerDir, 5, "coder-fly@x",
      [sessionHeader("2026-08-05T11:58:00.000Z"), assistantUsage("2026-08-05T11:58:30.000Z", 0.05, 50)],
      { invocationRole: "coder", mtime: new Date(nowMs - 30_000) },
    );
    // #13 latest coder unaccepted flying (60s) → 将作监, older activity sorts after #5
    await writeRunSession(
      ledgerDir, 13, "coder-fly-older@x",
      [sessionHeader("2026-08-05T11:57:00.000Z"), assistantUsage("2026-08-05T11:57:30.000Z", 0.06, 60)],
      { invocationRole: "coder", mtime: new Date(nowMs - 60_000) },
    );
    // #6 latest fixer accepted → 刑部
    await writeRunSession(
      ledgerDir, 6, "fixer-done@x",
      [
        sessionHeader("2026-08-05T10:30:00.000Z"),
        {
          type: "message",
          timestamp: "2026-08-05T11:00:00.000Z",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "f1", name: "ak_fixer_output", arguments: {} }],
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.07 } },
          },
        },
        {
          type: "message",
          timestamp: "2026-08-05T11:00:30.000Z",
          message: {
            role: "toolResult",
            toolCallId: "f1",
            toolName: "ak_fixer_output",
            isError: false,
            content: [],
            details: {
              status: "completed",
              report: "fixed",
              classResults: [
                { name: "c1", disposition: "completed", searchScope: "src", exceptions: [], commitSha: "abc123" },
              ],
            },
          },
        },
      ],
      { mtime: new Date(nowMs - 3_600_000) },
    );
    // #7 latest reviewer unaccepted watch → 刑部
    await writeRunSession(
      ledgerDir, 7, "review-watch@x",
      [sessionHeader("2026-08-05T11:40:00.000Z"), assistantUsage("2026-08-05T11:41:00.000Z", 0.08, 80)],
      { invocationRole: "reviewer", mtime: new Date(nowMs - 5 * 60_000) },
    );
    // #8 latest collector unaccepted → 门下省
    await writeRunSession(
      ledgerDir, 8, "collector-fly@x",
      [sessionHeader("2026-08-05T11:59:00.000Z"), assistantUsage("2026-08-05T11:59:20.000Z", 0.09, 90)],
      { invocationRole: "collector", mtime: new Date(nowMs - 20_000) },
    );
    // #10 latest auditor (non-resident station) → 非常驻列
    await writeRunSession(
      ledgerDir, 10, "audit-fly@x",
      [sessionHeader("2026-08-05T11:58:30.000Z"), assistantUsage("2026-08-05T11:58:50.000Z", 0.1, 100)],
      { invocationRole: "auditor", mtime: new Date(nowMs - 25_000) },
    );
    // #14 marshal-driven run → 刑部列 (ADR 0053; correlation seat pending, station already maps)
    await writeRunSession(
      ledgerDir, 14, "marshal-drive@x",
      [sessionHeader("2026-08-05T11:57:00.000Z"), assistantUsage("2026-08-05T11:57:30.000Z", 0.14, 140)],
      { invocationRole: "marshal", mtime: new Date(nowMs - 40_000) },
    );
    // #9 latest run without any session → unknown station → 未知集 (no column)
    await mkdir(join(ledgerDir, "issues", "9", "runs", "mystery@x"), { recursive: true });
    // #11 judge-only escalate → 大理寺(审票) with escalate overlay
    await writeRunSession(
      ledgerDir, 11, "court-escalate@x",
      [
        sessionHeader("2026-08-05T11:00:00.000Z"),
        ...acceptedJudgeFinal(
          "2026-08-05T11:50:00.000Z",
          { judgeStatus: "escalate", decisionGate: { question: "q", options: ["a", "b"] } },
          0.11, 110,
        ),
      ],
      { mtime: new Date(nowMs - 600_000) },
    );
    // #12 coder history then judge escalate → 刑部 with escalate overlay (原地换色不改归列)
    await writeRunSession(
      ledgerDir, 12, "coder-before@x",
      [sessionHeader("2026-08-05T08:30:00.000Z"), ...acceptedCoderFinal("2026-08-05T08:35:00.000Z", 0.01, 10)],
      { mtime: new Date(nowMs - 12_000_000) },
    );
    await writeRunSession(
      ledgerDir, 12, "judge-escalate-late@x",
      [
        sessionHeader("2026-08-05T11:10:00.000Z"),
        ...acceptedJudgeFinal(
          "2026-08-05T11:55:00.000Z",
          { judgeStatus: "escalate", decisionGate: { question: "q2", options: ["c", "d"] } },
          0.12, 120,
        ),
      ],
      { mtime: new Date(nowMs - 300_000) },
    );
    // #15 latest judge + only historical unknown → 大理寺(审票) (unknown 史不算开工证据)
    await writeRunSession(
      ledgerDir, 15, "mystery-hist@x",
      [sessionHeader("2026-08-05T08:10:00.000Z"), assistantUsage("2026-08-05T08:15:00.000Z", 0.01, 10)],
      { mtime: new Date(nowMs - 13_800_000) },
    );
    await writeRunSession(
      ledgerDir, 15, "judge-after-unknown@x",
      [sessionHeader("2026-08-05T10:20:00.000Z"), ...acceptedJudgeFinal("2026-08-05T10:25:00.000Z", { judgeStatus: "converged" }, 0.05, 50)],
      { mtime: new Date(nowMs - 5_700_000) },
    );
    // #16 latest unknown + historical known coder → 未知集 (latest unknown 不因历史改列)
    await writeRunSession(
      ledgerDir, 16, "coder-hist@x",
      [sessionHeader("2026-08-05T08:20:00.000Z"), ...acceptedCoderFinal("2026-08-05T08:25:00.000Z", 0.01, 10)],
      { mtime: new Date(nowMs - 12_900_000) },
    );
    await writeRunSession(
      ledgerDir, 16, "mystery-latest@x",
      [sessionHeader("2026-08-05T11:20:00.000Z"), assistantUsage("2026-08-05T11:21:00.000Z", 0.02, 20)],
      { mtime: new Date(nowMs - 2_400_000) },
    );
    // #17 retained closed + latest unknown → 已完成 (closed 优先于 unknown)
    await writeRunSession(
      ledgerDir, 17, "mystery-closed@x",
      [sessionHeader("2026-08-05T07:00:00.000Z"), assistantUsage("2026-08-05T07:05:00.000Z", 0.01, 10)],
      { mtime: new Date(nowMs - 18_000_000) },
    );

    const before = await treeFingerprint(ledgerDir);
    const html = await renderFactoryBoardHtml(
      [{ bookKey: "roles", ledgerDir }],
      {
        ok: true,
        snapshot: {
          books: [
            {
              bookKey: "roles",
              owner: "acme",
              repo: "roles",
              tickets: [
                ticket({ issueNumber: 1, title: "closed", state: "closed", closedAt: "2026-08-05T09:00:00.000Z" }),
                ticket({ issueNumber: 2, title: "pending", state: "open" }),
                ticket({ issueNumber: 3, title: "court-only", state: "open" }),
                ticket({ issueNumber: 4, title: "judge-after-coder", state: "open" }),
                ticket({ issueNumber: 5, title: "coder-fly", state: "open" }),
                ticket({ issueNumber: 6, title: "fixer-done", state: "open" }),
                ticket({ issueNumber: 7, title: "review-watch", state: "open" }),
                ticket({ issueNumber: 8, title: "collector-fly", state: "open" }),
                ticket({ issueNumber: 9, title: "mystery", state: "open" }),
                ticket({ issueNumber: 10, title: "audit-fly", state: "open" }),
                ticket({ issueNumber: 11, title: "court-escalate", state: "open" }),
                ticket({ issueNumber: 12, title: "marshal-escalate", state: "open" }),
                ticket({ issueNumber: 13, title: "coder-fly-older", state: "open" }),
                ticket({ issueNumber: 14, title: "marshal-drive", state: "open" }),
                ticket({ issueNumber: 15, title: "judge-after-unknown", state: "open" }),
                ticket({ issueNumber: 16, title: "unknown-after-coder", state: "open" }),
                ticket({
                  issueNumber: 17,
                  title: "closed-unknown",
                  state: "closed",
                  closedAt: "2026-08-05T08:00:00.000Z",
                }),
              ],
            },
          ],
        },
      },
      now,
    );
    assert.equal(await treeFingerprint(ledgerDir), before, "kanban render stays read-only");

    // Placement totality table (priority order: retained closed → pending → unknown →
    // judge double-position → known-station columns).
    assert.equal(placementOf(html, "roles", 1), "done");
    assert.equal(placementOf(html, "roles", 2), "pending");
    assert.equal(placementOf(html, "roles", 3), "court", "judge without identified non-judge history → 大理寺(审票)");
    assert.equal(placementOf(html, "roles", 4), "marshal", "latest judge + historical coder → 刑部(判卷)");
    assert.equal(placementOf(html, "roles", 5), "coder");
    assert.equal(placementOf(html, "roles", 6), "marshal", "fixer latest → 刑部");
    assert.equal(placementOf(html, "roles", 7), "marshal", "reviewer latest → 刑部");
    assert.equal(placementOf(html, "roles", 8), "collector");
    assert.equal(placementOf(html, "roles", 10), "other:auditor", "known non-resident station forms its own column");
    assert.equal(placementOf(html, "roles", 14), "marshal", "marshal-driven runs land in 刑部 (ADR 0053)");
    assert.equal(placementOf(html, "roles", 9), "unknown", "unknown latest station never forms a column");
    assert.equal(placementOf(html, "roles", 11), "court", "escalate overlay does not change placement (judge-only)");
    assert.equal(placementOf(html, "roles", 12), "marshal", "escalate overlay does not change placement (with coder history)");
    // 归列交叉 Red（#162 Testing Decisions）
    assert.equal(placementOf(html, "roles", 15), "court", "latest judge + only historical unknown → 大理寺(审票)");
    assert.equal(placementOf(html, "roles", 16), "unknown", "latest unknown + historical known → 未知集");
    assert.equal(placementOf(html, "roles", 17), "done", "retained closed + latest unknown → 已完成 (closed 优先)");

    // Escalate overlay: state value distinct, placement unchanged.
    const t11 = elementsWith(html, "data-ticket").find((t) => t["data-ticket"] === "11");
    const t12 = elementsWith(html, "data-ticket").find((t) => t["data-ticket"] === "12");
    assert.equal(t11?.["data-current-state"], "escalate-awaiting");
    assert.equal(t12?.["data-current-state"], "escalate-awaiting");
    // Non-escalate accepted tickets keep accepted-awaiting.
    const t3 = elementsWith(html, "data-ticket").find((t) => t["data-ticket"] === "3");
    assert.equal(t3?.["data-current-state"], "accepted-awaiting");

    // Six resident columns always present; non-resident only when occupied, before 已完成.
    assert.deepEqual(laneColumnOrder(html, "roles"), [
      "pending",
      "court",
      "coder",
      "marshal",
      "collector",
      "other:auditor",
      "done",
    ]);
    // Empty resident columns still render with mechanical zero count.
    const columns = elementsWith(html, "data-column").filter((c) => c["data-book"] === "roles");
    // Every resident key is present (this fixture fills them all except none empty here).
    for (const key of ["pending", "court", "coder", "marshal", "collector", "done"]) {
      assert.ok(columns.some((c) => c["data-column"] === key), `resident column ${key} always present`);
    }

    // Column-internal order: 在飞 → 观察 → 疑挂 → 已交卷(escalate 同档), 同档末次活动降序.
    assert.deepEqual(columnEntryOrder(html, "roles", "coder"), ["5", "13"], "flying coder tickets: newest activity first");
    assert.deepEqual(
      columnEntryOrder(html, "roles", "marshal"),
      ["14", "7", "12", "6", "4"],
      "flying band first (marshal drive), then watch; awaiting/escalate share a band by last activity desc",
    );

    // Unknown set: badge count + item, and the card is reachable from the unknown container.
    const badge = elementsWith(html, "data-unknown-badge")[0];
    assert.ok(badge, "unknown badge present");
    assert.equal(badge["data-unknown-count"], "2");
    assert.ok(
      elementsWith(html, "data-unknown-item").some(
        (el) => el["data-unknown-item"] === "9" && el["data-book"] === "roles",
      ),
      "unknown badge expands to the same mechanical set",
    );
    assert.ok(
      elementsWith(html, "data-unknown-item").some(
        (el) => el["data-unknown-item"] === "16" && el["data-book"] === "roles",
      ),
      "latest-unknown-with-known-history stays in the unknown set",
    );
    const unknownSet = elementsWith(html, "data-unknown-set")[0];
    assert.ok(unknownSet, "unknown container present in the lane");
    // Unknown cards are not inside any column container.
    for (const col of laneColumnOrder(html, "roles")) {
      assert.ok(!columnEntryOrder(html, "roles", col).includes("9"), `#9 must not sit in column ${col}`);
      assert.ok(!columnEntryOrder(html, "roles", col).includes("16"), `#16 must not sit in column ${col}`);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("kanban completed column: family clusters, open-root extraction, closedAt-desc order", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-kanban-done-"));
  try {
    const ledgerDir = join(workspace, "ledger");
    const now = new Date("2026-08-05T12:00:00.000Z");

    // Open-root family: #20 root (zero-run), #21 open coder child, #22 closed child.
    await mkdir(join(ledgerDir, "issues", "20"), { recursive: true });
    await writeRunSession(
      ledgerDir, 21, "coder-child@x",
      [sessionHeader("2026-08-05T09:00:00.000Z"), ...acceptedCoderFinal("2026-08-05T09:05:00.000Z", 0.5, 500)],
      { mtime: new Date(now.getTime() - 10_800_000) },
    );
    await writeRunSession(
      ledgerDir, 22, "coder-closed-child@x",
      [sessionHeader("2026-08-04T09:00:00.000Z"), ...acceptedCoderFinal("2026-08-04T09:05:00.000Z", 2.0, 2000)],
      { mtime: new Date(now.getTime() - 86_400_000) },
    );
    // Closed-root family: #30 root + #31 child, both closed (zero-run closed is lawful).
    await mkdir(join(ledgerDir, "issues", "30"), { recursive: true });
    await mkdir(join(ledgerDir, "issues", "31"), { recursive: true });
    // #40 closed single.
    await mkdir(join(ledgerDir, "issues", "40"), { recursive: true });

    const html = await renderFactoryBoardHtml(
      [{ bookKey: "roles", ledgerDir }],
      {
        ok: true,
        snapshot: {
          books: [
            {
              bookKey: "roles",
              owner: "acme",
              repo: "roles",
              tickets: [
                ticket({ issueNumber: 20, title: "open root", state: "open" }),
                ticket({ issueNumber: 21, title: "open child", state: "open", parentIssueNumber: 20 }),
                ticket({
                  issueNumber: 22,
                  title: "closed child",
                  state: "closed",
                  parentIssueNumber: 20,
                  closedAt: "2026-08-05T11:00:00.000Z",
                }),
                ticket({ issueNumber: 30, title: "closed root", state: "closed", closedAt: "2026-08-05T10:00:00.000Z" }),
                ticket({
                  issueNumber: 31,
                  title: "closed child of closed root",
                  state: "closed",
                  parentIssueNumber: 30,
                  closedAt: "2026-08-05T09:00:00.000Z",
                }),
                ticket({ issueNumber: 40, title: "closed single", state: "closed", closedAt: "2026-08-05T08:00:00.000Z" }),
              ],
            },
          ],
        },
      },
      now,
    );

    // Open-root family section sits by the ROOT's placement (待发), aggregates all descendants.
    const family20 = elementsWith(html, "data-family").find((f) => f["data-parent"] === "20");
    assert.ok(family20);
    assert.equal(family20["data-placement"], "pending");
    assert.equal(family20["data-child-count"], "2");
    assert.equal(family20["data-closed-count"], "1");
    assert.equal(Number(family20["data-cost-usd"]), 2.5, "family aggregate still covers open + closed descendants");

    // Open child #21 is an independent card placed by its own latest run (not nested).
    assert.equal(placementOf(html, "roles", 21), "coder");
    const t21 = elementsWith(html, "data-ticket").find((t) => t["data-ticket"] === "21");
    assert.ok(t21);
    assert.notEqual(t21["data-nested"], "true", "open child card is independent, not nested");

    // Closed child #22 is extracted to the 已完成 cluster of its family (父开子关 → 族簇嵌套).
    assert.equal(placementOf(html, "roles", 22), "done");
    const cluster = elementsWith(html, "data-family-cluster").find((c) => c["data-family-cluster"] === "20");
    assert.ok(cluster, "completed family cluster for open-root family");
    const t22 = elementsWith(html, "data-ticket").find((t) => t["data-ticket"] === "22");
    assert.ok(t22);
    assert.equal(t22["data-nested"], "true", "cluster child is mechanically nested");
    assert.equal(t22["data-parent-issue"], "20", "extracted cluster child keeps its native parent edge");

    // Closed-root family travels whole into 已完成 (父卡置顶、子卡缩进嵌套).
    const family30 = elementsWith(html, "data-family").find((f) => f["data-parent"] === "30");
    assert.ok(family30);
    assert.equal(family30["data-placement"], "done");
    const t31 = elementsWith(html, "data-ticket").find((t) => t["data-ticket"] === "31");
    assert.ok(t31, "closed-root family nests its closed child");
    assert.equal(t31["data-nested"], "true", "closed-root child stays nested");
    assert.equal(t31["data-parent-issue"], "30");

    // 已完成 column order: closedAt desc (cluster 11:00 → family30 10:00 → single 08:00).
    assert.deepEqual(columnEntryOrder(html, "roles", "done"), ["20", "30", "40"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #162 retention — merge+24h window, family shared parent clock, drill residency
// ---------------------------------------------------------------------------

const RETENTION_NOW = "2026-08-06T12:00:00.000Z";

type RetentionScenario = {
  openNodes: unknown[];
  closedPages: Array<{ nodes: unknown[]; hasNextPage: boolean; endCursor: string | null }>;
  drillNodes?: Record<number, unknown>;
};

function closedNode(number: number, closedAt: string, parent: number | null): unknown {
  return {
    number,
    title: `closed-${number}`,
    state: "CLOSED",
    closedAt,
    milestone: null,
    parent: parent === null ? null : { number: parent },
    blockedBy: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
  };
}

function retentionRunner(scenario: RetentionScenario, counters?: { closedDrainCalls: number }): GhApiRunner {
  return async (args) => {
    const queryArg = args.find((a, i) => args[i - 1] === "-f" && a.startsWith("query="));
    const query = queryArg?.slice("query=".length) ?? "";
    const afterArg = args.find((a, i) => args[i - 1] === "-f" && a.startsWith("after="));
    const after = afterArg ? afterArg.slice("after=".length) : null;
    const ok = (data: unknown): GhApiResponse => ({
      status: 200,
      headers: {},
      bodyText: JSON.stringify({ data }),
    });

    if (query.includes("issues(states: OPEN")) {
      return ok({
        repository: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: scenario.openNodes,
          },
        },
      });
    }
    if (query.includes("issues(states: CLOSED")) {
      if (counters) counters.closedDrainCalls += 1;
      const pageIndex = after === "cursor-closed-1" ? 1 : 0;
      const page = scenario.closedPages[pageIndex];
      if (!page) throw new Error(`unexpected closed drain page (after=${after})`);
      return ok({
        repository: {
          issues: {
            pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
            nodes: page.nodes,
          },
        },
      });
    }
    const drillMatch = query.match(/c0: issue\(number: (\d+)\)/);
    if (drillMatch && scenario.drillNodes) {
      const node = scenario.drillNodes[Number(drillMatch[1])];
      if (!node) throw new Error(`unexpected drill ${drillMatch[1]}`);
      return ok({ repository: { c0: node } });
    }
    throw new Error(`unexpected graphql query: ${query.slice(0, 120)}`);
  };
}

test("retention drain refuses silent truncation and validates the injected clock", async () => {
  const truncated: GhApiRunner = async (args) => {
    const queryArg = args.find((a, i) => args[i - 1] === "-f" && a.startsWith("query="));
    const query = queryArg?.slice("query=".length) ?? "";
    const ok = (data: unknown): GhApiResponse => ({
      status: 200,
      headers: {},
      bodyText: JSON.stringify({ data }),
    });
    if (query.includes("issues(states: OPEN")) {
      return ok({ repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } });
    }
    if (query.includes("issues(states: CLOSED")) {
      return ok({
        repository: {
          issues: {
            // no pageInfo — completeness cannot be established
            nodes: [closedNode(60, "2026-08-06T11:00:00.000Z", null)],
          },
        },
      });
    }
    throw new Error(`unexpected graphql query: ${query.slice(0, 120)}`);
  };
  await assert.rejects(
    () =>
      createGhTicketSnapshotTransport(truncated).listBookTickets({
        owner: "acme",
        repo: "roles",
        closedIssueNumbers: [],
        retentionNow: new Date(RETENTION_NOW),
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /pageInfo missing|completeness/i);
      return true;
    },
  );

  const passthrough = retentionRunner({ openNodes: [], closedPages: [{ nodes: [], hasNextPage: false, endCursor: null }] });
  await assert.rejects(
    () =>
      createGhTicketSnapshotTransport(passthrough).listBookTickets({
        owner: "acme",
        repo: "roles",
        closedIssueNumbers: [],
        retentionNow: new Date("not-a-date"),
      }),
    /retentionNow/i,
  );
});

test("fetchBoardSnapshot passes retentionNow through only when supplied", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const transport: TicketSnapshotTransport = {
    async listBookTickets(input) {
      calls.push({ ...input });
      return [];
    },
  };
  await fetchBoardSnapshot({
    bindings: [{ bookKey: "roles", owner: "acme", repo: "roles" }],
    transport,
  });
  assert.deepEqual(calls[0], { owner: "acme", repo: "roles", closedIssueNumbers: [] });

  await fetchBoardSnapshot({
    bindings: [{ bookKey: "roles", owner: "acme", repo: "roles" }],
    retentionNow: new Date(RETENTION_NOW),
    transport,
  });
  assert.equal((calls[1]?.["retentionNow"] as Date | undefined)?.toISOString(), RETENTION_NOW);
});

/**
 * #162 retention Red through the production path only:
 * createGhTicketSnapshotTransport → fetchBoardSnapshot → startFactoryBoardPage.loadView
 * (tick by tick) → HTML. Never hand-return a snapshot that already contains closed tickets.
 */
test("retention tracer: transport→fetch→watch loadView→HTML (window, family clock, drill)", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-retention-tracer-"));
  try {
    const ledgerDir = join(workspace, "ledger");
    // Zero-run issue dirs so the render seam can join every retained ticket.
    for (const n of [10, 11, 20, 21, 30, 31, 40, 41, 50]) {
      await mkdir(join(ledgerDir, "issues", String(n)), { recursive: true });
    }
    const before = await treeFingerprint(ledgerDir);
    const outputPath = join(workspace, "out", "board.html");
    let nowMs = Date.parse(RETENTION_NOW);
    const { scheduler, ticks } = manualBoardScheduler();
    const books: FactoryBoardBook[] = [{ bookKey: "roles", ledgerDir }];

    const counters = { closedDrainCalls: 0 };
    const runner = retentionRunner(
      {
        openNodes: [
          {
            number: 10,
            title: "open-root",
            state: "OPEN",
            closedAt: null,
            milestone: null,
            parent: null,
            blockedBy: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          },
        ],
        closedPages: [
          {
            nodes: [
              // A: child closed 48h ago under open root → 陪跑 retained
              closedNode(11, "2026-08-04T12:00:00.000Z", 10),
              // B: root closed 25h ago; child closed 1h ago → family exits by root clock
              closedNode(20, "2026-08-05T11:00:00.000Z", null),
              closedNode(21, "2026-08-06T11:00:00.000Z", 20),
              // C: root closed 1h ago; child closed 25h ago → whole family retained
              closedNode(30, "2026-08-06T11:00:00.000Z", null),
            ],
            hasNextPage: true,
            endCursor: "cursor-closed-1",
          },
          {
            nodes: [
              closedNode(31, "2026-08-05T11:00:00.000Z", 30),
              // boundary: exactly closedAt+24h == now → expired
              closedNode(40, "2026-08-05T12:00:00.000Z", null),
              // boundary +1ms → retained at RETENTION_NOW; exits on the next tick
              closedNode(41, "2026-08-05T12:00:00.001Z", null),
              // drill candidate: clock-expired but named → fetched via closedIssueNumbers
              closedNode(50, "2026-08-03T12:00:00.000Z", null),
            ],
            hasNextPage: false,
            endCursor: null,
          },
        ],
        drillNodes: { 50: closedNode(50, "2026-08-03T12:00:00.000Z", null) },
      },
      counters,
    );
    const transport = createGhTicketSnapshotTransport(runner);

    let loadCalls = 0;
    const handle = startFactoryBoardPage({
      books,
      loadView: async () => {
        loadCalls += 1;
        // Production CLI shape: adapter + retentionNow clock, never a hand-built closed snapshot.
        const snapshot = await fetchBoardSnapshot({
          bindings: [{ bookKey: "roles", owner: "acme", repo: "roles" }],
          closedIssueNumbersByBook: { roles: [50] },
          retentionNow: new Date(nowMs),
          transport,
        });
        return { ok: true, snapshot };
      },
      outputPath,
      refreshBoundarySeconds: 1,
      clock: () => new Date(nowMs),
      scheduler,
    });

    const first = await handle.started;
    assert.equal(first.outputPath, await realpath(outputPath));
    let html = await readFile(outputPath, "utf8");
    assert.equal(loadCalls, 1, "loadView supplies the startup snapshot too (not fixed at start)");
    assert.ok(counters.closedDrainCalls >= 2, "closed drain paginates to completion on the production path");

    const present = () =>
      new Set(
        elementsWith(html, "data-ticket")
          .filter((t) => t["data-book"] === "roles")
          .map((t) => Number(t["data-ticket"])),
      );
    let onBoard = present();
    assert.deepEqual(
      [...onBoard].sort((a, b) => a - b),
      [10, 11, 30, 31, 41, 50],
      "HTML shows open + retained + drill only",
    );
    assert.ok(!onBoard.has(20) && !onBoard.has(21), "family exits together by the root closedAt clock");
    assert.ok(!onBoard.has(40), "exactly closedAt+24h is expired");
    assert.ok(onBoard.has(41), "just-inside 24h window is retained on the board");
    assert.ok(onBoard.has(11), "closed child 陪跑 under open parent");
    assert.equal(placementOf(html, "roles", 11), "done", "陪跑 closed child lands in 已完成 cluster");
    assert.equal(
      elementsWith(html, "data-ticket").find((t) => t["data-ticket"] === "11")?.["data-parent-issue"],
      "10",
      "family edge facts survive outside the OPEN query onto the page",
    );
    const family10 = elementsWith(html, "data-family").find((f) => f["data-parent"] === "10");
    assert.ok(family10, "open root family section is on the board");
    assert.equal(family10["data-placement"], "pending", "open root places the family by its own facts");
    assert.ok(onBoard.has(31), "old child rides the family clock while the root stays in window");
    const family30 = elementsWith(html, "data-family").find((f) => f["data-parent"] === "30");
    assert.ok(family30, "closed-root family travels whole into 已完成");
    assert.equal(family30["data-placement"], "done");
    assert.equal(placementOf(html, "roles", 31), "done");
    assert.ok(onBoard.has(50), "named closed drill is resident regardless of the window");
    assert.equal(placementOf(html, "roles", 50), "done");
    assert.equal(placementOf(html, "roles", 41), "done", "just-closed retained ticket lands in 已完成");

    // Next tick: advance past #41's closedAt+24h so the same transport path drops it.
    nowMs = Date.parse("2026-08-06T12:00:00.002Z");
    ticks[0]!();
    for (let i = 0; i < 25; i += 1) {
      html = await readFile(outputPath, "utf8");
      if (loadCalls >= 2 && html.includes('data-generated-at="2026-08-06T12:00:00.002Z"')) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(loadCalls >= 2, "each tick re-loads the snapshot through the adapter");
    assert.equal(
      elementsWith(html, "data-generated-at")[0]?.["data-generated-at"],
      "2026-08-06T12:00:00.002Z",
    );
    onBoard = present();
    assert.ok(!onBoard.has(41), "24h exit is observed on the next watch tick");
    assert.deepEqual(
      [...onBoard].sort((a, b) => a - b),
      [10, 11, 30, 31, 50],
      "remaining retained + drill set after the window tick",
    );
    assert.ok(onBoard.has(11), "open-parent 陪跑 survives the tick");
    assert.ok(onBoard.has(50), "named drill stays across ticks");
    assert.equal(await treeFingerprint(ledgerDir), before, "retention watch path stays read-only");

    await handle.stop();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("watch lifecycle faults loadView failures and requires view or loadView", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-watch-fault-"));
  try {
    const ledgerDir = join(workspace, "ledger");
    await mkdir(join(ledgerDir, "issues", "1"), { recursive: true });
    const books: FactoryBoardBook[] = [{ bookKey: "roles", ledgerDir }];
    const nowMs = Date.parse("2026-08-05T16:00:00.000Z");

    const failing = startFactoryBoardPage({
      books,
      loadView: async () => {
        throw new Error("snapshot source exploded");
      },
      outputPath: join(workspace, "out", "board2.html"),
      refreshBoundarySeconds: 1,
      clock: () => new Date(nowMs),
      scheduler: manualBoardScheduler().scheduler,
    });
    await assert.rejects(failing.started, /snapshot source exploded/);
    await assert.rejects(() => failing.stop(), /snapshot source exploded/);

    assert.throws(
      () =>
        startFactoryBoardPage({
          books,
          outputPath: join(workspace, "out", "board3.html"),
          refreshBoundarySeconds: 1,
        }),
      /view or loadView/i,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("kanban authentic-cut fixtures #45/#78/#104/#140/#127: placements, unknown set, read-only", async () => {
  const kanbanFixtureLedger = join(packageRoot, "test/fixtures/factory-board-kanban/ledger");
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-kanban-fixture-"));
  try {
    const ledgerDir = join(workspace, "ledger");
    await cp(kanbanFixtureLedger, ledgerDir, { recursive: true });
    // #127's authentic cut already lives in the S1 fixture tree — compose, don't duplicate.
    await cp(
      join(fixtureLedger, "issues", "127"),
      join(ledgerDir, "issues", "127"),
      { recursive: true },
    );

    const before = await treeFingerprint(ledgerDir);
    const now = new Date("2026-08-06T12:00:00.000Z");
    const html = await renderFactoryBoardHtml(
      [{ bookKey: "roles", ledgerDir }],
      {
        ok: true,
        snapshot: {
          books: [
            {
              bookKey: "roles",
              owner: "acme",
              repo: "roles",
              tickets: [
                ticket({ issueNumber: 45, title: "final authority judge", state: "open" }),
                ticket({ issueNumber: 78, title: "court-only parent", state: "open" }),
                ticket({ issueNumber: 104, title: "judge after construction", state: "open" }),
                ticket({ issueNumber: 127, title: "hot child", state: "open", parentIssueNumber: 78 }),
                ticket({ issueNumber: 140, title: "marshal design court", state: "open" }),
              ],
            },
          ],
        },
      },
      now,
    );
    assert.equal(await treeFingerprint(ledgerDir), before, "authentic-cut fixture render is read-only");

    // #45 — run without any session bytes → unknown station → 未知集 (badge, no column).
    assert.equal(placementOf(html, "roles", 45), "unknown");
    assert.equal(elementsWith(html, "data-unknown-badge")[0]?.["data-unknown-count"], "1");
    assert.ok(
      elementsWith(html, "data-unknown-item").some(
        (el) => el["data-unknown-item"] === "45" && el["data-book"] === "roles",
      ),
    );

    // #78 — judge-only authentic history → 大理寺(审票); escalate in history does not
    // flip the latest converged state (escalate overlay belongs to the latest run only).
    const family78 = elementsWith(html, "data-family").find((f) => f["data-parent"] === "78");
    assert.ok(family78);
    assert.equal(family78["data-placement"], "court");
    assert.equal(family78["data-child-count"], "1");
    const t78 = elementsWith(html, "data-ticket").find((t) => t["data-ticket"] === "78");
    assert.equal(t78?.["data-current-state"], "accepted-awaiting");
    const escalatedHistorical = elementsWith(html, "data-run-id").find(
      (r) => r["data-run-id"] === "design-court-r2@ak-pi-workflow-roles",
    );
    assert.equal(escalatedHistorical?.["data-result-status"], "escalate", "authentic escalate receipt stays visible in history");

    // #104 — latest judge with coder/fixer/reviewer history → 刑部(判卷).
    assert.equal(placementOf(html, "roles", 104), "marshal");
    const t104 = elementsWith(html, "data-ticket").find((t) => t["data-ticket"] === "104");
    assert.equal(t104?.["data-current-state"], "accepted-awaiting");

    // #140 — single judge court run → 大理寺(审票).
    assert.equal(placementOf(html, "roles", 140), "court");

    // #127 — open child rides its own latest run (reviewer) → 刑部, independent card
    // with the native family edge + 族徽章, not nested inside the family section.
    assert.equal(placementOf(html, "roles", 127), "marshal");
    const t127 = elementsWith(html, "data-ticket").find((t) => t["data-ticket"] === "127");
    assert.equal(t127?.["data-parent-issue"], "78");
    assert.notEqual(t127?.["data-nested"], "true", "open child card is not nested");
    assert.ok(
      elementsWith(html, "data-family-badge").some(
        (b) => b["data-family-badge"] === "78" && b["data-book"] === "roles",
      ),
      "family badge marks independent child cards",
    );

    // Six resident columns always; no unknown column; court and marshal occupied.
    assert.deepEqual(laneColumnOrder(html, "roles"), [
      "pending",
      "court",
      "coder",
      "marshal",
      "collector",
      "done",
    ]);
    const colByKey = new Map(
      elementsWith(html, "data-column")
        .filter((c) => c["data-book"] === "roles")
        .map((c) => [c["data-column"], c["data-column-count"]]),
    );
    assert.equal(colByKey.get("pending"), "0");
    assert.equal(colByKey.get("coder"), "0");
    assert.equal(colByKey.get("collector"), "0");
    assert.equal(colByKey.get("done"), "0");
    assert.ok(Number(colByKey.get("court")) >= 1);
    assert.ok(Number(colByKey.get("marshal")) >= 1);
    // Marshal column-internal: 在飞/观察/疑挂 band floats above 已交卷.
    const marshalOrder = columnEntryOrder(html, "roles", "marshal");
    assert.ok(marshalOrder.includes("104") && marshalOrder.includes("127"));
    const t127State = t127?.["data-current-state"] ?? "";
    if (t127State.startsWith("unaccepted-")) {
      assert.ok(
        marshalOrder.indexOf("127") < marshalOrder.indexOf("104"),
        "unaccepted #127 floats above accepted #104 in 刑部",
      );
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #162 fake-DOM — production page script via the singular BoardSortElement harness
// ---------------------------------------------------------------------------

function pageEl(attrs: Record<string, string>, ...children: BoardSortElement[]): BoardSortElement {
  const el = new BoardSortElement(attrs);
  for (const child of children) el.appendChild(child);
  return el;
}

/** Production page script body extracted from the rendered board HTML. */
function productionPageScriptBody(html: string): string {
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch?.[1], "production board must embed the page script");
  return scriptMatch[1]!;
}

type KanbanFakePage = {
  document: BoardSortDocument;
  sortSel: BoardSortElement;
  projectSel: BoardSortElement;
  familySel: BoardSortElement;
  badge: BoardSortElement;
  badgeSummary: BoardSortElement;
  lanes: Record<string, BoardSortElement>;
  columns: Record<string, BoardSortElement>;
};

/**
 * Fake page mirroring the production structure: two books, family 78 with open
 * child 127 (marshal) under a court family section, lone 104, pending 2,
 * unknown 9 (roles) and unknown 26 (orch).
 */
function buildKanbanFakePage(scriptBody: string): KanbanFakePage {
  const document = new BoardSortDocument();

  const sortSel = new BoardSortElement({ "data-sort-control": "true" });
  sortSel.value = "ticket-asc";
  const projectSel = new BoardSortElement({ "data-project-filter": "true" });
  projectSel.value = "roles";
  const familySel = new BoardSortElement({ "data-family-filter": "true" });
  familySel.appendChild(Object.assign(new BoardSortElement(), { value: "all" }));
  familySel.value = "all";
  const badgeSummary = new BoardSortElement({ "data-unknown-badge-summary": "true" });
  const unknownItem9 = new BoardSortElement({ "data-unknown-item": "9", "data-book": "roles" });
  const unknownItem26 = new BoardSortElement({ "data-unknown-item": "26", "data-book": "orch" });
  const badge = pageEl(
    { "data-unknown-badge": "true", "data-unknown-count": "1" },
    badgeSummary,
    pageEl({}, unknownItem9, unknownItem26),
  );

  const article2 = new BoardSortElement({
    "data-ticket": "2",
    "data-book": "roles",
    "data-placement": "pending",
    "data-ticket-state": "open",
    "data-title": "pending",
    "data-cost-usd": "0",
  });
  const pendingRoles = pageEl(
    { "data-column": "pending", "data-book": "roles", "data-column-count": "1" },
    pageEl({}, new BoardSortElement({ "data-column-count-label": "true" })),
    article2,
  );
  const family78 = new BoardSortElement({
    "data-family": "true",
    "data-parent": "78",
    "data-book": "roles",
    "data-placement": "court",
    "data-cost-usd": "5.01",
  });
  const courtRoles = pageEl(
    { "data-column": "court", "data-book": "roles", "data-column-count": "1" },
    pageEl({}, new BoardSortElement({ "data-column-count-label": "true" })),
    family78,
  );
  const article127 = new BoardSortElement({
    "data-ticket": "127",
    "data-book": "roles",
    "data-placement": "marshal",
    "data-ticket-state": "open",
    "data-parent-issue": "78",
    "data-title": "hot child",
    "data-cost-usd": "5",
  });
  const article104 = new BoardSortElement({
    "data-ticket": "104",
    "data-book": "roles",
    "data-placement": "marshal",
    "data-ticket-state": "open",
    "data-title": "judge after construction",
    "data-cost-usd": "0.5",
  });
  const marshalRoles = pageEl(
    { "data-column": "marshal", "data-book": "roles", "data-column-count": "2" },
    pageEl({}, new BoardSortElement({ "data-column-count-label": "true" })),
    article104,
    article127,
  );
  const article9 = new BoardSortElement({
    "data-ticket": "9",
    "data-book": "roles",
    "data-placement": "unknown",
    "data-ticket-state": "open",
    "data-title": "mystery",
    "data-cost-usd": "0",
  });
  const unknownSetRoles = pageEl({ "data-unknown-set": "true", "data-book": "roles" }, article9);
  const laneTicketsRoles = pageEl(
    { "data-lane-tickets": "roles" },
    pendingRoles,
    courtRoles,
    marshalRoles,
    unknownSetRoles,
  );
  const laneRoles = pageEl({ "data-lane": "roles", "data-book": "roles" }, laneTicketsRoles);

  const article26 = new BoardSortElement({
    "data-ticket": "26",
    "data-book": "orch",
    "data-placement": "unknown",
    "data-ticket-state": "open",
    "data-title": "orch mystery",
    "data-cost-usd": "0",
  });
  const unknownSetOrch = pageEl({ "data-unknown-set": "true", "data-book": "orch" }, article26);
  const laneTicketsOrch = pageEl({ "data-lane-tickets": "orch" }, unknownSetOrch);
  const laneOrch = pageEl({ "data-lane": "orch", "data-book": "orch" }, laneTicketsOrch);
  laneOrch.style.display = "none";

  document.root.appendChild(sortSel);
  document.root.appendChild(projectSel);
  document.root.appendChild(familySel);
  document.root.appendChild(badge);
  document.root.appendChild(laneRoles);
  document.root.appendChild(laneOrch);

  vm.runInNewContext(scriptBody, { document });

  return {
    document,
    sortSel,
    projectSel,
    familySel,
    badge,
    badgeSummary,
    lanes: { roles: laneRoles, orch: laneOrch },
    columns: { pending: pendingRoles, court: courtRoles, marshal: marshalRoles },
  };
}

test("kanban page script: per-column sort never moves cards across columns", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-kanban-script-sort-"));
  try {
    const ledgerDir = join(workspace, "ledger");
    await mkdir(join(ledgerDir, "issues", "1"), { recursive: true });
    const html = await renderFactoryBoardHtml(
      [{ bookKey: "roles", ledgerDir }],
      {
        ok: true,
        snapshot: {
          books: [
            {
              bookKey: "roles",
              owner: "acme",
              repo: "roles",
              tickets: [ticket({ issueNumber: 1, title: "pending", state: "open" })],
            },
          ],
        },
      },
      new Date("2026-08-05T12:00:00.000Z"),
    );
    const page = buildKanbanFakePage(productionPageScriptBody(html));

    const marshalOrder = () =>
      page.columns["marshal"]!.children
        .filter((el) => el.hasAttribute("data-ticket"))
        .map((el) => el.getAttribute("data-ticket"));

    page.sortSel.value = "cost-desc";
    page.sortSel.dispatchEvent("change");
    assert.deepEqual(marshalOrder(), ["127", "104"], "cost-desc inside the marshal column");

    page.sortSel.value = "cost-asc";
    page.sortSel.dispatchEvent("change");
    assert.deepEqual(marshalOrder(), ["104", "127"], "cost-asc inside the marshal column");

    page.sortSel.value = "ticket-asc";
    page.sortSel.dispatchEvent("change");
    assert.deepEqual(marshalOrder(), ["104", "127"]);
    // Cards never leak across columns: pending/court/unknown memberships unchanged.
    assert.ok(page.columns["pending"]!.children.some((el) => el.getAttribute("data-ticket") === "2"));
    assert.ok(page.columns["court"]!.children.some((el) => el.hasAttribute("data-family")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("kanban page script: project and family filters drive lanes, badge count, column counts", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-kanban-script-filter-"));
  try {
    const ledgerDir = join(workspace, "ledger");
    await mkdir(join(ledgerDir, "issues", "1"), { recursive: true });
    const html = await renderFactoryBoardHtml(
      [{ bookKey: "roles", ledgerDir }],
      {
        ok: true,
        snapshot: {
          books: [
            {
              bookKey: "roles",
              owner: "acme",
              repo: "roles",
              tickets: [ticket({ issueNumber: 1, title: "pending", state: "open" })],
            },
          ],
        },
      },
      new Date("2026-08-05T12:00:00.000Z"),
    );
    const page = buildKanbanFakePage(productionPageScriptBody(html));

    // Family options for the default project: only parents with an open child (#78 via #127).
    const familyValues = () => page.familySel.children.map((o) => o.value);
    assert.deepEqual(familyValues(), ["all"], "initial server-rendered options are replaced by script rebuild only on project change");

    // Select family 78: parent + children stay, everything else hides; counts follow.
    familySelRebuild(page);
    // After rebuild, family options carry mechanical child counts (data-family-option / data-child-count).
    const opt78 = page.familySel.children.find((o) => o.value === "78");
    assert.ok(opt78, "family option for open-child parent");
    assert.equal(opt78.getAttribute("data-family-option"), "78");
    assert.equal(opt78.getAttribute("data-child-count"), "1", "open-parent option carries child count");

    page.familySel.value = "78";
    page.familySel.dispatchEvent("change");
    const visible = (el: BoardSortElement) => el.style.display !== "none";
    const marshalCards = page.columns["marshal"]!.children.filter((el) => el.hasAttribute("data-ticket"));
    assert.ok(visible(marshalCards.find((el) => el.getAttribute("data-ticket") === "127")!), "child of selected family stays");
    assert.ok(!visible(marshalCards.find((el) => el.getAttribute("data-ticket") === "104")!), "unrelated card hides");
    assert.ok(!visible(page.columns["pending"]!.children.find((el) => el.getAttribute("data-ticket") === "2")!), "lone pending card hides");
    assert.equal(page.columns["marshal"]!.getAttribute("data-column-count"), "1", "column count follows the filtered set");
    assert.equal(page.columns["pending"]!.getAttribute("data-column-count"), "0");
    // Unknown badge consumes the same filtered set: #9 is not in family 78 → count 0.
    assert.equal(page.badge.getAttribute("data-unknown-count"), "0");
    assert.equal(page.badgeSummary.textContent, "未知票 ×0");

    // Back to all: badge returns to the project count.
    page.familySel.value = "all";
    page.familySel.dispatchEvent("change");
    assert.equal(page.badge.getAttribute("data-unknown-count"), "1");
    assert.equal(page.columns["marshal"]!.getAttribute("data-column-count"), "2");

    // Switch project to orch: roles lane hides, badge counts orch unknowns, options rebuild.
    page.projectSel.value = "orch";
    page.projectSel.dispatchEvent("change");
    assert.equal(page.lanes["roles"]!.style.display, "none");
    assert.equal(page.lanes["orch"]!.style.display, "");
    assert.equal(page.badge.getAttribute("data-unknown-count"), "1", "orch has its own unknown ticket");
    assert.deepEqual(familyValues(), ["all"], "orch has no open-child parents");
    assert.equal(page.familySel.value, "all", "family filter resets on project switch");

    // Switch back to roles: family options rebuild from the roles cards.
    page.projectSel.value = "roles";
    page.projectSel.dispatchEvent("change");
    assert.equal(page.lanes["roles"]!.style.display, "");
    assert.deepEqual(familyValues(), ["all", "78"], "roles family options rebuilt from card facts");
    assert.equal(
      page.familySel.children.find((o) => o.value === "78")?.getAttribute("data-child-count"),
      "1",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

/** Drive the script's own option rebuild path (project switch) without changing the value. */
function familySelRebuild(page: KanbanFakePage): void {
  const current = page.projectSel.value;
  page.projectSel.value = current;
  page.projectSel.dispatchEvent("change");
}

// ---------------------------------------------------------------------------
// #162 presentation contract — breadcrumb, six resident columns, state strip,
// family option child count (S2 true entry; data-* oracles only)
// ---------------------------------------------------------------------------

function findChromeExecutable(): string | null {
  const candidates = [
    join(
      homedir(),
      "Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    ),
    join(
      homedir(),
      "Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    ),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Wait for Chrome's own DevToolsActivePort readiness record. Chrome writes this
 * file only after its DevTools server has bound the selected port, so readiness
 * is observed at the browser-owned boundary rather than guessed from elapsed time.
 */
async function waitForChromeDevTools(
  chromeProc: ReturnType<typeof spawn>,
  userDataDir: string,
  stderr: () => string,
): Promise<{ port: number; webSocketDebuggerUrl: string }> {
  const activePortPath = join(userDataDir, "DevToolsActivePort");
  const readEndpoint = async (): Promise<{ port: number; webSocketDebuggerUrl: string } | null> => {
    let raw: string;
    try {
      raw = await readFile(activePortPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const [portText, browserPath] = raw.trim().split(/\r?\n/);
    const port = Number(portText);
    if (!Number.isInteger(port) || port <= 0 || !browserPath?.startsWith("/")) {
      throw new Error(`Chrome wrote an invalid DevToolsActivePort record: ${JSON.stringify(raw)}`);
    }
    return { port, webSocketDebuggerUrl: `ws://127.0.0.1:${port}${browserPath}` };
  };
  const initial = await readEndpoint();
  if (initial) return initial;

  const watcher = watchDirectory(userDataDir);
  let waitError: unknown;
  const processFailure = new Promise<never>((_resolve, reject) => {
    const report = (detail: string): void => {
      const evidence = stderr().trim();
      reject(
        new Error(
          `${detail}${evidence ? `; Chrome stderr:\n${evidence}` : "; Chrome produced no stderr"}`,
        ),
      );
    };
    chromeProc.once("error", (error) => report(`Chrome failed to start: ${error.message}`));
    chromeProc.once("close", (code, signal) =>
      report(`Chrome closed before DevTools was ready (code=${code ?? "none"}, signal=${signal ?? "none"})`),
    );
  });
  try {
    const fileReady = (async (): Promise<{ port: number; webSocketDebuggerUrl: string }> => {
      // Close the small race between the initial read and watcher registration.
      const afterWatch = await readEndpoint();
      if (afterWatch) return afterWatch;
      for await (const event of watcher) {
        if (String(event.filename) !== "DevToolsActivePort") continue;
        const endpoint = await readEndpoint();
        if (endpoint) return endpoint;
        throw new Error("Chrome signalled DevToolsActivePort readiness but the record disappeared");
      }
      throw new Error("Chrome DevTools readiness watcher ended before an endpoint was published");
    })();
    return await Promise.race([fileReady, processFailure]);
  } catch (error) {
    waitError = error;
    throw error;
  } finally {
    chromeProc.removeAllListeners("error");
    chromeProc.removeAllListeners("close");
    try {
      await watcher.return?.();
    } catch (cleanupError) {
      if (waitError) throw new AggregateError([waitError, cleanupError], "Chrome readiness cleanup failed");
      throw cleanupError;
    }
  }
}

async function stopChromeGracefully(chromeProc: ReturnType<typeof spawn>): Promise<void> {
  if (chromeProc.exitCode !== null || chromeProc.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => chromeProc.once("close", () => resolve()));
  if (!chromeProc.kill("SIGTERM")) {
    if (chromeProc.exitCode !== null || chromeProc.signalCode !== null) return;
    throw new Error("Chrome graceful shutdown could not be requested");
  }
  await closed;
}

function closeWebSocketGracefully(ws: WebSocket): void {
  if (ws.readyState !== WebSocket.CLOSED) ws.close();
}

/**
 * Headless Chrome computed-style probe for ticket top strips + state dots.
 * Locates cards by data-ticket and their data-state-dot; reads border-top,
 * data-state-strip, and the dot's computed color (same-hue oracle).
 */
async function ticketStripComputedStyles(
  html: string,
  issueNumbers: readonly number[],
): Promise<
  Map<
    number,
    {
      borderTopWidth: string;
      borderTopColor: string;
      stateStrip: string | null;
      dotColor: string;
    }
  >
> {
  const chrome = findChromeExecutable();
  assert.ok(chrome, "Chrome/Chromium required for state-strip computed-style proof");
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-strip-"));
  const htmlPath = join(workspace, "board.html");
  await writeFile(htmlPath, html, "utf8");
  const userDataDir = join(workspace, "chrome-profile");
  await mkdir(userDataDir, { recursive: true });
  const chromeProc = spawn(
    chrome,
    [
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--remote-allow-origins=*",
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let chromeStderr = "";
  chromeProc.stderr?.setEncoding("utf8");
  chromeProc.stderr?.on("data", (chunk: string) => {
    chromeStderr += chunk;
  });
  let pageWs: WebSocket | null = null;
  let operationError: unknown;
  try {
    const endpoint = await waitForChromeDevTools(chromeProc, userDataDir, () => chromeStderr);

    const targets = (await (await fetch(`http://127.0.0.1:${endpoint.port}/json/list`)).json()) as Array<{
      id: string;
      type: string;
      webSocketDebuggerUrl?: string;
    }>;
    const pageTarget = targets.find((t) => t.type === "page") ?? targets[0];
    assert.ok(pageTarget?.webSocketDebuggerUrl, "no page target");

    const activePageWs = new WebSocket(pageTarget.webSocketDebuggerUrl);
    pageWs = activePageWs;
    await new Promise<void>((resolve, reject) => {
      activePageWs.addEventListener("open", () => resolve(), { once: true });
      activePageWs.addEventListener("error", () => reject(new Error("page CDP failed")), { once: true });
    });
    let nextId = 1;
    let loadResolve: (() => void) | null = null;
    const pageLoaded = new Promise<void>((resolve) => {
      loadResolve = resolve;
    });
    const pagePending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    activePageWs.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        result?: unknown;
        error?: { message?: string };
        method?: string;
      };
      if (msg.method === "Page.loadEventFired") loadResolve?.();
      if (msg.id !== undefined && pagePending.has(msg.id)) {
        const p = pagePending.get(msg.id)!;
        pagePending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? "cdp error"));
        else p.resolve(msg.result);
      }
    });
    const pageSend = (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pagePending.set(id, { resolve, reject });
        activePageWs.send(JSON.stringify({ id, method, params }));
      });
    };

    await pageSend("Page.enable");
    const fileUrl = `file://${htmlPath}`;
    await pageSend("Page.navigate", { url: fileUrl });
    await pageLoaded;
    await pageSend("Runtime.enable");

    const expression = `(() => {
      const want = ${JSON.stringify(issueNumbers.map(String))};
      const out = {};
      for (const n of want) {
        const el = document.querySelector('[data-ticket="' + n + '"]');
        if (!el) { out[n] = null; continue; }
        const cs = getComputedStyle(el);
        const dot = el.querySelector('[data-state-dot]');
        const dotColor = dot ? getComputedStyle(dot).color : null;
        out[n] = {
          borderTopWidth: cs.borderTopWidth,
          borderTopColor: cs.borderTopColor,
          stateStrip: el.getAttribute('data-state-strip'),
          dotColor,
        };
      }
      return out;
    })()`;
    const evalResult = (await pageSend("Runtime.evaluate", {
      expression,
      returnByValue: true,
    })) as {
      result?: {
        value?: Record<
          string,
          {
            borderTopWidth: string;
            borderTopColor: string;
            stateStrip: string | null;
            dotColor: string | null;
          } | null
        >;
      };
    };
    const value = evalResult.result?.value ?? {};
    const map = new Map<
      number,
      {
        borderTopWidth: string;
        borderTopColor: string;
        stateStrip: string | null;
        dotColor: string;
      }
    >();
    for (const n of issueNumbers) {
      const row = value[String(n)];
      assert.ok(row, `ticket #${n} missing in computed-style probe`);
      assert.ok(row.dotColor, `ticket #${n} missing data-state-dot computed color`);
      map.set(n, { ...row, dotColor: row.dotColor });
    }
    return map;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (pageWs) {
      try {
        closeWebSocketGracefully(pageWs);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await stopChromeGracefully(chromeProc);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await rm(workspace, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      const failures = operationError ? [operationError, ...cleanupErrors] : cleanupErrors;
      throw new AggregateError(failures, "Chrome computed-style lifecycle cleanup failed");
    }
  }
}

test("kanban presentation: six resident columns always, empty count 0, other on demand", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-six-cols-"));
  try {
    const ledgerDir = join(workspace, "ledger");
    // Only a pending ticket — five other resident columns must still appear empty.
    await mkdir(join(ledgerDir, "issues", "1"), { recursive: true });
    const html = await renderFactoryBoardHtml(
      [{ bookKey: "roles", ledgerDir }],
      {
        ok: true,
        snapshot: {
          books: [
            {
              bookKey: "roles",
              owner: "acme",
              repo: "roles",
              tickets: [ticket({ issueNumber: 1, title: "only pending", state: "open" })],
            },
          ],
        },
      },
      new Date("2026-08-05T12:00:00.000Z"),
    );
    assert.deepEqual(laneColumnOrder(html, "roles"), [
      "pending",
      "court",
      "coder",
      "marshal",
      "collector",
      "done",
    ]);
    const counts = new Map(
      elementsWith(html, "data-column")
        .filter((c) => c["data-book"] === "roles")
        .map((c) => [c["data-column"]!, c["data-column-count"]!]),
    );
    assert.equal(counts.get("pending"), "1");
    for (const key of ["court", "coder", "marshal", "collector", "done"]) {
      assert.equal(counts.get(key), "0", `${key} empty resident column keeps count 0`);
    }
    assert.ok(!counts.has("other:auditor"), "non-resident column absent when empty");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("kanban presentation: ledger-order breadcrumb collapses, marks return and rejected", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-breadcrumb-"));
  try {
    const ledgerDir = join(workspace, "ledger");
    const now = new Date("2026-08-05T12:00:00.000Z");
    const nowMs = now.getTime();

    // judge continue, judge continue (collapse ×2 rejected), coder done, judge converged (return)
    await writeRunSession(
      ledgerDir,
      7,
      "judge-r1@x",
      [
        sessionHeader("2026-08-05T08:00:00.000Z"),
        ...acceptedJudgeFinal(
          "2026-08-05T08:05:00.000Z",
          {
            judgeStatus: "continue",
            fix: { summary: "fix" },
            classes: [{ name: "c", owner: "o", boundary: "b", disposition: "d" }],
          },
          0.01,
          10,
        ),
      ],
      { mtime: new Date(nowMs - 14_000_000) },
    );
    await writeRunSession(
      ledgerDir,
      7,
      "judge-r2@x",
      [
        sessionHeader("2026-08-05T09:00:00.000Z"),
        ...acceptedJudgeFinal(
          "2026-08-05T09:05:00.000Z",
          {
            judgeStatus: "continue",
            fix: { summary: "fix2" },
            classes: [{ name: "c2", owner: "o", boundary: "b", disposition: "d" }],
          },
          0.02,
          20,
        ),
      ],
      { mtime: new Date(nowMs - 10_000_000) },
    );
    await writeRunSession(
      ledgerDir,
      7,
      "coder-1@x",
      [sessionHeader("2026-08-05T10:00:00.000Z"), ...acceptedCoderFinal("2026-08-05T10:05:00.000Z", 0.03, 30)],
      { mtime: new Date(nowMs - 7_000_000) },
    );
    await writeRunSession(
      ledgerDir,
      7,
      "judge-final@x",
      [
        sessionHeader("2026-08-05T11:00:00.000Z"),
        ...acceptedJudgeFinal("2026-08-05T11:05:00.000Z", { judgeStatus: "converged" }, 0.04, 40),
      ],
      { mtime: new Date(nowMs - 3_000_000) },
    );

    const html = await renderFactoryBoardHtml(
      [{ bookKey: "roles", ledgerDir }],
      {
        ok: true,
        snapshot: {
          books: [
            {
              bookKey: "roles",
              owner: "acme",
              repo: "roles",
              tickets: [ticket({ issueNumber: 7, title: "loop", state: "open" })],
            },
          ],
        },
      },
      now,
    );

    const steps = breadcrumbStepsOf(html, 7);
    assert.equal(steps.length, 3, "judge×2 + coder + judge → 3 collapsed steps");
    assert.equal(steps[0]?.["data-station"], "judge");
    assert.equal(steps[0]?.["data-step-count"], "2");
    assert.equal(steps[0]?.["data-return"], "false");
    assert.equal(steps[0]?.["data-rejected"], "true", "continue results mark the step rejected");
    assert.equal(steps[1]?.["data-station"], "coder");
    assert.equal(steps[1]?.["data-step-count"], "1");
    assert.equal(steps[1]?.["data-rejected"], "false");
    assert.equal(steps[2]?.["data-station"], "judge");
    assert.equal(steps[2]?.["data-return"], "true", "reappearance after another station is a return");
    assert.equal(steps[2]?.["data-rejected"], "false");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("kanban presentation: family options carry mechanical open-child count", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-family-opt-"));
  try {
    const ledgerDir = join(workspace, "ledger");
    await mkdir(join(ledgerDir, "issues", "10"), { recursive: true });
    await mkdir(join(ledgerDir, "issues", "11"), { recursive: true });
    await mkdir(join(ledgerDir, "issues", "12"), { recursive: true });
    const html = await renderFactoryBoardHtml(
      [{ bookKey: "roles", ledgerDir }],
      {
        ok: true,
        snapshot: {
          books: [
            {
              bookKey: "roles",
              owner: "acme",
              repo: "roles",
              tickets: [
                ticket({ issueNumber: 10, title: "parent", state: "open" }),
                ticket({ issueNumber: 11, title: "child a", state: "open", parentIssueNumber: 10 }),
                ticket({ issueNumber: 12, title: "child b", state: "open", parentIssueNumber: 10 }),
              ],
            },
          ],
        },
      },
      new Date("2026-08-05T12:00:00.000Z"),
    );
    const options = elementsWith(html, "data-family-option");
    assert.equal(options.length, 1);
    assert.equal(options[0]?.["data-family-option"], "10");
    assert.equal(options[0]?.["data-child-count"], "2");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("kanban presentation: five-state strip via data-state-strip + browser computed top border", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-board-strip-states-"));
  try {
    const ledgerDir = join(workspace, "ledger");
    const now = new Date("2026-08-05T12:00:00.000Z");
    const nowMs = now.getTime();

    // #1 flying (<2min)
    await writeRunSession(
      ledgerDir, 1, "fly@x",
      [sessionHeader("2026-08-05T11:59:00.000Z"), assistantUsage("2026-08-05T11:59:30.000Z", 0.01, 10)],
      { invocationRole: "coder", mtime: new Date(nowMs - 30_000) },
    );
    // #2 watch (2–15min)
    await writeRunSession(
      ledgerDir, 2, "watch@x",
      [sessionHeader("2026-08-05T11:50:00.000Z"), assistantUsage("2026-08-05T11:51:00.000Z", 0.02, 20)],
      { invocationRole: "coder", mtime: new Date(nowMs - 5 * 60_000) },
    );
    // #3 suspect (>15min)
    await writeRunSession(
      ledgerDir, 3, "suspect@x",
      [sessionHeader("2026-08-05T11:00:00.000Z"), assistantUsage("2026-08-05T11:01:00.000Z", 0.03, 30)],
      { invocationRole: "coder", mtime: new Date(nowMs - 20 * 60_000) },
    );
    // #4 accepted-awaiting
    await writeRunSession(
      ledgerDir, 4, "accepted@x",
      [sessionHeader("2026-08-05T10:00:00.000Z"), ...acceptedCoderFinal("2026-08-05T10:05:00.000Z", 0.04, 40)],
      { mtime: new Date(nowMs - 7_000_000) },
    );
    // #5 escalate-awaiting
    await writeRunSession(
      ledgerDir, 5, "esc@x",
      [
        sessionHeader("2026-08-05T10:30:00.000Z"),
        ...acceptedJudgeFinal(
          "2026-08-05T10:35:00.000Z",
          { judgeStatus: "escalate", decisionGate: { question: "q", options: ["a", "b"] } },
          0.05,
          50,
        ),
      ],
      { mtime: new Date(nowMs - 5_000_000) },
    );

    const html = await renderFactoryBoardHtml(
      [{ bookKey: "roles", ledgerDir }],
      {
        ok: true,
        snapshot: {
          books: [
            {
              bookKey: "roles",
              owner: "acme",
              repo: "roles",
              tickets: [
                ticket({ issueNumber: 1, title: "fly", state: "open" }),
                ticket({ issueNumber: 2, title: "watch", state: "open" }),
                ticket({ issueNumber: 3, title: "suspect", state: "open" }),
                ticket({ issueNumber: 4, title: "accepted", state: "open" }),
                ticket({ issueNumber: 5, title: "esc", state: "open" }),
              ],
            },
          ],
        },
      },
      now,
    );

    const expected: Record<number, string> = {
      1: "unaccepted-flying",
      2: "unaccepted-watch",
      3: "unaccepted-suspect",
      4: "accepted-awaiting",
      5: "escalate-awaiting",
    };
    for (const [n, state] of Object.entries(expected)) {
      const t = elementsWith(html, "data-ticket").find((el) => el["data-ticket"] === n);
      assert.equal(t?.["data-current-state"], state);
      assert.equal(t?.["data-state-strip"], state, "strip key mirrors current state");
      assert.ok(
        elementsWith(html, "data-state-label").some(
          (el) => el["data-state-label"] === state,
        ),
        `state dot label present for ${state}`,
      );
    }

    const styles = await ticketStripComputedStyles(html, [1, 2, 3, 4, 5]);
    const colors = new Set<string>();
    for (const n of [1, 2, 3, 4, 5] as const) {
      const row = styles.get(n)!;
      assert.equal(row.stateStrip, expected[n]);
      const widthPx = Number.parseFloat(row.borderTopWidth);
      assert.ok(Number.isFinite(widthPx) && widthPx > 0, `#${n} top border width must be non-zero`);
      assert.match(
        row.borderTopColor,
        /^(rgb(a)?\(|color\()/,
        `#${n} top border resolves to a color`,
      );
      assert.match(
        row.dotColor,
        /^(rgb(a)?\(|color\()/,
        `#${n} state dot resolves to a color`,
      );
      // Same-hue contract: top strip color equals the state-dot computed color.
      assert.equal(
        row.borderTopColor,
        row.dotColor,
        `#${n} (${expected[n]}) top border must equal data-state-dot color`,
      );
      colors.add(row.borderTopColor);
    }
    // All five states must resolve to mutually distinct computed colors.
    assert.equal(
      colors.size,
      5,
      `expected 5 distinct strip colors across five states, got ${colors.size}: ${[...colors].join("; ")}`,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
