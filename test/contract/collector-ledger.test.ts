import assert from "node:assert/strict";
import test from "node:test";

import {
  applyEvidenceVersionHistory,
  assignWindowRelations,
  COLLECTOR_RECEIPT_MAX_BYTES,
  COLLECTOR_SNAPSHOT_MAX_BYTES,
  computeWindowRelation,
  measureNormalizedBytes,
  normalizeAuthenticatedUserEvidence,
  normalizeIssueCommentEvidence,
  normalizePullRequestEvidence,
  normalizeReviewCommentEvidence,
  normalizeReviewEvidence,
  type CollectorClock,
} from "../../src/collector-evidence.ts";
import {
  classifyCollectorBatch,
  COLLECTOR_OBSERVE_TOOL,
  COLLECTOR_OUTPUT_TOOL,
  COLLECTOR_REQUEST_TOOL,
  COLLECTOR_WAIT_TOOL,
  createCollectorLedger,
} from "../../src/collector-ledger.ts";
import {
  buildCollectorRequestMarker,
  createGhCollectorGitHubTransport,
} from "../../src/collector-github.ts";
import { buildCollectorReceipt } from "../../src/collector-receipt.ts";
import {
  createFakeGitHubTransport,
  sampleIssueComment,
  samplePull,
  sampleReview,
  sampleReviewComment,
  sampleUser,
} from "../helpers/fake-github-transport.ts";

function manifest(legs: Array<{
  id: string;
  expectedAuthors: readonly string[];
  requestBody?: string;
}> = [{
  id: "codex",
  expectedAuthors: ["codexbot"],
  requestBody: "Please review.",
}]) {
  return {
    version: 1 as const,
    legs,
    canonicalJson: "{\"version\":1}\n",
    digest: "a".repeat(64),
    sourcePath: "/tmp/legs.json",
  };
}

function config() {
  return {
    repository: {
      display: "Acme/Widgets",
      canonical: "acme/widgets",
      owner: "acme",
      repo: "widgets",
    },
    prNumber: 7,
    manifest: manifest(),
  };
}

function clockAt(startWall: string, startMono = 0): CollectorClock & {
  advance(ms: number): void;
  setWall(iso: string): void;
} {
  let mono = startMono;
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
    setWall(iso) {
      wall = new Date(iso);
    },
  };
}

test("windowRelation matrix uses authoritative times only", () => {
  const activation = new Date("2024-01-01T00:10:00Z");
  const deadline = new Date("2024-01-01T00:25:00Z");
  assert.equal(
    computeWindowRelation("2024-01-01T00:00:00Z", activation, deadline),
    "before",
  );
  assert.equal(
    computeWindowRelation("2024-01-01T00:10:00Z", activation, deadline),
    "within",
  );
  assert.equal(
    computeWindowRelation("2024-01-01T00:25:00Z", activation, deadline),
    "within",
  );
  assert.equal(
    computeWindowRelation("2024-01-01T00:25:01Z", activation, deadline),
    "after",
  );
  assert.equal(computeWindowRelation(null, activation, deadline), "uncertain");
  assert.equal(computeWindowRelation("bogus", activation, deadline), "uncertain");
});

test("batch gate permits one operational or sole output and latches mixed/multiple", () => {
  const ledger = createCollectorLedger(config());
  const ok = ledger.evaluateBatch([
    { type: "toolCall", id: "1", name: COLLECTOR_OBSERVE_TOOL, arguments: {} },
  ]);
  assert.equal(ok.allow, true);
  if (ok.allow) {
    assert.deepEqual(ok.permitted, {
      kind: "operational",
      callId: "1",
      name: COLLECTOR_OBSERVE_TOOL,
    });
  }
  assert.equal(
    ledger.evaluateBatch([
      { type: "toolCall", id: "1", name: COLLECTOR_OBSERVE_TOOL, arguments: {} },
      { type: "toolCall", id: "2", name: COLLECTOR_REQUEST_TOOL, arguments: {
        legId: "codex",
        snapshotId: "s",
      } },
    ]).allow,
    false,
  );
  assert.equal(ledger.fatal, true);

  const ledger2 = createCollectorLedger(config());
  assert.equal(
    ledger2.evaluateBatch([
      { type: "toolCall", id: "1", name: COLLECTOR_OBSERVE_TOOL, arguments: {} },
      { type: "toolCall", id: "2", name: COLLECTOR_OUTPUT_TOOL, arguments: {
        legs: [{
          legId: "codex",
          status: "missing",
          rationale: "x",
          evidenceRefs: ["s"],
        }],
      } },
    ]).allow,
    false,
  );

  const ledger3 = createCollectorLedger(config());
  assert.equal(
    ledger3.evaluateBatch([
      { type: "toolCall", id: "1", name: COLLECTOR_OUTPUT_TOOL, arguments: {
        legs: [{
          legId: "codex",
          status: "missing",
          rationale: "x",
          evidenceRefs: ["s"],
        }],
      } },
    ]).allow,
    false,
  );
});

test("classifier rejects unknown, malformed, and schema-invalid without role", () => {
  assert.equal(
    classifyCollectorBatch([
      { type: "toolCall", id: "1", name: COLLECTOR_OBSERVE_TOOL, arguments: {} },
      { type: "toolCall", id: "2", name: "unknown_tool", arguments: {} },
    ], { outputAccepted: false, hasCompletedOperationalOrSnapshot: true }).allow,
    false,
  );
  assert.equal(
    classifyCollectorBatch([
      { type: "toolCall", id: 1 as unknown as string, name: COLLECTOR_OBSERVE_TOOL },
    ], { outputAccepted: false, hasCompletedOperationalOrSnapshot: false }).allow,
    false,
  );
  assert.equal(
    classifyCollectorBatch([
      { type: "toolCall", id: "1", name: COLLECTOR_OBSERVE_TOOL, arguments: { extra: true } },
    ], { outputAccepted: false, hasCompletedOperationalOrSnapshot: false }).allow,
    false,
  );
  assert.equal(
    classifyCollectorBatch([
      {
        type: "toolCall",
        id: "1",
        name: COLLECTOR_OBSERVE_TOOL,
        arguments: {},
      },
      {
        type: "toolCall",
        id: "2",
        name: COLLECTOR_WAIT_TOOL,
        arguments: { durationMs: "nope" },
      },
    ], { outputAccepted: false, hasCompletedOperationalOrSnapshot: false }).allow,
    false,
  );
});

test("beginOperational requires exact permitted batch match", () => {
  const bare = createCollectorLedger(config());
  assert.throws(
    () => bare.beginOperational(COLLECTOR_OBSERVE_TOOL, "x"),
    /permitted|batch/i,
  );

  const ledger = createCollectorLedger(config());
  const decision = ledger.evaluateBatch([
    { type: "toolCall", id: "obs-1", name: COLLECTOR_OBSERVE_TOOL, arguments: {} },
  ]);
  assert.equal(decision.allow, true);
  assert.throws(
    () => ledger.beginOperational(COLLECTOR_OBSERVE_TOOL, "wrong-id"),
    /permitted|batch/i,
  );

  const ledger2 = createCollectorLedger(config());
  assert.equal(
    ledger2.evaluateBatch([
      { type: "toolCall", id: "obs-1", name: COLLECTOR_OBSERVE_TOOL, arguments: {} },
    ]).allow,
    true,
  );
  assert.throws(
    () => ledger2.beginOperational(COLLECTOR_WAIT_TOOL, "obs-1"),
    /permitted|batch/i,
  );

  const ledger3 = createCollectorLedger(config());
  assert.equal(
    ledger3.evaluateBatch([
      { type: "toolCall", id: "obs-1", name: COLLECTOR_OBSERVE_TOOL, arguments: {} },
    ]).allow,
    true,
  );
  ledger3.beginOperational(COLLECTOR_OBSERVE_TOOL, "obs-1");
  ledger3.beginOperational(COLLECTOR_OBSERVE_TOOL, "obs-1"); // idempotent
});

test("observe stores immutable snapshot and recovers authenticated marker after ambiguous loss", async () => {
  const clock = clockAt("2024-01-01T00:00:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser("collector-bot"),
    pullRequest: samplePull({ headOid: "head-a" }),
    reviews: [],
    issueComments: [],
    reviewComments: [],
  });
  const ledger = createCollectorLedger(config());
  ledger.recordActivation(clock);
  const first = await ledger.observe(transport, clock);
  assert.equal(first.snapshot.complete, true);
  assert.equal(first.snapshot.headOid, "head-a");
  assert.ok(first.snapshot.completedAt);
  assert.equal(typeof first.snapshot.completedMono, "number");
  // terminal PR reread: two getPullRequest calls per observe
  assert.equal(transport.calls.pull, 2);

  transport.state.createComment = async () => ({
    kind: "ambiguous_loss",
    diagnostics: "response lost",
  });
  const requestResult = await ledger.request(
    { legId: "codex", snapshotId: first.snapshot.snapshotId },
    transport,
    clock,
  ) as { status: string; marker: string };
  assert.equal(requestResult.status, "ambiguous_loss");
  assert.equal(ledger.unresolvedTransportFailure, true);
  assert.equal(ledger.mutationGeneration, 1);
  assert.equal(ledger.observedGeneration, 0);

  const marker = requestResult.marker;
  transport.state.issueComments = [
    sampleIssueComment({
      id: 99,
      userLogin: "collector-bot",
      body: `Please review.\n${marker}\n`,
    }),
  ];
  const recovered = await ledger.observe(transport, clock);
  assert.equal(ledger.unresolvedTransportFailure, false);
  const attempt = ledger.requestAttempts().find((item) => item.status === "recovered");
  assert.ok(attempt);
  assert.equal(attempt.recoverySnapshotId, recovered.snapshot.snapshotId);
  assert.equal(ledger.observedGeneration, ledger.mutationGeneration);
});

test("request enforces process-local once, observe-only, marker body, and cutoff", async () => {
  const clock = clockAt("2024-01-01T00:00:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser("collector-bot"),
    pullRequest: samplePull({ headOid: "head-a" }),
    reviews: [],
    issueComments: [],
    reviewComments: [],
  });
  const ledger = createCollectorLedger({
    ...config(),
    manifest: manifest([
      { id: "codex", expectedAuthors: ["codexbot"], requestBody: "Please review." },
      { id: "watch", expectedAuthors: ["watcher"] },
    ]),
  });
  ledger.recordActivation(clock);
  const { snapshot } = await ledger.observe(transport, clock);

  await assert.rejects(
    () => ledger.request(
      { legId: "watch", snapshotId: snapshot.snapshotId },
      transport,
      clock,
    ),
    /observe-only/,
  );

  const ok = await ledger.request(
    { legId: "codex", snapshotId: snapshot.snapshotId },
    transport,
    clock,
  ) as { status: string; marker: string; body?: string };
  assert.equal(ok.status, "succeeded");
  assert.match(ok.marker, /ak-collector:v1/);
  const expectedMarker = buildCollectorRequestMarker({
    manifestDigest: ledger.config.manifest.digest,
    legId: "codex",
    headOid: "head-a",
  });
  assert.equal(ok.marker, expectedMarker);
  assert.equal(transport.calls.create, 1);

  await assert.rejects(
    () => ledger.request(
      { legId: "codex", snapshotId: snapshot.snapshotId },
      transport,
      clock,
    ),
    /process-local|already/,
  );

  clock.advance(15 * 60 * 1000);
  await assert.rejects(
    () => ledger.request(
      { legId: "codex", snapshotId: snapshot.snapshotId },
      transport,
      clock,
    ),
    /cutoff/,
  );
  assert.equal(ledger.finalObservationRequired, true);
});

test("wait caps a single call to five minutes when remaining eligibility is ample", async () => {
  const clock = clockAt("2024-01-01T00:00:00Z");
  const ledger = createCollectorLedger(config());
  ledger.recordActivation(clock);

  const capped = await ledger.wait({ durationMs: 900_000 }, clock) as {
    requestedMs: number;
    effectiveMs: number;
    remainingMsAfter: number;
    cutoffReached: boolean;
  };
  assert.equal(capped.requestedMs, 900_000);
  assert.equal(capped.effectiveMs, 300_000);
  assert.equal(capped.remainingMsAfter, 600_000);
  assert.equal(capped.cutoffReached, false);

  const [record] = ledger.waits();
  assert.equal(record?.requestedMs, 900_000);
  assert.equal(record?.effectiveMs, 300_000);
  assert.equal(record?.cutoffReached, false);

  const shorter = await ledger.wait({ durationMs: 120_000 }, clock) as {
    requestedMs: number;
    effectiveMs: number;
    remainingMsAfter: number;
    cutoffReached: boolean;
  };
  assert.equal(shorter.requestedMs, 120_000);
  assert.equal(shorter.effectiveMs, 120_000);
  assert.equal(shorter.remainingMsAfter, 480_000);
  assert.equal(shorter.cutoffReached, false);
});

test("wait PR4 shape caps to five minutes so re-observe still fits before deadline", async () => {
  const clock = clockAt("2024-01-01T00:00:00Z");
  const ledger = createCollectorLedger(config());
  ledger.recordActivation(clock);
  // Remaining ≈ 762_388 ms (eligibility 900_000 − elapsed 137_612).
  clock.advance(137_612);

  const result = await ledger.wait({ durationMs: 900_000 }, clock) as {
    requestedMs: number;
    effectiveMs: number;
    remainingMsAfter: number;
    cutoffReached: boolean;
  };
  assert.equal(result.requestedMs, 900_000);
  assert.equal(result.effectiveMs, 300_000);
  assert.equal(result.remainingMsAfter, 462_388);
  assert.equal(result.cutoffReached, false);

  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-a" }),
    reviews: [],
    reviewComments: [],
    issueComments: [],
  });
  const { snapshot } = await ledger.observe(transport, clock);
  assert.ok(ledger.deadlineMono !== undefined);
  assert.ok(snapshot.completedMono !== undefined);
  assert.ok(snapshot.completedMono! < ledger.deadlineMono!);
});

test("wait caps to remaining eligibility near cutoff and rejects after cutoff", async () => {
  const clock = clockAt("2024-01-01T00:00:00Z");
  const ledger = createCollectorLedger(config());
  ledger.recordActivation(clock);
  clock.advance(14 * 60 * 1000);
  const result = await ledger.wait({ durationMs: 120_000 }, clock) as {
    effectiveMs: number;
    cutoffReached: boolean;
  };
  // Remaining (60_000) is below the five-minute single-wait cap, so remaining wins.
  assert.equal(result.effectiveMs, 60_000);
  assert.equal(result.cutoffReached, true);
  assert.equal(ledger.mutationGeneration, 1);

  await assert.rejects(
    () => ledger.wait({ durationMs: 1_000 }, clock),
    /cutoff/,
  );
});

test("existing exact-head qualifying review blocks request via shared qualify law", async () => {
  const clock = clockAt("2024-01-01T00:00:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-a" }),
    reviews: [
      sampleReview({
        id: 1,
        userLogin: "codexbot",
        state: "APPROVED",
        commitId: "head-a",
        submittedAt: "2024-01-01T00:00:00Z",
      }),
    ],
    issueComments: [],
    reviewComments: [],
  });
  const ledger = createCollectorLedger(config());
  ledger.recordActivation(clock);
  const { snapshot } = await ledger.observe(transport, clock);
  await assert.rejects(
    () => ledger.request(
      { legId: "codex", snapshotId: snapshot.snapshotId },
      transport,
      clock,
    ),
    /qualifying review/,
  );
});

test("after/uncertain exact-head review does not block request like before/within", async () => {
  const clock = clockAt("2024-01-01T00:10:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser("collector-bot"),
    pullRequest: samplePull({ headOid: "head-a" }),
    reviews: [
      sampleReview({
        id: 1,
        userLogin: "codexbot",
        state: "APPROVED",
        commitId: "head-a",
        // after deadline relative to activation+15m — but still before we advance
        submittedAt: "2024-01-01T00:30:00Z",
      }),
    ],
    issueComments: [],
    reviewComments: [],
  });
  const ledger = createCollectorLedger(config());
  ledger.recordActivation(clock);
  // Force the review window to "after" by using submitted_at after deadline
  // deadline = activation + 15m = 00:25; submitted 00:30 => after
  const { snapshot } = await ledger.observe(transport, clock);
  const review = ledger.allEvidence().find((item) => item.kind === "review")!;
  assert.equal(review.windowRelation, "after");
  const result = await ledger.request(
    { legId: "codex", snapshotId: snapshot.snapshotId },
    transport,
    clock,
  ) as { status: string };
  assert.equal(result.status, "succeeded");
});

test("snapshot and ledger size bounds fail loudly without truncation", async () => {
  const clock = clockAt("2024-01-01T00:00:00Z");
  const hugeBody = "x".repeat(COLLECTOR_SNAPSHOT_MAX_BYTES + 1000);
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull(),
    reviews: [
      sampleReview({
        id: 1,
        userLogin: "codexbot",
        body: hugeBody,
        commitId: "aaa111",
      }),
    ],
    issueComments: [],
    reviewComments: [],
  });
  const ledger = createCollectorLedger(config());
  ledger.recordActivation(clock);
  await assert.rejects(() => ledger.observe(transport, clock), /8|snapshot|bytes/i);
  assert.equal(ledger.fatal, true);
  assert.equal(COLLECTOR_RECEIPT_MAX_BYTES, 32 * 1024 * 1024);
});

test("R10 cross-surface normalized budget rejects before later surfaces and terminal PR", async () => {
  // ~2.2 MiB bodies: each surface alone normalizes under 8 MiB (body+raw),
  // but cumulative reviews + issue-comments exceeds; review-comments and the
  // terminal PR bracket must not run.
  const body = "x".repeat(Math.floor(2.2 * 1024 * 1024));
  let pullCalls = 0;
  let reviewCalls = 0;
  let issueCommentCalls = 0;
  let reviewCommentCalls = 0;
  const runner = async (args: string[]) => {
    const path = String(args[args.length - 1] ?? "");
    if (path === "/user" || args.includes("/user")) {
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify({ login: "collector-bot", id: 1 }),
      };
    }
    if (path.includes("/reviews")) {
      reviewCalls += 1;
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify([
          {
            id: 1,
            user: { login: "reviewer" },
            state: "COMMENTED",
            body,
            commit_id: "aaa111",
            submitted_at: "2024-01-01T00:05:00Z",
            html_url: "https://example.test/r1",
          },
        ]),
      };
    }
    if (path.includes("/issues/") && path.includes("/comments")) {
      issueCommentCalls += 1;
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify([
          {
            id: 2,
            user: { login: "commenter" },
            body,
            created_at: "2024-01-01T00:01:00Z",
            updated_at: "2024-01-01T00:01:00Z",
            html_url: "https://example.test/c1",
          },
        ]),
      };
    }
    if (path.includes("/pulls/") && path.includes("/comments")) {
      reviewCommentCalls += 1;
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify([
          {
            id: 3,
            user: { login: "inline" },
            body,
            path: "src/a.ts",
            line: 1,
            original_line: 1,
            side: "RIGHT",
            position: 1,
            original_position: 1,
            commit_id: "aaa111",
            original_commit_id: "aaa111",
            pull_request_review_id: 1,
            created_at: "2024-01-01T00:05:00Z",
            updated_at: "2024-01-01T00:05:00Z",
            html_url: "https://example.test/rc1",
          },
        ]),
      };
    }
    if (path.includes("/pulls/")) {
      pullCalls += 1;
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify({
          number: 7,
          state: "open",
          head: { sha: "aaa111" },
          updated_at: "2024-01-01T00:00:00Z",
          html_url: "https://github.com/acme/widgets/pull/7",
        }),
      };
    }
    throw new Error(`unexpected gh api args: ${args.join(" ")}`);
  };
  const transport = createGhCollectorGitHubTransport(runner);
  const clock = clockAt("2024-01-01T00:00:00Z");
  const ledger = createCollectorLedger(config());
  ledger.recordActivation(clock);
  await assert.rejects(
    () => ledger.observe(transport, clock),
    /snapshot exceeded|UTF-8 bytes|8/i,
  );
  assert.equal(ledger.fatal, true);
  assert.equal(ledger.latestCompleteSnapshotId, undefined);
  assert.equal(reviewCalls, 1);
  assert.equal(issueCommentCalls, 1);
  assert.equal(reviewCommentCalls, 0);
  assert.equal(pullCalls, 1, "terminal PR bracket must not run after budget exceed");
});

test("R10 intra-surface multi-page normalized budget stops before later pages/surfaces", async () => {
  // body+raw ≈ 2×; page1 under budget, page1+page2 over.
  const fat = "x".repeat(Math.floor(COLLECTOR_SNAPSHOT_MAX_BYTES * 0.3));
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull(),
    reviews: [],
    reviewPages: [
      [
        sampleReview({
          id: 1,
          userLogin: "a",
          body: fat,
          raw: { id: 1, body: fat },
        }),
      ],
      [
        sampleReview({
          id: 2,
          userLogin: "b",
          body: fat,
          raw: { id: 2, body: fat },
        }),
      ],
      [
        sampleReview({
          id: 3,
          userLogin: "c",
          body: fat,
          raw: { id: 3, body: fat },
        }),
      ],
    ],
    issueComments: [
      sampleIssueComment({ id: 99, userLogin: "later", body: "must-not-fetch" }),
    ],
    reviewComments: [
      sampleReviewComment({ id: 98, userLogin: "later", body: "must-not-fetch" }),
    ],
  });
  const clock = clockAt("2024-01-01T00:00:00Z");
  const ledger = createCollectorLedger(config());
  ledger.recordActivation(clock);
  await assert.rejects(
    () => ledger.observe(transport, clock),
    /snapshot exceeded|UTF-8 bytes|8/i,
  );
  assert.equal(ledger.fatal, true);
  assert.equal(ledger.latestCompleteSnapshotId, undefined);
  assert.equal(transport.calls.reviews, 1);
  assert.equal(transport.calls.issueComments, 0);
  assert.equal(transport.calls.reviewComments, 0);
  assert.equal(transport.calls.pull, 1);
});

test("HEAD move permits a new-head request once", async () => {
  const clock = clockAt("2024-01-01T00:00:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser("collector-bot"),
    pullRequest: samplePull({ headOid: "head-a" }),
    reviews: [],
    issueComments: [],
    reviewComments: [],
  });
  const ledger = createCollectorLedger(config());
  ledger.recordActivation(clock);
  const first = await ledger.observe(transport, clock);
  await ledger.request(
    { legId: "codex", snapshotId: first.snapshot.snapshotId },
    transport,
    clock,
  );
  transport.state.pullRequest = samplePull({ headOid: "head-b" });
  const second = await ledger.observe(transport, clock);
  const again = await ledger.request(
    { legId: "codex", snapshotId: second.snapshot.snapshotId },
    transport,
    clock,
  ) as { status: string; observedHead: string };
  assert.equal(again.status, "succeeded");
  assert.equal(again.observedHead, "head-b");
});

test("evaluateBatch two-valid and invalid permutations latch fatal before execute", () => {
  const cases = [
    [COLLECTOR_OBSERVE_TOOL, COLLECTOR_OBSERVE_TOOL],
    [COLLECTOR_REQUEST_TOOL, COLLECTOR_WAIT_TOOL],
    [COLLECTOR_OUTPUT_TOOL, COLLECTOR_OUTPUT_TOOL],
    [COLLECTOR_OBSERVE_TOOL, COLLECTOR_OUTPUT_TOOL],
    [COLLECTOR_OUTPUT_TOOL, COLLECTOR_REQUEST_TOOL],
  ];
  for (const names of cases) {
    const ledger = createCollectorLedger(config());
    const decision = ledger.evaluateBatch(
      names.map((name, index) => ({
        type: "toolCall" as const,
        id: String(index),
        name,
        arguments: name === COLLECTOR_OBSERVE_TOOL
          ? {}
          : name === COLLECTOR_WAIT_TOOL
          ? { durationMs: 1 }
          : name === COLLECTOR_REQUEST_TOOL
          ? { legId: "codex", snapshotId: "s" }
          : {
            legs: [{
              legId: "codex",
              status: "missing",
              rationale: "x",
              evidenceRefs: ["s"],
            }],
          },
      })),
    );
    assert.equal(decision.allow, false, names.join("+"));
    assert.equal(ledger.fatal, true, names.join("+"));
  }
});

test("output observation law rejects missing pre-cutoff and stale post-mutation", async () => {
  const clock = clockAt("2024-01-01T00:00:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser("collector-bot"),
    pullRequest: samplePull({ headOid: "head-a" }),
    reviews: [],
    issueComments: [],
    reviewComments: [],
  });
  const ledger = createCollectorLedger(config());
  ledger.recordActivation(clock);
  await ledger.observe(transport, clock);

  assert.throws(
    () =>
      ledger.assertOutputObservationLaw({
        legs: [{ status: "missing" }],
      }, clock),
    /missing.*before|cutoff/i,
  );

  await ledger.request(
    { legId: "codex", snapshotId: ledger.latestCompleteSnapshotId! },
    transport,
    clock,
  );
  assert.throws(
    () =>
      ledger.assertOutputObservationLaw({
        legs: [{ status: "unavailable" }],
      }, clock),
    /observe after|mutation/i,
  );

  await ledger.observe(transport, clock);
  // still before cutoff — unavailable OK if dirty-clear
  ledger.assertOutputObservationLaw({
    legs: [{ status: "unavailable" }],
  }, clock);

  clock.advance(15 * 60 * 1000);
  assert.throws(
    () =>
      ledger.assertOutputObservationLaw({
        legs: [{ status: "missing" }],
      }, clock),
    /cutoff|final observation/i,
  );
  const finalObs = await ledger.observe(transport, clock);
  assert.ok(finalObs.snapshot.completedMono >= ledger.deadlineMono!);
  ledger.assertOutputObservationLaw({
    legs: [{ status: "missing" }],
  }, clock);
  assert.equal(
    buildCollectorReceipt(ledger, {
      legs: [{
        legId: "codex",
        status: "missing",
        rationale: "none",
        evidenceRefs: [finalObs.snapshot.snapshotId],
      }],
    }, clock).finalObservationTime,
    finalObs.snapshot.completedAt,
  );
});

test("observe start-before finish-after cutoff satisfies final obligation", async () => {
  const clock = clockAt("2024-01-01T00:00:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-a" }),
    reviews: [],
    issueComments: [],
    reviewComments: [],
  });
  // Advance clock during transport pull to cross cutoff mid-observe.
  let pullCount = 0;
  const originalPull = transport.getPullRequest.bind(transport);
  transport.getPullRequest = async (input) => {
    pullCount += 1;
    if (pullCount === 1) {
      // start before cutoff
    } else if (pullCount === 2) {
      clock.advance(15 * 60 * 1000 + 1);
    }
    return originalPull(input);
  };
  const ledger = createCollectorLedger(config());
  ledger.recordActivation(clockAt("2024-01-01T00:00:00Z"));
  // Use same clock instance
  const shared = clock;
  // re-bind activation on shared clock
  const ledger2 = createCollectorLedger(config());
  ledger2.recordActivation(shared);
  const { snapshot } = await ledger2.observe(transport, shared);
  assert.ok(snapshot.completedMono >= ledger2.deadlineMono!);
  assert.ok(Date.parse(snapshot.completedAt) > Date.parse(snapshot.observedAt) ||
    snapshot.completedMono >= ledger2.deadlineMono!);
  ledger2.assertOutputObservationLaw({ legs: [{ status: "missing" }] }, shared);
});

test("terminal PR reread binds terminal HEAD and retries on drift", async () => {
  const clock = clockAt("2024-01-01T00:00:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-a" }),
    pullRequestSequence: [
      samplePull({ headOid: "head-a" }),
      samplePull({ headOid: "head-b" }),
      // retry cycle
      samplePull({ headOid: "head-b" }),
      samplePull({ headOid: "head-b" }),
    ],
    reviews: [],
    issueComments: [],
    reviewComments: [],
  });
  const ledger = createCollectorLedger(config());
  ledger.recordActivation(clock);
  const { snapshot } = await ledger.observe(transport, clock);
  assert.equal(snapshot.headOid, "head-b");
  assert.ok(transport.calls.pull >= 4, "drift triggers full retry with terminal reread");
  const prEvidence = ledger.allEvidence().find((item) => item.kind === "pull_request");
  assert.equal(prEvidence?.commitOid, "head-b");
});

test("repeated PR identity drift after retry fails closed without certifying", async () => {
  const clock = clockAt("2024-01-01T00:00:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-a" }),
    pullRequestSequence: [
      // first bracket drifts A→B
      samplePull({ headOid: "head-a" }),
      samplePull({ headOid: "head-b" }),
      // retry still drifts C→D
      samplePull({ headOid: "head-c" }),
      samplePull({ headOid: "head-d" }),
    ],
    reviews: [
      sampleReview({
        id: 1,
        userLogin: "codexbot",
        body: "must not be stored on repeated drift",
        commitId: "head-a",
      }),
    ],
    issueComments: [
      sampleIssueComment({
        id: 9,
        userLogin: "alice",
        body: "must not be stored either",
      }),
    ],
    reviewComments: [],
  });
  const ledger = createCollectorLedger(config());
  ledger.recordActivation(clock);
  await assert.rejects(
    () => ledger.observe(transport, clock),
    /observe failed|drift/i,
  );
  assert.equal(transport.calls.pull, 4, "exactly one full-surface retry (two PR reads per pass)");
  assert.equal(ledger.fatal, true);
  assert.match(ledger.fatalReason ?? "", /observe failed|drift/i);
  assert.equal(ledger.allEvidence().length, 0);
  assert.equal(ledger.allSnapshots().length, 0);
  assert.equal(ledger.latestCompleteSnapshotId, undefined);
  assert.throws(
    () =>
      buildCollectorReceipt(ledger, {
        legs: [{
          legId: "codex",
          status: "missing",
          rationale: "none",
          evidenceRefs: [],
        }],
      }, clock),
    /observe failed|drift|complete final snapshot/i,
  );
});

test("version history: later review edit without timestamp is uncertain", async () => {
  const clock = clockAt("2024-01-01T00:10:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-c" }),
    reviews: [
      sampleReview({
        id: 1,
        userLogin: "codexbot",
        state: "APPROVED",
        body: "body A",
        commitId: "head-c",
        submittedAt: "2024-01-01T00:00:00Z",
      }),
    ],
    issueComments: [],
    reviewComments: [],
  });
  const ledger = createCollectorLedger(config());
  ledger.recordActivation(clock);
  await ledger.observe(transport, clock);
  const first = ledger.allEvidence().find((item) => item.kind === "review")!;
  assert.equal(first.windowRelation, "before");
  assert.equal(first.authoritativeTime, "2024-01-01T00:00:00Z");

  // Post-deadline edit, same submitted_at from GitHub, new body
  clock.advance(20 * 60 * 1000);
  transport.state.reviews = [
    sampleReview({
      id: 1,
      userLogin: "codexbot",
      state: "CHANGES_REQUESTED",
      body: "I decline after deadline",
      commitId: "head-c",
      submittedAt: "2024-01-01T00:00:00Z",
    }),
  ];
  await ledger.observe(transport, clock);
  const versions = ledger.allEvidence().filter((item) => item.kind === "review");
  assert.ok(versions.length >= 2);
  const later = versions.find((item) => item.body?.includes("decline"))!;
  assert.equal(later.authoritativeTime, null);
  assert.equal(later.windowRelation, "uncertain");
  // old version retained
  assert.ok(versions.some((item) => item.versionId === first.versionId));
});

test("digest mutation flips versionId for enumerated stored fields", () => {
  const base = sampleReview({
    id: 1,
    userLogin: "CodexBot",
    state: "APPROVED",
    body: "ok",
    commitId: "h",
    submittedAt: "2024-01-01T00:00:00Z",
    htmlUrl: "https://example.test/r/1",
  });
  const a = normalizeReviewEvidence(base, "t0");
  const b = normalizeReviewEvidence({ ...base, htmlUrl: "https://example.test/r/2" }, "t0");
  assert.notEqual(a.versionId, b.versionId);
  const c = normalizeReviewEvidence({ ...base, userLogin: "other" }, "t0");
  assert.notEqual(a.versionId, c.versionId);

  const comment = sampleIssueComment({
    id: 2,
    userLogin: "codexbot",
    body: "x",
    htmlUrl: "https://example.test/c/1",
  });
  const c1 = normalizeIssueCommentEvidence(comment, "t0");
  const c2 = normalizeIssueCommentEvidence({
    ...comment,
    htmlUrl: "https://example.test/c/2",
  }, "t0");
  assert.notEqual(c1.versionId, c2.versionId);

  const rc = sampleReviewComment({
    id: 3,
    userLogin: "codexbot",
    body: "n",
    position: 1,
    htmlUrl: "https://example.test/rc/1",
  });
  const r1 = normalizeReviewCommentEvidence(rc, "t0");
  const r2 = normalizeReviewCommentEvidence({ ...rc, position: 2 }, "t0");
  const r3 = normalizeReviewCommentEvidence({
    ...rc,
    htmlUrl: "https://example.test/rc/2",
  }, "t0");
  assert.notEqual(r1.versionId, r2.versionId);
  assert.notEqual(r1.versionId, r3.versionId);
});

test("applyEvidenceVersionHistory first review keeps submitted_at at/before deadline mono", () => {
  const deadlineMono = 900_000;
  const review = normalizeReviewEvidence(
    sampleReview({
      id: 9,
      userLogin: "codexbot",
      submittedAt: "2024-01-01T00:00:00Z",
    }),
    "2024-01-01T00:25:00Z", // wall metadata only; trust is mono
  );
  applyEvidenceVersionHistory([review], [], {
    deadlineMono,
    firstObservedMono: deadlineMono, // === boundary keeps submitted_at
  });
  assert.equal(review.authoritativeTime, "2024-01-01T00:00:00Z");
});

test("applyEvidenceVersionHistory after-deadline mono first review nulls authoritativeTime", () => {
  const deadlineMono = 900_000;
  const late = normalizeReviewEvidence(
    sampleReview({
      id: 30,
      userLogin: "codexbot",
      state: "APPROVED",
      body: "late first sighting",
      commitId: "head-c",
      submittedAt: "2024-01-01T00:00:00Z",
    }),
    "2024-01-01T00:20:00Z", // wall before deadline must not keep submitted_at
  );
  applyEvidenceVersionHistory([late], [], {
    deadlineMono,
    firstObservedMono: deadlineMono + 60_000,
  });
  assert.equal(late.authoritativeTime, null);

  const nonFinite = normalizeReviewEvidence(
    sampleReview({
      id: 31,
      userLogin: "codexbot",
      submittedAt: "2024-01-01T00:00:00Z",
    }),
    "2024-01-01T00:00:00Z",
  );
  applyEvidenceVersionHistory([nonFinite], [], {
    deadlineMono,
    firstObservedMono: Number.NaN,
  });
  assert.equal(nonFinite.authoritativeTime, null);

  // Known-version null reuse (R5): same versionId reuses stored null.
  const again = normalizeReviewEvidence(
    sampleReview({
      id: 30,
      userLogin: "codexbot",
      state: "APPROVED",
      body: "late first sighting",
      commitId: "head-c",
      submittedAt: "2024-01-01T00:00:00Z",
    }),
    "2024-01-01T00:27:00Z",
  );
  assert.equal(again.versionId, late.versionId);
  // Simulate raw re-normalization that would otherwise re-apply submitted_at.
  again.authoritativeTime = again.submittedAt ?? null;
  applyEvidenceVersionHistory([again], [late], {
    deadlineMono,
    firstObservedMono: deadlineMono + 120_000,
  });
  assert.equal(again.authoritativeTime, null);
});

test("8 MiB snapshot boundary: measured MAX accept and MAX+1 fail", async () => {
  function measureSnapshotBytes(body: string): number {
    const observedAt = "2024-01-01T00:00:00.000Z";
    const records = [
      normalizeAuthenticatedUserEvidence(sampleUser(), observedAt),
      normalizePullRequestEvidence(samplePull(), observedAt),
      normalizeReviewEvidence(
        sampleReview({ id: 1, userLogin: "codexbot", body, raw: {} }),
        observedAt,
      ),
    ];
    applyEvidenceVersionHistory(
      records,
      [],
      { deadlineMono: 15 * 60 * 1000, firstObservedMono: 0 },
    );
    assignWindowRelations(
      records,
      new Date("2024-01-01T00:00:00Z"),
      new Date("2024-01-01T00:15:00Z"),
    );
    return measureNormalizedBytes(records);
  }

  const MAX = COLLECTOR_SNAPSHOT_MAX_BYTES;
  const base = measureSnapshotBytes("");
  const padMax = "x".repeat(MAX - base);
  const padMax1 = "x".repeat(MAX - base + 1);
  assert.equal(measureSnapshotBytes(padMax), MAX);
  assert.equal(measureSnapshotBytes(padMax1), MAX + 1);

  // Accept path
  {
    const clock = clockAt("2024-01-01T00:00:00Z");
    const transport = createFakeGitHubTransport({
      user: sampleUser(),
      pullRequest: samplePull(),
      reviews: [
        sampleReview({
          id: 1,
          userLogin: "codexbot",
          body: padMax,
          raw: {},
        }),
      ],
      issueComments: [],
      reviewComments: [],
    });
    const ledger = createCollectorLedger(config());
    ledger.recordActivation(clock);
    const { snapshot } = await ledger.observe(transport, clock);
    assert.equal(ledger.fatal, false);
    assert.equal(snapshot.normalizedByteLength, MAX);
    assert.equal(snapshot.complete, true);
  }

  // Reject path
  {
    const clock = clockAt("2024-01-01T00:00:00Z");
    const transport = createFakeGitHubTransport({
      user: sampleUser(),
      pullRequest: samplePull(),
      reviews: [
        sampleReview({
          id: 1,
          userLogin: "codexbot",
          body: padMax1,
          raw: {},
        }),
      ],
      issueComments: [],
      reviewComments: [],
    });
    const ledger = createCollectorLedger(config());
    ledger.recordActivation(clock);
    await assert.rejects(() => ledger.observe(transport, clock), /bytes|snapshot/i);
    assert.equal(ledger.fatal, true);
  }
});


test("R5 third observation of unchanged edited review keeps null/uncertain in modelView and store", async () => {
  const clock = clockAt("2024-01-01T00:10:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-c" }),
    reviews: [
      sampleReview({
        id: 1,
        userLogin: "codexbot",
        state: "APPROVED",
        body: "body A",
        commitId: "head-c",
        submittedAt: "2024-01-01T00:00:00Z",
      }),
    ],
    issueComments: [],
    reviewComments: [],
  });
  const ledger = createCollectorLedger(config());
  ledger.recordActivation(clock);
  await ledger.observe(transport, clock);

  transport.state.reviews = [
    sampleReview({
      id: 1,
      userLogin: "codexbot",
      state: "CHANGES_REQUESTED",
      body: "edited body B",
      commitId: "head-c",
      submittedAt: "2024-01-01T00:00:00Z",
    }),
  ];
  const second = await ledger.observe(transport, clock);
  const edited = ledger.allEvidence().find((item) =>
    item.kind === "review" && item.body === "edited body B"
  )!;
  assert.equal(edited.authoritativeTime, null);
  assert.equal(edited.windowRelation, "uncertain");
  const secondView = second.modelView as {
    evidence: Array<{ body?: string; authoritativeTime?: string | null; windowRelation?: string }>;
  };
  const secondRow = secondView.evidence.find((row) => row.body === "edited body B");
  assert.ok(secondRow);
  assert.equal(secondRow.authoritativeTime, null);
  assert.equal(secondRow.windowRelation, "uncertain");

  // Third observe: GitHub still returns the same edited version + submitted_at.
  const third = await ledger.observe(transport, clock);
  const still = ledger.allEvidence().find((item) =>
    item.kind === "review" && item.body === "edited body B"
  )!;
  assert.equal(still.authoritativeTime, null);
  assert.equal(still.windowRelation, "uncertain");
  const thirdView = third.modelView as {
    evidence: Array<{ body?: string; authoritativeTime?: string | null; windowRelation?: string }>;
  };
  const thirdRow = thirdView.evidence.find((row) => row.body === "edited body B");
  assert.ok(thirdRow);
  assert.equal(thirdRow.authoritativeTime, null);
  assert.equal(thirdRow.windowRelation, "uncertain");
});

test("R9 updatedAt churn forces full-surface retry and fails closed on repeated drift", async () => {
  const clock = clockAt("2024-01-01T00:00:00Z");
  // Stable state/HEAD; updatedAt changes across the first bracket → retry.
  // On retry, review appears and identity stabilizes.
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-a", updatedAt: "2024-01-01T00:00:00Z" }),
    pullRequestSequence: [
      samplePull({ headOid: "head-a", updatedAt: "2024-01-01T00:00:00Z" }),
      samplePull({ headOid: "head-a", updatedAt: "2024-01-01T00:01:00Z" }),
      // retry bracket stable
      samplePull({ headOid: "head-a", updatedAt: "2024-01-01T00:01:00Z" }),
      samplePull({ headOid: "head-a", updatedAt: "2024-01-01T00:01:00Z" }),
    ],
    reviews: [],
    issueComments: [],
    reviewComments: [],
  });
  // Inject review only after first full pass (2 PR reads + surfaces).
  const originalReviews = transport.listPullRequestReviews.bind(transport);
  let reviewCalls = 0;
  transport.listPullRequestReviews = async (input) => {
    reviewCalls += 1;
    if (reviewCalls >= 2) {
      transport.state.reviews = [
        sampleReview({
          id: 7,
          userLogin: "codexbot",
          body: "appeared on retry",
          commitId: "head-a",
          submittedAt: "2024-01-01T00:00:30Z",
        }),
      ];
    }
    return await originalReviews(input);
  };
  const ledger = createCollectorLedger(config());
  ledger.recordActivation(clock);
  const { snapshot, modelView } = await ledger.observe(transport, clock);
  assert.equal(snapshot.headOid, "head-a");
  assert.ok(transport.calls.pull >= 4, "updatedAt drift triggers full retry");
  const view = modelView as { evidence: Array<{ body?: string }> };
  assert.ok(view.evidence.some((row) => row.body === "appeared on retry"));

  // Repeated updatedAt churn fails closed without certifying.
  const clock2 = clockAt("2024-01-01T00:00:00Z");
  const t2 = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-a", updatedAt: "t0" }),
    pullRequestSequence: [
      samplePull({ headOid: "head-a", updatedAt: "t0" }),
      samplePull({ headOid: "head-a", updatedAt: "t1" }),
      samplePull({ headOid: "head-a", updatedAt: "t2" }),
      samplePull({ headOid: "head-a", updatedAt: "t3" }),
    ],
    reviews: [
      sampleReview({
        id: 1,
        userLogin: "codexbot",
        body: "must not certify",
        commitId: "head-a",
      }),
    ],
    issueComments: [],
    reviewComments: [],
  });
  const ledger2 = createCollectorLedger(config());
  ledger2.recordActivation(clock2);
  await assert.rejects(() => ledger2.observe(t2, clock2), /observe failed|drift/i);
  assert.equal(t2.calls.pull, 4);
  assert.equal(ledger2.fatal, true);
  assert.equal(ledger2.latestCompleteSnapshotId, undefined);
  assert.equal(ledger2.allSnapshots().length, 0);
});

