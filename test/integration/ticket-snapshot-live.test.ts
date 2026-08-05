/**
 * Live GitHub contract for factory-board S2 ticket snapshot adapter.
 *
 * Asserts only the #136-frozen minimal #78 family edges:
 *   #127 / #128 / #130 are native children of #78
 *   #128 blocked_by #127
 * Shape fields required; title copy is not asserted.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createGhApiRunner } from "../../src/collector-github.ts";
import {
  createGhTicketSnapshotTransport,
  fetchBoardSnapshot,
} from "../../src/ticket-snapshot.ts";

const OWNER = "Akagilnc";
const REPO = "ak-pi-workflow-roles";
// Frozen #78 family drills — each member is fetched whether open or closed.
const FROZEN_FAMILY_ISSUE_NUMBERS = [78, 127, 128, 130] as const;

test("live GitHub snapshot keeps #78 family parent and blocked_by edges", async () => {
  const transport = createGhTicketSnapshotTransport(createGhApiRunner());
  // Named closed/open drills keep frozen family members present even when not in the open list.
  const snapshot = await fetchBoardSnapshot({
    bindings: [{ bookKey: "ak-pi-workflow-roles", owner: OWNER, repo: REPO }],
    closedIssueNumbersByBook: {
      "ak-pi-workflow-roles": [...FROZEN_FAMILY_ISSUE_NUMBERS],
    },
    transport,
  });

  assert.equal(snapshot.books.length, 1);
  const book = snapshot.books[0]!;
  assert.equal(book.owner, OWNER);
  assert.equal(book.repo, REPO);

  const byNumber = new Map(book.tickets.map((t) => [t.issueNumber, t]));

  for (const n of FROZEN_FAMILY_ISSUE_NUMBERS) {
    const ticket = byNumber.get(n);
    assert.ok(ticket, `issue #${n} must be present in snapshot`);
    assert.equal(typeof ticket.title, "string");
    assert.ok(ticket.title.length > 0, `#${n} title non-empty`);
    assert.ok(ticket.state === "open" || ticket.state === "closed", `#${n} state`);
    // milestone is string | null — field must be present (null allowed)
    assert.ok("milestone" in ticket, `#${n} milestone field`);
    assert.ok(
      ticket.milestone === null || typeof ticket.milestone === "string",
      `#${n} milestone shape`,
    );
    assert.ok(Array.isArray(ticket.blockedBy), `#${n} blockedBy array`);
    for (const edge of ticket.blockedBy) {
      assert.equal(typeof edge.issueNumber, "number");
      assert.ok(Number.isInteger(edge.issueNumber) && edge.issueNumber > 0);
      assert.ok(edge.state === "open" || edge.state === "closed");
    }
    // open → closedAt null; closed → finite parseable timestamp string
    if (ticket.state === "open") {
      assert.equal(ticket.closedAt, null, `#${n} open closedAt null`);
    } else {
      assert.equal(typeof ticket.closedAt, "string", `#${n} closed closedAt string`);
      assert.ok(
        Number.isFinite(Date.parse(ticket.closedAt!)),
        `#${n} closedAt must be a parseable GitHub timestamp`,
      );
    }
  }

  assert.equal(byNumber.get(127)?.parentIssueNumber, 78);
  assert.equal(byNumber.get(128)?.parentIssueNumber, 78);
  assert.equal(byNumber.get(130)?.parentIssueNumber, 78);

  const blocked = byNumber.get(128)?.blockedBy ?? [];
  assert.ok(
    blocked.some((edge) => edge.issueNumber === 127),
    "#128 must list blocked_by #127",
  );
});
