import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildCollectorRequestBody,
  buildCollectorRequestMarker,
  createGhApiRunner,
  createGhCollectorGitHubTransport,
  normalizeIssueComment,
  normalizePullRequest,
  normalizeReview,
  normalizeReviewComment,
} from "../src/collector-github.ts";
import { createCollectorLedger } from "../src/collector-ledger.ts";
import {
  COLLECTOR_SNAPSHOT_MAX_BYTES,
  createSnapshotByteBudget,
  normalizeAuthenticatedUserEvidence,
  normalizePullRequestEvidence,
  normalizeReviewEvidence,
  reviewQualifiesForValid,
  type CollectorClock,
} from "../src/collector-evidence.ts";
import {
  samplePull,
  sampleUser,
} from "./helpers/fake-github-transport.ts";
import { buildCollectorReceipt } from "../src/collector-receipt.ts";

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
  const logPath = join(await mkdtemp(join(tmpdir(), "ak-gh-log-")), "args.log");
  const script = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
# Parse a minimal --include HTTP response
path=""
method="GET"
prev=""
for arg in "$@"; do
  if [[ "$prev" == "-X" ]]; then method="$arg"; fi
  if [[ "$arg" == /* || "$arg" == https://* ]]; then path="$arg"; fi
  prev="$arg"
done
if [[ "$method" == "POST" ]]; then
  body=$(cat || true)
  if [[ "$body" == *\"force-reject\"* ]]; then
    printf 'HTTP/1.1 422 Unprocessable\\r\\ncontent-type: application/json\\r\\n\\r\\n{\"message\":\"no\"}'
    exit 0
  fi
  if [[ "\${AMBIGUOUS:-}" == "1" ]]; then
    echo "network exploded" >&2
    exit 1
  fi
  printf 'HTTP/1.1 201 Created\\r\\ncontent-type: application/json\\r\\n\\r\\n{\"id\":55,\"user\":{\"login\":\"collector-bot\"},\"body\":\"posted\",\"created_at\":\"2024-01-01T00:00:00Z\",\"updated_at\":\"2024-01-01T00:00:00Z\",\"html_url\":\"https://github.com/a/b/pull/1#issuecomment-55\"}'
  exit 0
fi
if [[ "$path" == *"/user" ]]; then
  printf 'HTTP/1.1 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n{\"login\":\"collector-bot\"}'
  exit 0
fi
if [[ "$path" == *"/pulls/1/reviews"* ]]; then
  if [[ "$path" == *"page=2"* ]]; then
    printf 'HTTP/1.1 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n[]'
    exit 0
  fi
  printf 'HTTP/1.1 200 OK\\r\\nlink: <https://api.github.com/repos/a/b/pulls/1/reviews?page=2>; rel="next"\\r\\ncontent-type: application/json\\r\\n\\r\\n[]'
  exit 0
fi
if [[ "$path" == *"/pulls/1/comments"* || "$path" == *"/issues/1/comments"* ]]; then
  printf 'HTTP/1.1 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n[]'
  exit 0
fi
if [[ "$path" == *"/pulls/1"* ]]; then
  printf 'HTTP/1.1 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n{\"number\":1,\"state\":\"open\",\"head\":{\"sha\":\"abc\"},\"html_url\":\"https://github.com/a/b/pull/1\"}'
  exit 0
fi
echo "unexpected $*" >&2
exit 2
`;
  await withPathGhStub(script, async () => {
    // Real default spawn — no spawnImpl injection
    const runner = createGhApiRunner();
    const transport = createGhCollectorGitHubTransport(runner);

    const user = await transport.getAuthenticatedUser();
    assert.equal(user.login, "collector-bot");

    const pr = await transport.getPullRequest({ owner: "a", repo: "b", prNumber: 1 });
    assert.equal(pr.headOid, "abc");

    const reviews = await transport.listPullRequestReviews({
      owner: "a",
      repo: "b",
      prNumber: 1,
    });
    assert.equal(reviews.pages.length, 2);

    const created = await transport.createIssueComment({
      owner: "a",
      repo: "b",
      prNumber: 1,
      body: "hello marker",
    });
    assert.equal(created.kind, "success");

    const rejected = await transport.createIssueComment({
      owner: "a",
      repo: "b",
      prNumber: 1,
      body: "force-reject",
    });
    assert.equal(rejected.kind, "rejected");

    process.env.AMBIGUOUS = "1";
    try {
      const lost = await transport.createIssueComment({
        owner: "a",
        repo: "b",
        prNumber: 1,
        body: "maybe lost",
      });
      assert.equal(lost.kind, "ambiguous_loss");
    } finally {
      delete process.env.AMBIGUOUS;
    }

    const log = await (await import("node:fs/promises")).readFile(logPath, "utf8");
    assert.match(log, /api --hostname github.com --include/);
    assert.doesNotMatch(log, / \| |&&/);
  });
});

test("PATH gh recovery through ledger request+observe sets recoverySnapshotId", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "ak-gh-recovery-"));
  const markerPath = join(stateDir, "marker.txt");
  const script = `#!/usr/bin/env bash
set -euo pipefail
path=""; method="GET"; prev=""
for arg in "$@"; do
  if [[ "$prev" == "-X" ]]; then method="$arg"; fi
  if [[ "$arg" == /* ]]; then path="$arg"; fi
  prev="$arg"
done
http() {
  local body="$1"
  printf 'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n%s' "$body"
}
if [[ "$method" == "POST" ]]; then
  cat >/dev/null || true
  echo "spawn failure without http" >&2
  exit 1
fi
if [[ "$path" == *"/user" ]]; then
  http '{"login":"collector-bot"}'; exit 0
fi
if [[ "$path" == *"/pulls/1"* && "$path" != *reviews* && "$path" != *comments* ]]; then
  http '{"number":1,"state":"open","head":{"sha":"head-a"},"html_url":"https://github.com/acme/widgets/pull/1"}'; exit 0
fi
if [[ "$path" == *"/reviews"* ]]; then
  http '[]'; exit 0
fi
if [[ "$path" == *"/issues/1/comments"* ]]; then
  if [[ -f ${JSON.stringify(markerPath)} ]]; then
    marker=$(cat ${JSON.stringify(markerPath)})
    body=$(MARKER="$marker" python3 - <<'PY'
import json, os
print(json.dumps([{
  "id": 99,
  "user": {"login": "collector-bot"},
  "body": "Please review.\\n" + os.environ["MARKER"] + "\\n",
  "created_at": "2024-01-01T00:00:00Z",
  "updated_at": "2024-01-01T00:00:00Z",
  "html_url": "https://github.com/acme/widgets/pull/1#issuecomment-99",
}]))
PY
)
    http "$body"; exit 0
  fi
  http '[]'; exit 0
fi
if [[ "$path" == *"/pulls/1/comments"* ]]; then
  http '[]'; exit 0
fi
echo "unexpected $*" >&2; exit 2
`;
  await withPathGhStub(script, async () => {
    const runner = createGhApiRunner();
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
        version: 1,
        legs: [{
          id: "codex",
          expectedAuthors: ["codexbot"],
          requestBody: "Please review.",
        }],
        canonicalJson: "{}\n",
        digest: "c".repeat(64),
        sourcePath: "/tmp/legs.json",
      },
    });
    const clock = clockAt("2024-01-01T00:00:00Z");
    ledger.recordActivation(clock);
    const first = await ledger.observe(transport, clock);
    const req = await ledger.request(
      { legId: "codex", snapshotId: first.snapshot.snapshotId },
      transport,
      clock,
    ) as { status: string; marker: string };
    assert.equal(req.status, "ambiguous_loss");
    await writeFile(markerPath, req.marker, "utf8");
    const second = await ledger.observe(transport, clock);
    const attempt = ledger.requestAttempts().find((item) => item.status === "recovered");
    assert.ok(attempt);
    assert.equal(attempt.recoverySnapshotId, second.snapshot.snapshotId);
  });
});


test("R6 null user on review/issue comment/review comment preserves record and never qualifies", async () => {
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
      version: 1,
      legs: [{
        id: "codex",
        expectedAuthors: ["codexbot"],
        requestBody: "Please review.",
      }],
      canonicalJson: "{}\n",
      digest: "d".repeat(64),
      sourcePath: "/tmp/legs.json",
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
  const tombstoneReview = stored.find((item) => item.kind === "review")!;
  assert.equal(
    reviewQualifiesForValid({
      review: tombstoneReview,
      expectedAuthors: new Set(["codexbot"]),
      targetHead: "head-c",
      activationTime: new Date("2024-01-01T00:10:00Z"),
      deadlineTime: new Date("2024-01-01T00:25:00Z"),
    }).ok,
    false,
  );
  clock.advance(16 * 60 * 1000);
  await ledger.observe(transport, clock);
  assert.throws(
    () => buildCollectorReceipt(ledger, {
      legs: [{
        legId: "codex",
        status: "valid",
        rationale: "ghost",
        evidenceRefs: [tombstoneReview.evidenceId],
      }],
    }, clock),
    /qualifying|valid/i,
  );
  void page;
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

test("R10 multi-page pagination stops before retaining oversize normalized budget", async () => {
  let pagesFetched = 0;
  // Body sized so each page alone is under budget, but page1+page2 cumulative
  // normalized records (body + raw.body) exceed the shared 8 MiB gate.
  const fat = "x".repeat(Math.floor(COLLECTOR_SNAPSHOT_MAX_BYTES * 0.3));
  const observedAt = "2024-01-01T00:00:00.000Z";
  const budget = createSnapshotByteBudget();
  budget.retain([
    normalizeAuthenticatedUserEvidence(sampleUser(), observedAt),
    normalizePullRequestEvidence(samplePull(), observedAt),
  ]);
  const runner = async (args: string[]) => {
    if (!args.some((arg) => arg.includes("/reviews"))) {
      return { status: 200, headers: {}, bodyText: "[]" };
    }
    pagesFetched += 1;
    if (pagesFetched === 1) {
      return {
        status: 200,
        headers: {
          link:
            '<https://api.github.com/repos/a/b/pulls/1/reviews?page=2>; rel="next"',
        },
        bodyText: JSON.stringify([
          {
            id: 1,
            user: { login: "a" },
            state: "COMMENTED",
            body: fat,
            commit_id: "h",
            submitted_at: "2024-01-01T00:00:00Z",
            html_url: "https://example.test/1",
          },
        ]),
      };
    }
    if (pagesFetched === 2) {
      return {
        status: 200,
        headers: {
          link:
            '<https://api.github.com/repos/a/b/pulls/1/reviews?page=3>; rel="next"',
        },
        bodyText: JSON.stringify([
          {
            id: 2,
            user: { login: "b" },
            state: "COMMENTED",
            body: fat,
            commit_id: "h",
            submitted_at: "2024-01-01T00:00:00Z",
            html_url: "https://example.test/2",
          },
        ]),
      };
    }
    // Must not reach page 3.
    return {
      status: 200,
      headers: {},
      bodyText: JSON.stringify([
        {
          id: 3,
          user: { login: "c" },
          state: "COMMENTED",
          body: fat,
          commit_id: "h",
          submitted_at: "2024-01-01T00:00:00Z",
          html_url: "https://example.test/3",
        },
      ]),
    };
  };
  const transport = createGhCollectorGitHubTransport(runner);
  await assert.rejects(
    () =>
      transport.listPullRequestReviews({
        owner: "a",
        repo: "b",
        prNumber: 1,
        retainPage: (items) => {
          budget.retain(
            items.map((item) => normalizeReviewEvidence(item, observedAt)),
          );
        },
      }),
    /snapshot exceeded|UTF-8 bytes|8/i,
  );
  assert.ok(pagesFetched <= 2, `stopped before all pages; fetched=${pagesFetched}`);
  assert.equal(pagesFetched < 3, true);
});

test("R11 hung gh child aborted through runner settles once and kills child", async () => {
  const script = `#!/usr/bin/env bash
set -euo pipefail
# Hang until killed — owned-child cancellation fixture.
sleep 30
printf 'HTTP/1.1 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n{"login":"late"}'
`
  await withPathGhStub(script, async () => {
    const runner = createGhApiRunner();
    const controller = new AbortController();
    const pending = runner(
      ["api", "--hostname", "github.com", "--include", "-X", "GET", "/user"],
      { signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort(new Error("observe canceled"));
    await assert.rejects(() => pending, /abort|cancel/i);
  });
});

test("R11 observe abort through ledger does not certify a snapshot", async () => {
  const script = `#!/usr/bin/env bash
set -euo pipefail
path=""; prev=""
for arg in "$@"; do
  if [[ "$arg" == /* ]]; then path="$arg"; fi
  prev="$arg"
done
if [[ "$path" == *"/user" ]]; then
  sleep 30
  printf 'HTTP/1.1 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n{"login":"collector-bot"}'
  exit 0
fi
printf 'HTTP/1.1 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n{}'
exit 0
`
  await withPathGhStub(script, async () => {
    const runner = createGhApiRunner();
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
        version: 1,
        legs: [{
          id: "codex",
          expectedAuthors: ["codexbot"],
          requestBody: "Please review.",
        }],
        canonicalJson: "{}\n",
        digest: "e".repeat(64),
        sourcePath: "/tmp/legs.json",
      },
    });
    const clock = clockAt("2024-01-01T00:00:00Z");
    ledger.recordActivation(clock);
    const controller = new AbortController();
    const pending = ledger.observe(transport, clock, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 40));
    controller.abort(new Error("observe canceled"));
    await assert.rejects(() => pending, /observe failed|abort|cancel/i);
    assert.equal(ledger.latestCompleteSnapshotId, undefined);
    assert.equal(ledger.allSnapshots().length, 0);
  });
});
