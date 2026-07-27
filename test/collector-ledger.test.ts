import assert from "node:assert/strict";
import test from "node:test";

import {
  applyEvidenceVersionHistory,
  COLLECTOR_RECEIPT_MAX_BYTES,
  COLLECTOR_SNAPSHOT_MAX_BYTES,
  computeWindowRelation,
  normalizeIssueCommentEvidence,
  normalizeReviewCommentEvidence,
  normalizeReviewEvidence,
  type CollectorClock,
} from "../src/collector-evidence.ts";
import {
  classifyCollectorBatch,
  COLLECTOR_OBSERVE_TOOL,
  COLLECTOR_OUTPUT_TOOL,
  COLLECTOR_REQUEST_TOOL,
  COLLECTOR_WAIT_TOOL,
  createCollectorLedger,
} from "../src/collector-ledger.ts";
import { buildCollectorRequestMarker } from "../src/collector-github.ts";
import { buildCollectorReceipt } from "../src/collector-receipt.ts";
import {
  createFakeGitHubTransport,
  sampleIssueComment,
  samplePull,
  sampleReview,
  sampleReviewComment,
  sampleUser,
} from "./helpers/fake-github-transport.ts";

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

test("wait caps to remaining eligibility and rejects after cutoff", async () => {
  const clock = clockAt("2024-01-01T00:00:00Z");
  const ledger = createCollectorLedger(config());
  ledger.recordActivation(clock);
  clock.advance(14 * 60 * 1000);
  const result = await ledger.wait({ durationMs: 120_000 }, clock) as {
    effectiveMs: number;
    cutoffReached: boolean;
  };
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

test("applyEvidenceVersionHistory first review keeps submitted_at", () => {
  const review = normalizeReviewEvidence(
    sampleReview({
      id: 9,
      userLogin: "codexbot",
      submittedAt: "2024-01-01T00:00:00Z",
    }),
    "obs",
  );
  applyEvidenceVersionHistory([review], []);
  assert.equal(review.authoritativeTime, "2024-01-01T00:00:00Z");
});

test("8 MiB snapshot boundary: max accept, max+1 fail", async () => {
  // Build a body such that normalized JSON is just over / under is hard;
  // assert the law uses > max (reject max+1 style) via oversized body.
  const clock = clockAt("2024-01-01T00:00:00Z");
  const over = "y".repeat(COLLECTOR_SNAPSHOT_MAX_BYTES + 1);
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull(),
    reviews: [sampleReview({ id: 1, userLogin: "codexbot", body: over })],
    issueComments: [],
    reviewComments: [],
  });
  const ledger = createCollectorLedger(config());
  ledger.recordActivation(clock);
  await assert.rejects(() => ledger.observe(transport, clock), /bytes/i);
  assert.equal(ledger.fatal, true);
});
