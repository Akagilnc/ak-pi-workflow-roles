import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { withPrimaryAwareCleanup, withTempRoot } from "../helpers/primary-aware-cleanup.ts";

import {
  createGhApiRunner,
  createGhCollectorGitHubTransport,
  createGhIssueSoftFetcher,
  normalizeIssueComment,
  normalizeReview,
  normalizeReviewComment,
  type GhApiRunner,
} from "../../src/collector-github.ts";
import { createCollectorLedger } from "../../src/collector-ledger.ts";
import {
  normalizePullRequestEvidence,
  normalizeReviewEvidence,
  type CollectorClock,
} from "../../src/collector-evidence.ts";
import {
  samplePull,
  sampleReview,
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
  return withTempRoot("ak-gh-bin-", async (binDir) => {
    const ghPath = join(binDir, "gh");
    await writeFile(ghPath, scriptBody, "utf8");
    await chmod(ghPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    return withPrimaryAwareCleanup(
      () => run(binDir),
      async () => {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      },
    );
  });
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
  ledger.openWaitWindow(clock);
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
  await withTempRoot("ak-gh-log-", async (logRoot) => {
    const logPath = join(logRoot, "args.log");
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
});

test("createGhIssueSoftFetcher softens tracker/gh-unavailable only; post-start failures propagate", async () => {
  const calls: string[][] = [];
  const seenSignals: Array<AbortSignal | undefined> = [];
  const runner: GhApiRunner = async (args, options) => {
    calls.push([...args]);
    seenSignals.push(options?.signal);
    if (args.includes("repos/Acme/widgets/issues/343")) {
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify({ body: "issue body bytes", body_null_ok: true }),
      };
    }
    if (args.includes("repos/Acme/widgets/issues/777")) {
      // Issues endpoint 200 PR payload — pull_request marker must soft-unavailable, not Spec body.
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify({
          body: "PR description must not become issue Spec",
          pull_request: {
            url: "https://api.github.com/repos/Acme/widgets/pulls/777",
          },
        }),
      };
    }
    if (args.includes("repos/Acme/widgets/issues/778")) {
      // Own-key presence alone discriminates — null marker value is still a PR payload.
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify({
          body: "null pull_request marker must not become issue Spec",
          pull_request: null,
        }),
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
    if (args.includes("repos/Acme/widgets/issues/503")) {
      // gh binary missing / process never starts → authorized soft unavailable (#343).
      throw Object.assign(new Error("spawn gh ENOENT"), {
        code: "ENOENT",
        syscall: "spawn",
        path: "gh",
      });
    }
    if (args.includes("repos/Acme/widgets/issues/408")) {
      // Hung gh cancelled via invocation AbortSignal — keep abort cause (not soft unavailable).
      return hangUntilAbortedRunner(options?.signal);
    }
    // Generic implementation failure (gh did not fail-to-start) keeps true cause.
    throw new Error("implementation boom");
  };
  const fetchIssue = createGhIssueSoftFetcher(runner);
  const controller = new AbortController();
  const ok = await fetchIssue({
    owner: "Acme",
    repo: "widgets",
    ticketNumber: 343,
    signal: controller.signal,
  });
  assert.deepEqual(ok, { body: "issue body bytes" });
  assert.equal(
    calls[0]?.join(" ").includes("api --hostname github.com --include -X GET repos/Acme/widgets/issues/343"),
    true,
  );
  // Invocation AbortSignal is forwarded into GhApiRunner options (existing wheel only).
  assert.equal(seenSignals[0], controller.signal);

  // PR payload on issues endpoint → authorized soft unavailable (not adopted as issue Spec).
  const prPayload = await fetchIssue({ owner: "Acme", repo: "widgets", ticketNumber: 777 });
  assert.equal(prPayload, undefined);

  // pull_request key present with null value → same soft unavailable (presence, not content).
  const prNullMarker = await fetchIssue({ owner: "Acme", repo: "widgets", ticketNumber: 778 });
  assert.equal(prNullMarker, undefined);

  // Issue not found / tracker non-success → authorized soft unavailable.
  const missing = await fetchIssue({ owner: "Acme", repo: "widgets", ticketNumber: 404 });
  assert.equal(missing, undefined);

  // Tagged tracker-unreachable transport → authorized soft unavailable (not a catch-all).
  const unreachable = await fetchIssue({ owner: "Acme", repo: "widgets", ticketNumber: 401 });
  assert.equal(unreachable, undefined);

  // gh process cannot start (ENOENT) → authorized soft unavailable into degrade chain.
  const noGh = await fetchIssue({ owner: "Acme", repo: "widgets", ticketNumber: 503 });
  assert.equal(noGh, undefined);

  // Unrecognized runner/implementation exception keeps true cause — must not wash into unavailable.
  await assert.rejects(
    () => fetchIssue({ owner: "Acme", repo: "widgets", ticketNumber: 500 }),
    (error: unknown) => error instanceof Error && error.message === "implementation boom",
  );

  // Cancellation via forwarded signal keeps true abort cause — not washed into unavailable.
  const hangController = new AbortController();
  const abortReason = new Error("issue-fetch canceled");
  const pending = fetchIssue({
    owner: "Acme",
    repo: "widgets",
    ticketNumber: 408,
    signal: hangController.signal,
  });
  queueMicrotask(() => hangController.abort(abortReason));
  await assert.rejects(
    () => pending,
    (error: unknown) => Object.is(error, abortReason),
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
    bodyText: JSON.stringify({ body: 1 }),
  });
  await assert.rejects(
    () =>
      createGhIssueSoftFetcher(badShapeRunner)({
        owner: "Acme",
        repo: "widgets",
        ticketNumber: 1,
      }),
    /body must be string or null/,
  );

  // null body projects to empty string (former gh --jq body // "").
  const nullBodyRunner: GhApiRunner = async () => ({
    status: 200,
    headers: {},
    bodyText: JSON.stringify({ body: null }),
  });
  const empty = await createGhIssueSoftFetcher(nullBodyRunner)({
    owner: "Acme",
    repo: "widgets",
    ticketNumber: 1,
  });
  assert.deepEqual(empty, { body: "" });
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
  await withTempRoot("ak-gh-hang-", async (stateDir) => {
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
  // Typed fatal latch — do not lock model-facing reason prose (ADR 0073 / #495).
  await assert.rejects(
    () => pending,
    (error: unknown) =>
      error instanceof Error &&
      (error as { collectorFatal?: unknown }).collectorFatal === true,
  );
  assert.equal(ledger.fatal, true);
  assert.equal(ledger.latestCompleteSnapshotId, undefined);
  assert.equal(ledger.allSnapshots().length, 0);
});

test("#677 role-decided request body posts without caller request-manifest", async () => {
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-role-1" }),
    reviews: [],
    issueComments: [],
    reviewComments: [],
  });
  const ledger = createCollectorLedger({
    repository: {
      display: "Acme/Widgets",
      canonical: "acme/widgets",
      owner: "acme",
      repo: "widgets",
    },
    prNumber: 1,
    manifest: emptyCollectorManifest(),
  });
  const clock = clockAt("2024-01-01T00:00:00Z");
  ledger.recordActivation(clock);
  const observed = await ledger.observe(transport, clock);
  const result = await ledger.request(
    {
      requestId: "coderabbit-review",
      snapshotId: observed.snapshot.snapshotId,
      body: "@coderabbitai review",
    },
    transport,
    clock,
  ) as { status: string; requestId: string; marker: string };
  assert.equal(result.status, "succeeded");
  assert.equal(result.requestId, "coderabbit-review");
  assert.equal(transport.calls.create, 1);
  assert.equal(transport.state.issueComments.length, 1);
  const posted = transport.state.issueComments[0]!;
  assert.equal(posted.body.includes("@coderabbitai review"), true);
  assert.equal(posted.body.includes(result.marker), true);

  // Same HEAD + same requestId must not double-fire (auto-review already covered).
  await assert.rejects(
    () => ledger.request(
      {
        requestId: "coderabbit-review",
        snapshotId: observed.snapshot.snapshotId,
        body: "@coderabbitai review",
      },
      transport,
      clock,
    ),
  );
  assert.equal(transport.calls.create, 1);

  // Whitespace variants collapse to the same stable identity — no second POST.
  await assert.rejects(
    () => ledger.request(
      {
        requestId: "  coderabbit-review  ",
        snapshotId: observed.snapshot.snapshotId,
        body: "@coderabbitai review",
      },
      transport,
      clock,
    ),
  );
  assert.equal(transport.calls.create, 1);

  // Distinct task id under the same account remains independently requestable.
  const other = await ledger.request(
    {
      requestId: "coderabbit-full",
      snapshotId: observed.snapshot.snapshotId,
      body: "@coderabbitai full review",
    },
    transport,
    clock,
  ) as { status: string; requestId: string };
  assert.equal(other.status, "succeeded");
  assert.equal(other.requestId, "coderabbit-full");
  assert.equal(transport.calls.create, 2);
});

test("#677 non-OPEN snapshot still bounces role-decided request", async () => {
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-closed", state: "CLOSED" }),
    reviews: [],
    issueComments: [],
    reviewComments: [],
  });
  const ledger = createCollectorLedger({
    repository: {
      display: "Acme/Widgets",
      canonical: "acme/widgets",
      owner: "acme",
      repo: "widgets",
    },
    prNumber: 1,
    manifest: emptyCollectorManifest(),
  });
  const clock = clockAt("2024-01-01T00:00:00Z");
  ledger.recordActivation(clock);
  const observed = await ledger.observe(transport, clock);
  assert.equal(observed.snapshot.prState, "CLOSED");
  await assert.rejects(
    () => ledger.request(
      {
        requestId: "codex-review",
        snapshotId: observed.snapshot.snapshotId,
        body: "@codex review",
      },
      transport,
      clock,
    ),
    (error: unknown) =>
      error instanceof Error && error.name === "CollectorNonOpenRequestError",
  );
  assert.equal(transport.calls.create, 0);
});

/**
 * #678 D4: wait window starts at a work step, default 10 minutes, caller-configurable.
 * Controllable clock only — no real sleep.
 */
test("#678 wait window: default 10m from open step; config changes duration; activation alone is not the window", async () => {
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-wait", state: "OPEN" }),
    reviews: [],
    issueComments: [],
    reviewComments: [],
  });
  const baseConfig = {
    repository: {
      display: "Acme/Widgets",
      canonical: "acme/widgets",
      owner: "acme",
      repo: "widgets",
    },
    prNumber: 1,
    manifest: emptyCollectorManifest(),
  };

  // Session activation alone must not open the wait window (old F040 deleted).
  {
    const clock = clockAt("2026-01-01T00:00:00.000Z");
    const ledger = createCollectorLedger(baseConfig);
    ledger.recordActivation(clock);
    assert.equal(ledger.activationRecorded, true);
    assert.equal(ledger.activationTime, undefined);
    assert.equal(ledger.deadlineTime, undefined);
    // Prep observe is legal before the wait window opens.
    const observed = await ledger.observe(transport, clock);
    assert.equal(observed.snapshot.headOid, "head-wait");
  }

  // Default window: open at work step → +10 minutes.
  {
    const clock = clockAt("2026-01-01T00:00:00.000Z");
    const ledger = createCollectorLedger(baseConfig);
    ledger.recordActivation(clock);
    clock.advance(90_000); // prep work after activation must not count
    ledger.openWaitWindow(clock);
    assert.equal(ledger.activationTime?.toISOString(), "2026-01-01T00:01:30.000Z");
    assert.equal(ledger.deadlineTime?.toISOString(), "2026-01-01T00:11:30.000Z");
  }

  // Caller config changes the actual wait duration without code edits.
  {
    const clock = clockAt("2026-01-01T00:00:00.000Z");
    const ledger = createCollectorLedger({ ...baseConfig, waitWindowMs: 120_000 });
    ledger.recordActivation(clock);
    ledger.openWaitWindow(clock, { startedAt: new Date("2026-01-01T00:00:00.000Z") });
    assert.equal(ledger.deadlineTime?.toISOString(), "2026-01-01T00:02:00.000Z");
  }

  // New-PR path: window starts from creation success time, not historical later wall clock.
  {
    const clock = clockAt("2026-01-01T00:05:00.000Z");
    const ledger = createCollectorLedger(baseConfig);
    ledger.recordActivation(clock);
    ledger.openWaitWindow(clock, { startedAt: new Date("2026-01-01T00:00:00.000Z") });
    assert.equal(ledger.activationTime?.toISOString(), "2026-01-01T00:00:00.000Z");
    assert.equal(ledger.deadlineTime?.toISOString(), "2026-01-01T00:10:00.000Z");
  }

  // D6: reopening after PR update does not reset the window.
  {
    const clock = clockAt("2026-01-01T00:00:00.000Z");
    const ledger = createCollectorLedger(baseConfig);
    ledger.recordActivation(clock);
    ledger.openWaitWindow(clock);
    const firstStart = ledger.activationTime?.toISOString();
    const firstDeadline = ledger.deadlineTime?.toISOString();
    clock.advance(60_000);
    ledger.openWaitWindow(clock);
    assert.equal(ledger.activationTime?.toISOString(), firstStart);
    assert.equal(ledger.deadlineTime?.toISOString(), firstDeadline);
  }
});

test("#678 wait window: cutoff blocks new requests; timeout still seals materials; early complete before deadline", async () => {
  const head = "a".repeat(40);
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: head, state: "OPEN" }),
    reviews: [sampleReview({
      id: 7,
      userLogin: "bot[bot]",
      body: "finding",
      commitId: head,
      submittedAt: "2026-01-01T00:00:30.000Z",
      raw: { id: 7, user: { login: "bot[bot]", id: 1, type: "Bot" } },
    })],
    issueComments: [],
    reviewComments: [],
  });
  const baseConfig = {
    repository: {
      display: "Acme/Widgets",
      canonical: "acme/widgets",
      owner: "acme",
      repo: "widgets",
    },
    prNumber: 1,
    manifest: emptyCollectorManifest(),
  };

  // Early complete: open window, observe materials, seal before deadline — no real sleep.
  {
    const clock = clockAt("2026-01-01T00:00:00.000Z");
    const ledger = createCollectorLedger({ ...baseConfig, waitWindowMs: 60_000 });
    ledger.recordActivation(clock);
    ledger.openWaitWindow(clock);
    await ledger.observe(transport, clock);
    const receipt = buildCollectorReceipt(ledger, {}, clock);
    assert.equal(receipt.activationTime, "2026-01-01T00:00:00.000Z");
    assert.equal(receipt.deadlineTime, "2026-01-01T00:01:00.000Z");
    assert.equal(receipt.groups.length >= 1, true);
    assert.equal(receipt.prState, "OPEN");
  }

  // After cutoff: request is refused; final observe + seal still keeps materials.
  {
    const clock = clockAt("2026-01-01T00:00:00.000Z");
    const ledger = createCollectorLedger({ ...baseConfig, waitWindowMs: 1_000 });
    ledger.recordActivation(clock);
    ledger.openWaitWindow(clock);
    const first = await ledger.observe(transport, clock);
    clock.advance(2_000);
    await assert.rejects(
      () => ledger.request(
        {
          requestId: "late-trigger",
          snapshotId: first.snapshot.snapshotId,
          body: "@bot review",
        },
        transport,
        clock,
      ),
      /资格截止|截止/,
    );
    assert.equal(transport.calls.create, 0);
    await ledger.observe(transport, clock);
    const receipt = buildCollectorReceipt(ledger, {
      unfinishedReasons: ["等待窗届满，无新 bot 回复"],
    }, clock);
    assert.deepEqual(receipt.unfinishedReasons, ["等待窗届满，无新 bot 回复"]);
    assert.equal(receipt.groups.length >= 1, true);
  }

  // Wait sleeps only remaining window (controllable clock; no wall 10 minutes).
  {
    const clock = clockAt("2026-01-01T00:00:00.000Z");
    const ledger = createCollectorLedger({ ...baseConfig, waitWindowMs: 5_000 });
    ledger.recordActivation(clock);
    ledger.openWaitWindow(clock);
    clock.advance(3_000);
    const waited = await ledger.wait({ durationMs: 60_000 }, clock) as {
      effectiveMs: number;
      cutoffReached: boolean;
      remainingMsAfter: number;
    };
    assert.equal(waited.effectiveMs, 2_000);
    assert.equal(waited.cutoffReached, true);
    assert.equal(waited.remainingMsAfter, 0);
  }

  // Wait without an explicit work-step open must not invent "now" as the start.
  {
    const clock = clockAt("2026-01-01T00:00:00.000Z");
    const ledger = createCollectorLedger({ ...baseConfig, waitWindowMs: 60_000 });
    ledger.recordActivation(clock);
    await assert.rejects(
      () => ledger.wait({ durationMs: 1_000 }, clock),
      (error: unknown) =>
        error instanceof Error &&
        error.name === "CollectorWaitWindowClosedError" &&
        error.message.includes("开启等待窗"),
    );
    assert.equal(ledger.activationTime, undefined);
    assert.equal(ledger.deadlineTime, undefined);
  }

  // New-PR path through observe → open with prCreatedAt (create success), not wall-now after prep.
  {
    const createdAt = "2026-01-01T00:00:00.000Z";
    const transportWithCreate = createFakeGitHubTransport({
      user: sampleUser(),
      pullRequest: samplePull({
        headOid: head,
        state: "OPEN",
        createdAt,
        updatedAt: "2026-01-01T00:04:00.000Z",
      }),
      reviews: [],
      issueComments: [],
      reviewComments: [],
    });
    const clock = clockAt("2026-01-01T00:05:00.000Z");
    const ledger = createCollectorLedger({ ...baseConfig, waitWindowMs: 600_000 });
    ledger.recordActivation(clock);
    const observed = await ledger.observe(transportWithCreate, clock);
    assert.equal(observed.snapshot.prCreatedAt, createdAt);
    assert.equal(observed.contextView.prCreatedAt, createdAt);
    // Evidence version clock stays updatedAt; create success is only the typed prCreatedAt anchor.
    const prEvidence = ledger.allEvidence().find((row) => row.kind === "pull_request");
    assert.equal(prEvidence?.authoritativeTime, "2026-01-01T00:04:00.000Z");
    // Role uses create-success time from observe, not current wall after prep/trigger.
    ledger.openWaitWindow(clock, { startedAt: new Date(observed.snapshot.prCreatedAt!) });
    assert.equal(ledger.activationTime?.toISOString(), createdAt);
    assert.equal(ledger.deadlineTime?.toISOString(), "2026-01-01T00:10:00.000Z");
  }
});
