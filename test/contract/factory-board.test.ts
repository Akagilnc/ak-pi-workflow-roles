/**
 * S2 factory board — external behavior at:
 *   1) isolated BoardSnapshot → HTML (no network)
 *   2) snapshot adapter against injectable transport (no network)
 *
 * Live GitHub edge contract lives in test/integration/ticket-snapshot-live.test.ts.
 * Assertions read machine data-* keys only (anchoring constitution).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  renderFactoryBoardHtml,
  writeFactoryBoardPage,
  type FactoryBoardBook,
  type FactoryBoardView,
} from "../../src/factory-board.ts";
import {
  fetchBoardSnapshot,
  type BoardSnapshot,
  type SnapshotTicket,
  type TicketSnapshotTransport,
} from "../../src/ticket-snapshot.ts";

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
