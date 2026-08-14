import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildCollectorRequestBody,
  buildCollectorRequestMarker,
  createGhApiRunner,
  createGhCollectorGitHubTransport,
  createGhIssueSoftFetcher,
  normalizeIssueComment,
  normalizePullRequest,
  normalizeReview,
  normalizeReviewComment,
  type GhApiRunner,
} from "../../src/collector-github.ts";
import { createCollectorLedger } from "../../src/collector-ledger.ts";
import {
  normalizeAuthenticatedUserEvidence,
  normalizePullRequestEvidence,
  normalizeReviewEvidence,
  type CollectorClock,
} from "../../src/collector-evidence.ts";
import {
  samplePull,
  sampleUser,
} from "../helpers/fake-github-transport.ts";
import { buildCollectorReceipt } from "../../src/collector-receipt.ts";
import { emptyCollectorManifest } from "../../src/collector-config.ts";
import { createFakeGitHubTransport } from "../helpers/fake-github-transport.ts";

function clockAt(startWall: string): CollectorClock & { advance(ms: number): void } {
  let mono = 0;
  let wall = new Date(startWall);
  return {
    wallNow: () => new Date(wall),
    monoNow: () => mono,
    async sleep(ms) {
      mono += ms;
      wall = new Date(wall.getTime() + ms);
    },
    advance(ms) {
      mono += ms;
      wall = new Date(wall.getTime() + ms);
    },
  };
}

async function withPathGhStub<T>(
  scriptBody: string,
  run: (binDir: string) => Promise<T>,
): Promise<T> {
  const binDir = await mkdtemp(join(tmpdir(), "ak-gh-bin-"));
  const ghPath = join(binDir, "gh");
  await writeFile(ghPath, scriptBody, "utf8");
  await chmod(ghPath, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath ?? ""}`;
  try {
    return await run(binDir);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
}

test("runtime receipt is formed solely from observed typed identity groups", async () => {
  const raw = JSON.parse(await readFile(new URL("../fixtures/collector/coderabbit-review-4895713581.json", import.meta.url), "utf8"));
  const review = normalizeReview(raw);
  const clock = clockAt("2026-08-11T00:00:00Z");
  const ledger = createCollectorLedger({
    repository: { display: "acme/widgets", canonical: "acme/widgets", owner: "acme", repo: "widgets" },
    prNumber: 1,
    manifest: emptyCollectorManifest(),
  });
  ledger.recordActivation(clock);
  await ledger.observe(createFakeGitHubTransport({
    user: { login: "collector", raw: { login: "collector" } },
    pullRequest: { number: 1, state: "OPEN", headOid: review.commitId!, updatedAt: "2026-08-11T00:00:00Z", url: "https://github.com/acme/widgets/pull/1", raw: { number: 1 } },
    reviews: [review], issueComments: [], reviewComments: [],
  }), clock);
  const receipt = buildCollectorReceipt(ledger, { ignored: "model projection" }, clock);
  assert.equal(receipt.groups.length, 1);
  assert.equal(receipt.groups[0]?.identity?.userId, 136622811);
  assert.equal(receipt.groups[0]?.attendance, true);
  assert.equal(Object.hasOwn(receipt, "reports"), false);
  assert.equal(Object.hasOwn(receipt, "legs"), false);
  assert.equal(Object.hasOwn(receipt, "identityGroups"), false);
});

test("production transport uses gh api --hostname github.com argument vector", async () => {
  const calls: string[][] = [];
  const runner = async (args: string[]) => {
    calls.push(args);
    if (args.includes("/user")) {
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify({ login: "collector-bot" }),
      };
    }
    if (args.some((arg) => arg.includes("/pulls/1") && !arg.includes("reviews") && !arg.includes("comments"))) {
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify({
          number: 1,
          state: "open",
          head: { sha: "abc" },
          html_url: "https://github.com/a/b/pull/1",
        }),
      };
    }
    if (args.some((arg) => arg.includes("/reviews"))) {
      return {
        status: 200,
        headers: { link: "" },
        bodyText: "[]",
      };
    }
    if (args.some((arg) => arg.includes("/comments"))) {
      return {
        status: 200,
        headers: {},
        bodyText: "[]",
      };
    }
    throw new Error(`unexpected args ${args.join(" ")}`);
  };
  const transport = createGhCollectorGitHubTransport(runner);
  await transport.getAuthenticatedUser();
  await transport.getPullRequest({ owner: "a", repo: "b", prNumber: 1 });
  await transport.listPullRequestReviews({ owner: "a", repo: "b", prNumber: 1 });
  assert.ok(calls.length >= 3);
  for (const args of calls) {
    assert.equal(args[0], "api");
    assert.equal(args[1], "--hostname");
    assert.equal(args[2], "github.com");
    assert.ok(args.includes("--include"));
    assert.equal(args.includes("-c"), false);
    assert.equal(args.some((arg) => arg.includes("|") || arg.includes("&&")), false);
  }
});

test("normalize helpers accept OPEN and valid review states and reject missing head", () => {
  const pr = normalizePullRequest({
    number: 3,
    state: "open",
    head: { sha: "fff" },
    html_url: "https://github.com/a/b/pull/3",
  });
  assert.equal(pr.state, "OPEN");
  assert.equal(pr.headOid, "fff");
  assert.throws(
    () => normalizePullRequest({ number: 1, state: "open", head: {} }),
    /head\.sha/,
  );
  const review = normalizeReview({
    id: 9,
    user: { login: "Bot" },
    state: "APPROVED",
    body: "ok",
    commit_id: "fff",
    submitted_at: "2024-01-01T00:00:00Z",
    html_url: "https://example.test",
  });
  assert.equal(review.userLogin, "Bot");
  assert.equal(review.state, "APPROVED");
});

test("request marker is deterministic for digest/request/head", () => {
  const marker = buildCollectorRequestMarker({
    manifestDigest: "abcdef0123456789",
    requestId: "codex",
    headOid: "head1",
  });
  assert.match(
    marker,
    /^<!-- ak-collector:v1 manifest=abcdef012345 request=[a-f0-9]{64} head=head1 -->$/,
  );
  const built = buildCollectorRequestBody({
    configuredBody: "Please review.",
    manifestDigest: "abcdef0123456789",
    requestId: "codex",
    headOid: "head1",
  });
  assert.equal(built.body.startsWith("Please review.\n"), true);
  assert.ok(built.body.includes(marker));
  const hostile = buildCollectorRequestMarker({
    manifestDigest: "abcdef0123456789",
    requestId: `UPPER --> ${"長".repeat(80)}`,
    headOid: "head1",
  });
  assert.equal(hostile.includes("UPPER"), false);
  assert.equal(hostile.match(/-->/g)?.length, 1);
});

test("PR reactions transport follows issue-level endpoint pagination", async () => {
  const paths: string[] = [];
  const runner = async (args: string[]) => {
    const path = args.find((arg) => arg.startsWith("/repos/"))!;
    paths.push(path);
    return paths.length === 1
      ? { status: 200, headers: { link: '<https://api.github.com/repos/a/b/issues/1/reactions?per_page=100&page=2>; rel="next"' }, bodyText: '[{"id":7,"user":{"id":199175422,"login":"codex","type":"User"},"content":"+1","created_at":"2026-01-01T00:00:00Z"}]' }
      : { status: 200, headers: {}, bodyText: "[]" };
  };
  const result = await createGhCollectorGitHubTransport(runner).listPullRequestReactions!({ owner: "a", repo: "b", prNumber: 1 });
  assert.deepEqual(paths, [
    "/repos/a/b/issues/1/reactions?per_page=100",
    "/repos/a/b/issues/1/reactions?per_page=100&page=2",
  ]);
  assert.equal(result.items[0]?.machineIdentity?.userId, 199175422);
  assert.equal(result.items[0]?.machineIdentity?.userType, "User");
  assert.equal(result.pages.length, 2);
});

test("final-page HTTP 429 fails pagination loudly", async () => {
  let page = 0;
  const runner = async (args: string[]) => {
    if (!args.some((arg) => arg.includes("/reviews"))) {
      return { status: 200, headers: {}, bodyText: "[]" };
    }
    page += 1;
    if (page === 1) {
      return {
        status: 200,
        headers: {
          link: '<https://api.github.com/repos/a/b/pulls/1/reviews?page=2>; rel="next"',
        },
        bodyText: "[]",
      };
    }
    return { status: 429, headers: {}, bodyText: "rate limited" };
  };
  const transport = createGhCollectorGitHubTransport(runner);
  await assert.rejects(
    () => transport.listPullRequestReviews({ owner: "a", repo: "b", prNumber: 1 }),
    /429|rate/i,
  );
});

test("default createGhApiRunner spawns executable gh on PATH hermetically", async () => {
  // Real spawn once for argv + --include frame parse; scenario matrix lives in-process elsewhere.
  const logPath = join(await mkdtemp(join(tmpdir(), "ak-gh-log-")), "args.log");
  const script = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
printf 'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{"login":"collector-bot"}'
`;
  await withPathGhStub(script, async () => {
    const runner = createGhApiRunner();
    const transport = createGhCollectorGitHubTransport(runner);
    const user = await transport.getAuthenticatedUser();
    assert.equal(user.login, "collector-bot");
    const log = await (await import("node:fs/promises")).readFile(logPath, "utf8");
    assert.match(log, /api --hostname github.com --include/);
    assert.doesNotMatch(log, / \| |&&/);
  });
});

test("createGhIssueSoftFetcher softens tracker-unavailable only; other failures propagate", async () => {
  const calls: string[][] = [];
  const runner: GhApiRunner = async (args) => {
    calls.push([...args]);
    if (args.includes("repos/Acme/widgets/issues/343")) {
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify({ title: "Spec", body: "issue body bytes", body_null_ok: true }),
      };
    }
    if (args.includes("repos/Acme/widgets/issues/404")) {
      return { status: 404, headers: {}, bodyText: "{\"message\":\"Not Found\"}" };
    }
    if (args.includes("repos/Acme/widgets/issues/401")) {
      // Shared runner tags auth/network/no-HTTP as ambiguousGhFailure = tracker unreachable.
      throw Object.assign(new Error("gh api failed without a parseable HTTP response"), {
        ambiguousGhFailure: true,
      });
    }
    throw new Error("spawn failed");
  };
  const fetchIssue = createGhIssueSoftFetcher(runner);
  const ok = await fetchIssue({ owner: "Acme", repo: "widgets", ticketNumber: 343 });
  assert.deepEqual(ok, { title: "Spec", body: "issue body bytes" });
  assert.equal(
    calls[0]?.join(" ").includes("api --hostname github.com --include -X GET repos/Acme/widgets/issues/343"),
    true,
  );

  // Issue not found / tracker non-success → authorized soft unavailable.
  const missing = await fetchIssue({ owner: "Acme", repo: "widgets", ticketNumber: 404 });
  assert.equal(missing, undefined);

  // Tagged tracker-unreachable transport → authorized soft unavailable (not a catch-all).
  const unreachable = await fetchIssue({ owner: "Acme", repo: "widgets", ticketNumber: 401 });
  assert.equal(unreachable, undefined);

  // Unrecognized runner exception keeps true cause — must not wash into unavailable.
  await assert.rejects(
    () => fetchIssue({ owner: "Acme", repo: "widgets", ticketNumber: 500 }),
    (error: unknown) => error instanceof Error && error.message === "spawn failed",
  );

  // Parse / payload shape failures keep true cause.
  const badJsonRunner: GhApiRunner = async () => ({
    status: 200,
    headers: {},
    bodyText: "not-json",
  });
  await assert.rejects(
    () =>
      createGhIssueSoftFetcher(badJsonRunner)({
        owner: "Acme",
        repo: "widgets",
        ticketNumber: 1,
      }),
    /GitHub issue payload is not JSON/,
  );
  const badShapeRunner: GhApiRunner = async () => ({
    status: 200,
    headers: {},
    bodyText: JSON.stringify({ title: 1, body: "x" }),
  });
  await assert.rejects(
    () =>
      createGhIssueSoftFetcher(badShapeRunner)({
        owner: "Acme",
        repo: "widgets",
        ticketNumber: 1,
      }),
    /missing string title/,
  );

  // null body projects to empty string (former gh --jq body // "").
  const nullBodyRunner: GhApiRunner = async () => ({
    status: 200,
    headers: {},
    bodyText: JSON.stringify({ title: "empty", body: null }),
  });
  const empty = await createGhIssueSoftFetcher(nullBodyRunner)({
    owner: "Acme",
    repo: "widgets",
    ticketNumber: 1,
  });
  assert.deepEqual(empty, { title: "empty", body: "" });
});


test("R6 null user materials are retained without gaining typed identity", async () => {
  const review = normalizeReview({
    id: 1,
    user: null,
    state: "APPROVED",
    body: "ghost approve",
    commit_id: "abc",
    submitted_at: "2024-01-01T00:00:00Z",
    html_url: "https://example.test/r/1",
  });
  assert.equal(review.userLogin, null);

  const issue = normalizeIssueComment({
    id: 2,
    user: null,
    body: "ghost comment",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    html_url: "https://example.test/c/2",
  });
  assert.equal(issue.userLogin, null);

  const inline = normalizeReviewComment({
    id: 3,
    user: null,
    body: "ghost inline",
    path: "src/a.ts",
    line: 1,
    original_line: 1,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    html_url: "https://example.test/rc/3",
    pull_request_review_id: 1,
  });
  assert.equal(inline.userLogin, null);

  const clock = clockAt("2024-01-01T00:10:00Z");
  let page = 0;
  const runner = async (args: string[]) => {
    const pathArg = args.find((arg) => arg.startsWith("/")) ?? "";
    if (pathArg.includes("/user")) {
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify({ login: "collector-bot", id: 1 }),
      };
    }
    if (
      pathArg.includes("/pulls/1") &&
      !pathArg.includes("reviews") &&
      !pathArg.includes("comments")
    ) {
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify({
          number: 1,
          state: "open",
          head: { sha: "head-c" },
          updated_at: "2024-01-01T00:00:00Z",
          html_url: "https://github.com/a/b/pull/1",
        }),
      };
    }
    if (pathArg.includes("/reviews")) {
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify([{
          id: 11,
          user: null,
          state: "APPROVED",
          body: "tombstone review",
          commit_id: "head-c",
          submitted_at: "2024-01-01T00:00:00Z",
          html_url: "https://example.test/r/11",
        }]),
      };
    }
    if (pathArg.includes("/issues/1/comments")) {
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify([{
          id: 12,
          user: null,
          body: "tombstone issue",
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
          html_url: "https://example.test/c/12",
        }]),
      };
    }
    if (pathArg.includes("/pulls/1/comments")) {
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify([{
          id: 13,
          user: null,
          body: "tombstone inline",
          path: "src/a.ts",
          line: 4,
          original_line: 4,
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
          html_url: "https://example.test/rc/13",
          pull_request_review_id: 11,
        }]),
      };
    }
    if (args.some((arg) => arg.includes("/reactions"))) {
      return { status: 200, headers: {}, bodyText: "[]" };
    }
    page += 1;
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  const transport = createGhCollectorGitHubTransport(runner);
  const ledger = createCollectorLedger({
    repository: {
      display: "A/B",
      canonical: "a/b",
      owner: "a",
      repo: "b",
    },
    prNumber: 1,
    manifest: {
      requests: [{
        id: "codex",
        requestBody: "Please review.",
      }],
      canonicalJson: "{}\n",
      digest: "d".repeat(64),
      sourcePath: "/tmp/requests.json",
    },
  });
  ledger.recordActivation(clock);
  await ledger.observe(transport, clock);
  const stored = ledger.allEvidence().filter((item) =>
    item.kind === "review" ||
    item.kind === "issue_comment" ||
    item.kind === "review_comment"
  );
  assert.equal(stored.length, 3);
  for (const row of stored) {
    assert.equal(row.authorLogin, undefined);
  }
  void page;
});

test("R6 non-null user shapes fail closed on review/issue comment/review comment", () => {
  const missingLogin = /GitHub payload missing user\.login/;
  const rejectShapes: unknown[] = [
    undefined, // user absent when field omitted via spread below
    { id: 7 },
    { login: 5 },
    "not-an-object",
  ];

  for (const user of rejectShapes) {
    const withUser = user === undefined ? {} : { user };

    assert.throws(
      () => normalizeReview({
        id: 1,
        ...withUser,
        state: "APPROVED",
        body: "x",
        commit_id: "abc",
        submitted_at: "2024-01-01T00:00:00Z",
        html_url: "https://example.test/r/1",
      }),
      missingLogin,
    );

    assert.throws(
      () => normalizeIssueComment({
        id: 2,
        ...withUser,
        body: "x",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        html_url: "https://example.test/c/2",
      }),
      missingLogin,
    );

    assert.throws(
      () => normalizeReviewComment({
        id: 3,
        ...withUser,
        body: "x",
        path: "src/a.ts",
        line: 1,
        original_line: 1,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        html_url: "https://example.test/rc/3",
        pull_request_review_id: 1,
      }),
      missingLogin,
    );
  }
});

test("R8 authenticated_user retained raw is login+id only", () => {
  const record = normalizeAuthenticatedUserEvidence(
    {
      login: "Collector-Bot",
      raw: {
        login: "Collector-Bot",
        id: 42,
        email: "secret@example.com",
        plan: { name: "pro" },
        company: "Acme",
      },
    },
    "2024-01-01T00:00:00Z",
  );
  assert.deepEqual(record.raw, { login: "collector-bot", id: 42 });
  assert.equal(
    JSON.stringify(record.raw).includes("secret@example.com"),
    false,
  );
  assert.equal(JSON.stringify(record.raw).includes("plan"), false);
});

test("2xx POST parse/normalization failures map to ambiguous_loss; non-2xx rejected", async () => {
  const shapes: Array<{ label: string; bodyText: string }> = [
    { label: "malformed JSON", bodyText: "not-json{" },
    { label: "truncated JSON", bodyText: '{"id":1,"user":{"login":' },
    {
      label: "missing required fields",
      bodyText: JSON.stringify({
        user: { login: "collector-bot" },
        body: "x",
      }),
    },
  ];
  for (const shape of shapes) {
    const runner = async () => ({
      status: 201,
      headers: {},
      bodyText: shape.bodyText,
    });
    const transport = createGhCollectorGitHubTransport(runner);
    const lost = await transport.createIssueComment({
      owner: "a",
      repo: "b",
      prNumber: 1,
      body: "hello",
    });
    assert.equal(lost.kind, "ambiguous_loss", shape.label);
  }

  const rejectedRunner = async () => ({
    status: 422,
    headers: {},
    bodyText: '{"message":"validation failed"}',
  });
  const rejectedTransport = createGhCollectorGitHubTransport(rejectedRunner);
  const rejected = await rejectedTransport.createIssueComment({
    owner: "a",
    repo: "b",
    prNumber: 1,
    body: "hello",
  });
  assert.equal(rejected.kind, "rejected");
});

test("2xx parse ambiguous_loss recovers via marker observe without second POST", async () => {
  let postCount = 0;
  let markerBody = "";
  const runner = async (
    args: string[],
    options?: { stdin?: string },
  ) => {
    const joined = args.join(" ");
    if (args.includes("POST") || /\s-X\s+POST\b/.test(` ${joined} `)) {
      postCount += 1;
      markerBody = options?.stdin ?? "";
      return {
        status: 201,
        headers: {},
        bodyText: "not-json{",
      };
    }
    const path = args.find((arg) => arg.startsWith("/")) ?? "";
    if (path === "/user") {
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify({ login: "collector-bot" }),
      };
    }
    if (path.includes("/pulls/1") && !path.includes("reviews") && !path.includes("comments")) {
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify({
          number: 1,
          state: "open",
          head: { sha: "head-a" },
          html_url: "https://github.com/acme/widgets/pull/1",
        }),
      };
    }
    if (path.includes("/reviews")) {
      return { status: 200, headers: {}, bodyText: "[]" };
    }
    if (path.includes("/issues/1/comments")) {
      if (postCount === 0) {
        return { status: 200, headers: {}, bodyText: "[]" };
      }
      const parsed = JSON.parse(markerBody) as { body: string };
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify([{
          id: 99,
          user: { login: "collector-bot" },
          body: parsed.body,
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
          html_url: "https://github.com/acme/widgets/pull/1#issuecomment-99",
        }]),
      };
    }
    if (path.includes("/pulls/1/comments") || path.includes("/reactions")) {
      return { status: 200, headers: {}, bodyText: "[]" };
    }
    throw new Error(`unexpected path ${path}`);
  };
  const transport = createGhCollectorGitHubTransport(runner);
  const ledger = createCollectorLedger({
    repository: {
      display: "Acme/Widgets",
      canonical: "acme/widgets",
      owner: "acme",
      repo: "widgets",
    },
    prNumber: 1,
    manifest: {
      requests: [{
        id: "codex",
        requestBody: "Please review.",
      }],
      canonicalJson: "{}\n",
      digest: "d".repeat(64),
      sourcePath: "/tmp/requests.json",
    },
  });
  const clock = clockAt("2024-01-01T00:00:00Z");
  ledger.recordActivation(clock);
  const first = await ledger.observe(transport, clock);
  const req = await ledger.request(
    { requestId: "codex", snapshotId: first.snapshot.snapshotId },
    transport,
    clock,
  ) as { status: string };
  assert.equal(req.status, "ambiguous_loss");
  assert.equal(postCount, 1);
  const second = await ledger.observe(transport, clock);
  const attempt = ledger.requestAttempts().find((item) => item.status === "recovered");
  assert.ok(attempt);
  assert.equal(attempt.recoverySnapshotId, second.snapshot.snapshotId);
  assert.equal(postCount, 1, "recovery must not repost");
});

function collectorLedgerFixture(digestChar = "f") {
  return createCollectorLedger({
    repository: {
      display: "Acme/Widgets",
      canonical: "acme/widgets",
      owner: "acme",
      repo: "widgets",
    },
    prNumber: 1,
    manifest: {
      requests: [{
        id: "codex",
        requestBody: "Please review.",
      }],
      canonicalJson: "{}\n",
      digest: digestChar.repeat(64),
      sourcePath: "/tmp/requests.json",
    },
  });
}

function hangUntilAbortedRunner(signal?: AbortSignal) {
  return new Promise<never>((_resolve, reject) => {
    if (signal === undefined) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function assertInProcessRequestAbort(abortReason: unknown) {
  const runner = async (
    args: string[],
    options?: { signal?: AbortSignal; stdin?: string },
  ) => {
    const joined = args.join(" ");
    if (args.includes("POST") || /\s-X\s+POST\b/.test(` ${joined} `)) {
      return hangUntilAbortedRunner(options?.signal);
    }
    const path = args.find((arg) => arg.startsWith("/")) ?? "";
    if (path === "/user") {
      return { status: 200, headers: {}, bodyText: JSON.stringify({ login: "collector-bot" }) };
    }
    if (path.includes("/pulls/1") && !path.includes("reviews") && !path.includes("comments")) {
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify({
          number: 1,
          state: "open",
          head: { sha: "head-a" },
          html_url: "https://github.com/acme/widgets/pull/1",
        }),
      };
    }
    if (path.includes("/reviews") || path.includes("/comments") || path.includes("/reactions")) {
      return { status: 200, headers: {}, bodyText: "[]" };
    }
    throw new Error(`unexpected path ${path}`);
  };
  const transport = createGhCollectorGitHubTransport(runner);
  const ledger = collectorLedgerFixture();
  const clock = clockAt("2024-01-01T00:00:00Z");
  ledger.recordActivation(clock);
  const first = await ledger.observe(transport, clock);
  const controller = new AbortController();
  const pending = ledger.request(
    { requestId: "codex", snapshotId: first.snapshot.snapshotId },
    transport,
    clock,
    controller.signal,
  );
  queueMicrotask(() => controller.abort(abortReason));
  await assert.rejects(
    () => pending,
    (error: unknown) => Object.is(error, abortReason),
  );
  const attempts = ledger.requestAttempts();
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.status, "started");
  await assert.rejects(
    () => ledger.request(
      { requestId: "codex", snapshotId: first.snapshot.snapshotId },
      transport,
      clock,
    ),
    /already used|process-local/i,
  );
}

test("request-path AbortSignal cancels hung POST without rejected attempt", async () => {
  // In-process reason-identity matrix; real child kill is owned by R11 hung-gh test.
  const tagged = Object.assign(new Error("deadline exceeded"), { ambiguousGhFailure: true });
  for (const reason of [new Error("request canceled"), "stop now", tagged] as const) {
    await assertInProcessRequestAbort(reason);
  }
});

test("non-aborted AbortError+ambiguousGhFailure remains ambiguous_loss", async () => {
  const tagged = Object.assign(new Error("gh api failed without parseable HTTP"), {
    name: "AbortError",
    ambiguousGhFailure: true,
  });
  const runner = async () => {
    throw tagged;
  };
  const transport = createGhCollectorGitHubTransport(runner);
  const result = await transport.createIssueComment({
    owner: "a",
    repo: "b",
    prNumber: 1,
    body: "hello",
  });
  assert.equal(result.kind, "ambiguous_loss");
});

test("createGhApiRunner stdin EPIPE settles once and createIssueComment is ambiguous_loss", async () => {
  // 1 MiB still exceeds typical pipe buffer; 32 MiB was pure cost.
  const fat = "x".repeat(1 << 20);
  const script = `#!/usr/bin/env bash
exit 1
`;
  await withPathGhStub(script, async () => {
    const runner = createGhApiRunner();
    let uncaught = 0;
    const onUncaught = () => {
      uncaught += 1;
    };
    process.on("uncaughtException", onUncaught);
    try {
      await assert.rejects(
        () =>
          runner(
            ["api", "--hostname", "github.com", "--include", "-X", "POST", "/repos/a/b/issues/1/comments", "--input", "-"],
            { stdin: fat },
          ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(
            (error as Error & { ambiguousGhFailure?: boolean }).ambiguousGhFailure,
            true,
          );
          return true;
        },
      );
      const transport = createGhCollectorGitHubTransport(runner);
      const result = await transport.createIssueComment({
        owner: "a",
        repo: "b",
        prNumber: 1,
        body: fat,
      });
      assert.equal(result.kind, "ambiguous_loss");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(uncaught, 0);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
});

test("R11 hung gh child aborted through runner settles once and kills child", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "ak-gh-hang-"));
  const pidFile = join(stateDir, "pid.txt");
  const script = `#!/usr/bin/env bash
set -euo pipefail
echo "$$" > ${JSON.stringify(pidFile)}
# exec so SIGTERM from the runner hits the hung process directly.
exec sleep 30
`;
  await withPathGhStub(script, async () => {
    const runner = createGhApiRunner();
    const controller = new AbortController();
    const pending = runner(
      ["api", "--hostname", "github.com", "--include", "-X", "GET", "/user"],
      { signal: controller.signal },
    );
    const waitForPid = async (): Promise<number> => {
      const deadline = Date.now() + 5_000;
      let delayMs = 5;
      while (Date.now() < deadline) {
        try {
          const pid = Number((await readFile(pidFile, "utf8")).trim());
          if (Number.isSafeInteger(pid) && pid > 0) return pid;
        } catch {
          // The child has not written its readiness marker yet.
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 100);
      }
      throw new Error("timed out waiting for hung child readiness marker");
    };
    const pid = await waitForPid();
    controller.abort(new Error("observe canceled"));
    await assert.rejects(() => pending, /abort|cancel/i);
    const killDeadline = Date.now() + 5_000;
    while (Date.now() < killDeadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("hung gh child must be killed");
  });
});

test("R11 observe abort through ledger does not certify a snapshot", async () => {
  // Ledger-state contract; hang is an in-process unresolved /user promise.
  const runner = async (args: string[], options?: { signal?: AbortSignal }) => {
    const path = args.find((arg) => arg.startsWith("/")) ?? "";
    if (path === "/user") return hangUntilAbortedRunner(options?.signal);
    return { status: 200, headers: {}, bodyText: "{}" };
  };
  const transport = createGhCollectorGitHubTransport(runner);
  const ledger = collectorLedgerFixture("e");
  const clock = clockAt("2024-01-01T00:00:00Z");
  ledger.recordActivation(clock);
  const controller = new AbortController();
  const pending = ledger.observe(transport, clock, controller.signal);
  queueMicrotask(() => controller.abort(new Error("observe canceled")));
  await assert.rejects(() => pending, /observe failed|abort|cancel/i);
  assert.equal(ledger.latestCompleteSnapshotId, undefined);
  assert.equal(ledger.allSnapshots().length, 0);
});
