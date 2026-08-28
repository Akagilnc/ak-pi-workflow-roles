import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
/**
 * #78 family edge contract for factory-board S2 ticket snapshot adapter.
 *
 * Fixture-backed (no network / no gh auth). Bytes enter only through the
 * production seam: GhApiRunner → createGhTicketSnapshotTransport → fetchBoardSnapshot.
 *
 * Asserts the #136-frozen minimal #78 family edges:
 *   #127 / #128 / #130 are native children of #78
 *   #128 blocked_by #127
 * Shape fields required; title copy is not asserted.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { GhApiRunner, GhApiResponse } from "../../src/collector-github.ts";
import {
  createGhTicketSnapshotTransport,
  fetchBoardSnapshot,
} from "../../src/ticket-snapshot.ts";

const OWNER = "Akagilnc";
const REPO = "ak-pi-workflow-roles";
// Frozen #78 family drills — each member is fetched whether open or closed.
const FROZEN_FAMILY_ISSUE_NUMBERS = [78, 127, 128, 130] as const;

const FIXTURE_URL = new URL(
  "../fixtures/ticket-snapshot/family-78-graphql.json",
  import.meta.url,
);

type Family78GraphqlFixture = {
  openIssues: unknown;
  closedDrills: unknown;
};

function ok(body: unknown): GhApiResponse {
  return {
    status: 200,
    headers: {},
    bodyText: JSON.stringify(body),
  };
}

/** Frozen closed-family alias → issue identity (sorted 78,127,128,130 → c0..c3). */
const CLOSED_FAMILY_ALIASES = [
  { alias: "c0", issueNumber: 78 },
  { alias: "c1", issueNumber: 127 },
  { alias: "c2", issueNumber: 128 },
  { alias: "c3", issueNumber: 130 },
] as const;

/** GraphQL field selection name (not an argument key like `number:`). */
function hasGraphqlField(block: string, name: string): boolean {
  return new RegExp(String.raw`\b${name}\b(?!\s*:)`).test(block);
}

/** Balanced `{...}` span for one named selection (optional args). Brace depth only. */
type GraphqlSelectionRange = {
  /** Index of the field name match start. */
  start: number;
  /** Index of the opening `{`. */
  openBrace: number;
  /** Index just past the closing `}`. */
  end: number;
};

/**
 * Single balanced-brace range primitive. Extract/strip reuse this — no second walk.
 * Not a GraphQL parser; no full-query equality.
 */
function findGraphqlSelectionRange(
  block: string,
  fieldName: string,
): GraphqlSelectionRange | null {
  const re = new RegExp(String.raw`\b${fieldName}\b(?!\s*:)\s*(?:\([^)]*\))?\s*\{`);
  const m = re.exec(block);
  if (!m) return null;
  const openBrace = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = openBrace; i < block.length; i++) {
    const ch = block[i]!;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { start: m.index, openBrace, end: i + 1 };
    }
  }
  return null;
}

/** Interior of one named selection body. Ownership-sensitive. */
function extractGraphqlSelectionBody(block: string, fieldName: string): string | null {
  const range = findGraphqlSelectionRange(block, fieldName);
  if (!range) return null;
  return block.slice(range.openBrace + 1, range.end - 1);
}

/** Drop one named selection (field + optional args + balanced braces) from block. */
function stripGraphqlSelection(block: string, fieldName: string): string {
  const range = findGraphqlSelectionRange(block, fieldName);
  if (!range) return block;
  return block.slice(0, range.start) + block.slice(range.end);
}

/**
 * Local nested-ownership match for the frozen closed-family query.
 * Proves c0..c3 → 78/127/128/130 and each alias carries adapter-required
 * selections under the correct parents (milestone.title, parent.number,
 * blockedBy.{pageInfo pagination, nodes number/state}). Not full-query equality.
 */
function isFrozenClosedFamilyQuery(query: string): boolean {
  const starts: number[] = [];
  let from = 0;
  for (const { alias, issueNumber } of CLOSED_FAMILY_ALIASES) {
    const marker = `${alias}: issue(number: ${issueNumber})`;
    const at = query.indexOf(marker, from);
    if (at === -1) return false;
    starts.push(at);
    from = at + marker.length;
  }

  for (let i = 0; i < CLOSED_FAMILY_ALIASES.length; i++) {
    const block = query.slice(
      starts[i],
      i + 1 < starts.length ? starts[i + 1] : query.length,
    );

    // Nested ownership: required children must live under the right parent field.
    const milestoneBody = extractGraphqlSelectionBody(block, "milestone");
    if (milestoneBody === null || !hasGraphqlField(milestoneBody, "title")) return false;

    const parentBody = extractGraphqlSelectionBody(block, "parent");
    if (parentBody === null || !hasGraphqlField(parentBody, "number")) return false;

    const blockedByBody = extractGraphqlSelectionBody(block, "blockedBy");
    if (blockedByBody === null) return false;
    const pageInfoBody = extractGraphqlSelectionBody(blockedByBody, "pageInfo");
    if (
      pageInfoBody === null ||
      !hasGraphqlField(pageInfoBody, "hasNextPage") ||
      !hasGraphqlField(pageInfoBody, "endCursor")
    ) {
      return false;
    }
    const nodesBody = extractGraphqlSelectionBody(blockedByBody, "nodes");
    if (
      nodesBody === null ||
      !hasGraphqlField(nodesBody, "number") ||
      !hasGraphqlField(nodesBody, "state")
    ) {
      return false;
    }

    // Top-level issue fields must remain on the issue itself (not only nested).
    let topLevel = block;
    for (const nested of ["milestone", "parent", "blockedBy"] as const) {
      topLevel = stripGraphqlSelection(topLevel, nested);
    }
    for (const field of ["number", "title", "state", "closedAt"] as const) {
      if (!hasGraphqlField(topLevel, field)) return false;
    }
  }
  return true;
}

async function loadFixtureRunner(): Promise<GhApiRunner> {
  const fixture = JSON.parse(await readFile(FIXTURE_URL, "utf8")) as Family78GraphqlFixture;

  return async (args) => {
    const queryArg = args.find((a, i) => args[i - 1] === "-f" && a.startsWith("query="));
    const query = queryArg?.slice("query=".length) ?? "";

    if (query.includes("issues(states: OPEN")) {
      return ok(fixture.openIssues);
    }
    // Named closed drills: require full frozen-family identity + adapter selections.
    if (isFrozenClosedFamilyQuery(query)) {
      return ok(fixture.closedDrills);
    }
    throw new Error(`unexpected graphql query (fixture runner is offline-only): ${query.slice(0, 160)}`);
  };
}

/** Production-shaped closed-family query; optional per-alias body mutator for negatives. */
function buildFrozenClosedFamilyQuery(
  mutateAliasBody?: (body: string) => string,
): string {
  const aliases = CLOSED_FAMILY_ALIASES.map(({ alias, issueNumber }) => {
    let body = `
      number
      title
      state
      closedAt
      milestone { title }
      parent { number }
      blockedBy(first: 100) {
          pageInfo { hasNextPage endCursor }
          nodes { number state }
        }`;
    if (mutateAliasBody) body = mutateAliasBody(body);
    return `
    ${alias}: issue(number: ${issueNumber}) {${body}
    }`;
  }).join("\n");
  return `query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    ${aliases}
  }
}`;
}

async function assertFixtureRejectsQuery(query: string): Promise<void> {
  const runner = await loadFixtureRunner();
  await assert.rejects(
    () => runner(["api", "graphql", "-f", `query=${query}`]),
    /unexpected graphql query/,
  );
}

test("fixture GitHub snapshot keeps #78 family parent and blocked_by edges", async () => {
  const runner = await loadFixtureRunner();
  const transport = createGhTicketSnapshotTransport(runner);
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

test("fixture runner rejects blockedBy.pageInfo parked under another alias parent", async () => {
  // pageInfo still present in the alias, but under milestone — not blockedBy.
  const query = buildFrozenClosedFamilyQuery(
    (body) =>
      body
        .replace("milestone { title }", "milestone { title pageInfo { hasNextPage endCursor } }")
        .replace("pageInfo { hasNextPage endCursor }\n          nodes", "nodes"),
  );
  await assertFixtureRejectsQuery(query);
});

test("fixture runner rejects blockedBy.nodes.state parked under another alias parent", async () => {
  // state still present in the alias, but under parent — not blockedBy.nodes.
  const query = buildFrozenClosedFamilyQuery(
    (body) =>
      body
        .replace("parent { number }", "parent { number state }")
        .replace("nodes { number state }", "nodes { number }"),
  );
  await assertFixtureRejectsQuery(query);
});
