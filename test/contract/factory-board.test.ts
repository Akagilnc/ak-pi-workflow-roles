/**
 * S2 factory board — external behavior at:
 *   1) isolated BoardSnapshot → HTML (no network)
 *   2) snapshot adapter against injectable transport (no network)
 *
 * Live GitHub edge contract lives in test/integration/ticket-snapshot-live.test.ts.
 * Assertions read machine data-* keys only (anchoring constitution).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
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
  compareFactoryBoardSort,
  renderFactoryBoardHtml,
  startFactoryBoardPage,
  writeFactoryBoardPage,
  type FactoryBoardBook,
  type FactoryBoardScheduler,
  type FactoryBoardSortMode,
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

/** Minimal Element surface used by the production board sort script. */
class BoardSortElement {
  nodeType = 1;
  childNodes: BoardSortElement[] = [];
  parentNode: BoardSortElement | null = null;
  value = "";
  private readonly attrs: Record<string, string>;
  private readonly listeners = new Map<string, Array<() => void>>();

  constructor(attrs: Record<string, string> = {}) {
    this.attrs = { ...attrs };
  }

  get children(): BoardSortElement[] {
    return this.childNodes;
  }

  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name]! : null;
  }

  hasAttribute(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.attrs, name);
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

  addEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  dispatchEvent(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
}

/**
 * Execute the production page sort control against lane entries parsed from the
 * rendered HTML (same script body the browser runs — not the TS comparator alone).
 */
function executeProductionBoardSort(
  html: string,
  bookKey: string,
  mode: FactoryBoardSortMode,
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
      ticket({ issueNumber: 99, title: "drilled closed", state: "closed", milestone: "done" }),
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
            blockedBy: [],
          },
          {
            issueNumber: 127,
            title: "s1",
            state: "open",
            milestone: null,
            parentIssueNumber: 78,
            blockedBy: [],
          },
          {
            issueNumber: 128,
            title: "s2",
            state: "open",
            milestone: null,
            parentIssueNumber: 78,
            blockedBy: [{ issueNumber: 127, state: "open" }],
          },
          {
            issueNumber: 130,
            title: "s4",
            state: "closed",
            milestone: null,
            parentIssueNumber: 78,
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
                ticket({ issueNumber: 1, title: "closed", state: "closed" }),
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

    // Unaccepted legs expose leg age + last activity
    assert.ok(by(3)?.["data-leg-age-ms"] !== undefined);
    assert.equal(Number(by(3)?.["data-leg-age-ms"]), 60_000);
    assert.ok(by(3)?.["data-last-activity-mtime-ms"] !== undefined);
    assert.equal(by(5)?.["data-current-state"], "unaccepted-suspect");
    assert.ok(Number(by(5)?.["data-leg-age-ms"]) > UNACCEPTED_WATCH_MS);

    // Exact threshold boundaries (authority: 2–15 watch inclusive at 15; >15 suspect)
    assert.equal(by(8)?.["data-current-state"], "unaccepted-watch");
    assert.equal(by(9)?.["data-current-state"], "unaccepted-watch");
    assert.equal(by(10)?.["data-current-state"], "unaccepted-suspect");
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
    // TS comparator stays aligned with the page script (shared contract, not the sole proof)
    const laneEntries = [t20, t21, t22].map((el) => ({
      ticketNumber: Number(el["data-ticket"]),
      costUsd: Number(el["data-cost-usd"]),
    }));
    assert.deepEqual(
      [...laneEntries]
        .sort((a, b) => compareFactoryBoardSort(a, b, "cost-desc"))
        .map((e) => e.ticketNumber),
      [20, 22, 21],
    );
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

    // Counterfactual: parent-only key would put family last on cost-desc — prove aggregate matters
    const parentOnlyDesc = [
      { ticketNumber: 78, costUsd: Number(t78["data-cost-usd"]) },
      { ticketNumber: 50, costUsd: Number(t50["data-cost-usd"]) },
      { ticketNumber: 40, costUsd: 0.05 },
    ]
      .sort((a, b) => compareFactoryBoardSort(a, b, "cost-desc"))
      .map((e) => e.ticketNumber);
    assert.deepEqual(parentOnlyDesc, [50, 40, 78], "parent-only key would bury #130 burn");
    assert.notDeepEqual(desc, parentOnlyDesc);
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

test("S3 true-home acceptance: frozen #127, active leg, #130 cost reconciliation", async () => {
  const homeLedger =
    process.env.AK_FACTORY_BOARD_HOME_LEDGER?.trim() ||
    join(homedir(), ".ak-roles", "books", "ak-pi-workflow-roles");
  const home130 = join(homeLedger, "issues", "130");
  const home139 = join(homeLedger, "issues", "139");
  if (!(await pathExists(home130))) {
    // CI/agents without the owner true-home ledger skip; owner machine must run green.
    return;
  }

  const workspace = await mkdtemp(join(tmpdir(), "factory-board-s3-true-home-"));
  try {
    const ledgerDir = join(workspace, "ledger");
    // 1) Frozen authentic #127 accepted-after-rejections (fixture prefix, no mutable tail)
    await cp(join(fixtureLedger, "issues", "127"), join(ledgerDir, "issues", "127"), {
      recursive: true,
    });
    await rm(join(ledgerDir, "issues", "127", "runs", "review-026@ak-roles-127"), {
      recursive: true,
      force: true,
    });

    // 2) True-home #130 bytes (closed multi-round reviewer burn)
    await cp(home130, join(ledgerDir, "issues", "130"), { recursive: true });

    // 3) Genuine unaccepted active leg: prefer true-home #139 when its latest run is
    // unaccepted; otherwise plant authentic unaccepted review-026 bytes as a flying leg
    // under a dedicated issue (true bytes, controlled mtime — not a manufactured receipt).
    let activeIssue = 139;
    const flyingMtime = new Date("2026-08-05T11:59:45.000Z");
    let plantedActive = false;
    if (await pathExists(home139)) {
      await cp(home139, join(ledgerDir, "issues", "139"), { recursive: true });
      // Probe current state with a throwaway render of #139 alone.
      const probeHtml = await renderFactoryBoardHtml(
        [{ bookKey: "roles", ledgerDir }],
        {
          ok: true,
          snapshot: {
            books: [
              {
                bookKey: "roles",
                owner: "Akagilnc",
                repo: "ak-pi-workflow-roles",
                tickets: [ticket({ issueNumber: 139, title: "probe", state: "open" })],
              },
            ],
          },
        },
        new Date("2026-08-05T12:00:00.000Z"),
      );
      const probe = elementsWith(probeHtml, "data-ticket").find((t) => t["data-ticket"] === "139");
      if (probe?.["data-current-state"]?.startsWith("unaccepted-")) {
        plantedActive = true;
      } else {
        await rm(join(ledgerDir, "issues", "139"), { recursive: true, force: true });
      }
    }
    if (!plantedActive) {
      activeIssue = 998;
      const unacceptedSrc = join(
        fixtureLedger,
        "issues",
        "127",
        "runs",
        "review-026@ak-roles-127",
      );
      const dest = join(
        ledgerDir,
        "issues",
        String(activeIssue),
        "runs",
        "review-026@ak-roles-127",
      );
      await cp(unacceptedSrc, dest, { recursive: true });
      // Fresh mtime so the authentic unaccepted session lands in the flying band.
      const sessionFiles = await readdir(join(dest, "session"));
      for (const name of sessionFiles) {
        if (!name.endsWith(".jsonl")) continue;
        await utimes(join(dest, "session", name), flyingMtime, flyingMtime);
      }
    }

    // Plant zero-run #78 so native family edge is present for sort participation.
    await mkdir(join(ledgerDir, "issues", "78"), { recursive: true });

    const expected130 = await independentIssueUsage(ledgerDir, 130);
    assert.ok(expected130.runCount >= 1, "#130 must have runs");
    assert.ok(expected130.reviewerRunCount >= 1, "#130 reviewer rounds present");

    const before = await treeFingerprint(ledgerDir);
    const now = new Date("2026-08-05T12:00:00.000Z");
    const books: FactoryBoardBook[] = [{ bookKey: "roles", ledgerDir }];
    const view: FactoryBoardView = {
      ok: true,
      snapshot: {
        books: [
          {
            bookKey: "roles",
            owner: "Akagilnc",
            repo: "ak-pi-workflow-roles",
            tickets: [
              ticket({ issueNumber: 78, title: "family parent", state: "open" }),
              ticket({
                issueNumber: 127,
                title: "127",
                state: "open",
                parentIssueNumber: 78,
              }),
              ticket({
                issueNumber: 130,
                title: "130",
                state: "closed",
                parentIssueNumber: 78,
              }),
              ticket({ issueNumber: activeIssue, title: "active", state: "open" }),
            ],
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
    const tActive = elementsWith(html, "data-ticket").find(
      (t) => t["data-ticket"] === String(activeIssue),
    );
    const family78 = elementsWith(html, "data-family").find((f) => f["data-parent"] === "78");
    assert.ok(t127 && t130 && tActive && family78);
    assert.equal(t130["data-parent-issue"], "78");
    assert.equal(t127["data-parent-issue"], "78");

    // Frozen #127 counterexample
    assert.equal(t127["data-current-state"], "accepted-awaiting");
    const acceptedFixer = elementsWith(html, "data-run-id").find(
      (r) => r["data-run-id"] === "fixer-apply-001@ak-roles-127",
    );
    assert.equal(acceptedFixer?.["data-has-result"], "true");

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
    const activeCost = Number(tActive["data-cost-usd"]);
    const sorted = executeProductionBoardSort(html, "roles", "cost-desc").map(laneSortIdentity);
    assert.ok(sorted.includes(78), "#78 family is a sort entry");
    assert.ok(sorted.includes(activeIssue), "active ticket remains a sort entry");
    if (familyCost > activeCost) {
      assert.equal(sorted[0], 78, "#78 family (with #130 burn) leads when it outburns active");
    } else {
      assert.ok(
        sorted.indexOf(78) < sorted.length,
        "#78 family carrying #130 still participates in page sort order",
      );
    }
    // #130 is not a top-level lane entry (nested) but its burn moved the family key
    assert.ok(!sorted.includes(130), "#130 stays nested under family; burn rides aggregate");

    // Genuine unaccepted active leg surfaces age/activity
    assert.match(tActive["data-current-state"] ?? "", /^unaccepted-/);
    assert.ok(tActive["data-leg-age-ms"] !== undefined);
    assert.ok(Number(tActive["data-leg-age-ms"]) >= 0);
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
