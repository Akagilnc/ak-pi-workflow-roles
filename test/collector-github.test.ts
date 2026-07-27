import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCollectorRequestBody,
  buildCollectorRequestMarker,
  createGhCollectorGitHubTransport,
  normalizePullRequest,
  normalizeReview,
  type GhApiResponse,
} from "../src/collector-github.ts";

test("production transport uses gh api --hostname github.com argument vector", async () => {
  const calls: string[][] = [];
  const runner = async (args: string[]): Promise<GhApiResponse> => {
    calls.push(args);
    if (args.includes("/user")) {
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify({ login: "collector-bot" }),
      };
    }
    if (args.some((arg) => arg.includes("/pulls/1") && !arg.includes("reviews"))) {
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

test("request marker is deterministic for digest/leg/head", () => {
  const marker = buildCollectorRequestMarker({
    manifestDigest: "abcdef0123456789",
    legId: "codex",
    headOid: "head1",
  });
  assert.equal(
    marker,
    "<!-- ak-collector:v1 manifest=abcdef012345 leg=codex head=head1 -->",
  );
  const built = buildCollectorRequestBody({
    configuredBody: "Please review.",
    manifestDigest: "abcdef0123456789",
    legId: "codex",
    headOid: "head1",
  });
  assert.equal(built.body.startsWith("Please review.\n"), true);
  assert.ok(built.body.includes(marker));
});

test("final-page HTTP 429 fails pagination loudly", async () => {
  let page = 0;
  const runner = async (args: string[]): Promise<GhApiResponse> => {
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
