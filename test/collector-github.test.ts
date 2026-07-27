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
  normalizePullRequest,
  normalizeReview,
} from "../src/collector-github.ts";
import { createCollectorLedger } from "../src/collector-ledger.ts";
import type { CollectorClock } from "../src/collector-evidence.ts";

function clockAt(startWall: string): CollectorClock {
  let mono = 0;
  let wall = new Date(startWall);
  return {
    wallNow: () => new Date(wall),
    monoNow: () => mono,
    async sleep(ms) {
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
