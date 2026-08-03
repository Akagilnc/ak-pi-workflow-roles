import assert from "node:assert/strict";
import test from "node:test";

import {
  applyEvidenceVersionHistory,
  assertCollectorByteLimit,
  COLLECTOR_RECEIPT_MAX_BYTES,
  COLLECTOR_SNAPSHOT_MAX_BYTES,
  computeWindowRelation,
  normalizeIssueCommentEvidence,
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

test("batch gate permits one operational or sole output and latches mixed/multiple", async () => {
  const soleOutputArgs = {
    legs: [{
      legId: "codex",
      status: "missing",
      rationale: "x",
      evidenceRefs: ["s"],
    }],
  };
  const call = (name: string, id: string) => ({
    type: "toolCall" as const,
    id,
    name,
    arguments: name === COLLECTOR_OBSERVE_TOOL
      ? {}
      : name === COLLECTOR_WAIT_TOOL
      ? { durationMs: 1 }
      : name === COLLECTOR_REQUEST_TOOL
      ? { legId: "codex", snapshotId: "s" }
      : soleOutputArgs,
  });

  const allowObserve = createCollectorLedger(config());
  const ok = allowObserve.evaluateBatch([call(COLLECTOR_OBSERVE_TOOL, "1")]);
  assert.equal(ok.allow, true);
  if (ok.allow) {
    assert.deepEqual(ok.permitted, {
      kind: "operational",
      callId: "1",
      name: COLLECTOR_OBSERVE_TOOL,
    });
  }

  // Sole output after a completed snapshot is permitted.
  const clock = clockAt("2024-01-01T00:00:00Z");
  const allowOutput = createCollectorLedger(config());
  allowOutput.recordActivation(clock);
  await allowOutput.observe(createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull(),
    reviews: [],
    issueComments: [],
    reviewComments: [],
  }), clock);
  const sole = allowOutput.evaluateBatch([call(COLLECTOR_OUTPUT_TOOL, "out")]);
  assert.equal(sole.allow, true);
  if (sole.allow) {
    assert.deepEqual(sole.permitted, {
      kind: "output",
      callId: "out",
      name: COLLECTOR_OUTPUT_TOOL,
    });
  }

  // Deny table (includes sole-output-without-snapshot + mixed/multiple).
  const denyRows = [
    [COLLECTOR_OUTPUT_TOOL],
    [COLLECTOR_OBSERVE_TOOL, COLLECTOR_REQUEST_TOOL],
    [COLLECTOR_OBSERVE_TOOL, COLLECTOR_OUTPUT_TOOL],
    [COLLECTOR_OBSERVE_TOOL, COLLECTOR_OBSERVE_TOOL],
    [COLLECTOR_REQUEST_TOOL, COLLECTOR_WAIT_TOOL],
    [COLLECTOR_OUTPUT_TOOL, COLLECTOR_OUTPUT_TOOL],
    [COLLECTOR_OUTPUT_TOOL, COLLECTOR_REQUEST_TOOL],
  ];
  for (const names of denyRows) {
    const ledger = createCollectorLedger(config());
    const decision = ledger.evaluateBatch(names.map((name, index) => call(name, String(index))));
    assert.equal(decision.allow, false, names.join("+"));
    assert.equal(ledger.fatal, true, names.join("+"));
  }
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

  // PR4 offset: after elapsed 137_612, a capped wait still leaves room for re-observe.
  clock.advance(137_612);
  const offset = await ledger.wait({ durationMs: 900_000 }, clock) as {
    requestedMs: number;
    effectiveMs: number;
    remainingMsAfter: number;
    cutoffReached: boolean;
  };
  assert.equal(offset.requestedMs, 900_000);
  assert.equal(offset.effectiveMs, 300_000);
  assert.equal(offset.remainingMsAfter, 42_388);
  assert.equal(offset.cutoffReached, false);
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

test("R10 normalized budget rejects before later surfaces and terminal PR", async () => {
  // Exercise the production 8 MiB boundary; no test-only production limit is injected.
  const probeClock = clockAt("2024-01-01T00:00:00Z");
  const probe = createCollectorLedger(config());
  probe.recordActivation(probeClock);
  const { snapshot: emptySnap } = await probe.observe(createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull(),
    reviews: [],
    issueComments: [],
    reviewComments: [],
  }), probeClock);
  const emptyBytes = emptySnap.normalizedByteLength;
  const pad = "x".repeat(Math.floor(COLLECTOR_SNAPSHOT_MAX_BYTES * 0.4));
  // Two padded surfaces exceed the real production bound.
  const onePad = createCollectorLedger(config());
  onePad.recordActivation(clockAt("2024-01-01T00:00:00Z"));
  const { snapshot: onePadSnap } = await onePad.observe(createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull(),
    reviews: [sampleReview({ id: 1, userLogin: "a", body: pad, raw: { id: 1, body: pad } })],
    issueComments: [],
    reviewComments: [],
  }), clockAt("2024-01-01T00:00:00Z"));
  const bound = COLLECTOR_SNAPSHOT_MAX_BYTES;

  // Cross-surface: reviews ok, issue-comments exceed; review-comments + terminal PR skip.
  {
    const transport = createFakeGitHubTransport({

      user: sampleUser(),
      pullRequest: samplePull(),
      reviews: [sampleReview({ id: 1, userLogin: "a", body: pad, raw: { id: 1, body: pad } })],
      issueComments: [sampleIssueComment({ id: 2, userLogin: "b", body: pad, raw: { id: 2, body: pad } })],
      reviewComments: [sampleReviewComment({ id: 3, userLogin: "c", body: "must-not-fetch" })],
    });
    const ledger = createCollectorLedger(config());
    ledger.recordActivation(clockAt("2024-01-01T00:00:00Z"));
    await assert.rejects(
      () => ledger.observe(transport, clockAt("2024-01-01T00:00:00Z")),
      new RegExp(`Collector snapshot exceeded ${bound} UTF-8 bytes`),
    );
    assert.equal(ledger.fatal, true);
    assert.equal(ledger.latestCompleteSnapshotId, undefined);
    assert.equal(transport.calls.reviews, 1);
    assert.equal(transport.calls.issueComments, 1);
    assert.equal(transport.calls.reviewComments, 0);
    assert.equal(transport.calls.pull, 1, "terminal PR bracket must not run after budget exceed");
  }

  // Exceed inside first surface ⇒ later surfaces + terminal PR skipped.
  {
    const fat = "x".repeat(COLLECTOR_SNAPSHOT_MAX_BYTES); // single review page exceeds bound alone
    const transport = createFakeGitHubTransport({
      user: sampleUser(),
      pullRequest: samplePull(),
      reviews: [sampleReview({ id: 1, userLogin: "a", body: fat, raw: { id: 1, body: fat } })],
      issueComments: [sampleIssueComment({ id: 99, userLogin: "later", body: "must-not-fetch" })],
      reviewComments: [sampleReviewComment({ id: 98, userLogin: "later", body: "must-not-fetch" })],
    });
    const ledger = createCollectorLedger(config());
    ledger.recordActivation(clockAt("2024-01-01T00:00:00Z"));
    await assert.rejects(
      () => ledger.observe(transport, clockAt("2024-01-01T00:00:00Z")),
      new RegExp(`Collector snapshot exceeded ${bound} UTF-8 bytes`),
    );
    assert.equal(ledger.fatal, true);
    assert.equal(ledger.latestCompleteSnapshotId, undefined);
    assert.equal(transport.calls.reviews, 1);
    assert.equal(transport.calls.issueComments, 0);
    assert.equal(transport.calls.reviewComments, 0);
    assert.equal(transport.calls.pull, 1);
  }

  assert.ok(emptyBytes > 0);
  assert.equal(COLLECTOR_SNAPSHOT_MAX_BYTES, 8 * 1024 * 1024);
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
  // Advance clock during terminal PR pull to cross cutoff mid-observe.
  let pullCount = 0;
  const originalPull = transport.getPullRequest.bind(transport);
  transport.getPullRequest = async (input) => {
    pullCount += 1;
    if (pullCount === 2) {
      clock.advance(15 * 60 * 1000 + 1);
    }
    return originalPull(input);
  };
  const ledger = createCollectorLedger(config());
  ledger.recordActivation(clock);
  const { snapshot } = await ledger.observe(transport, clock);
  assert.ok(snapshot.completedMono >= ledger.deadlineMono!);
  assert.ok(Date.parse(snapshot.completedAt) > Date.parse(snapshot.observedAt));
  ledger.assertOutputObservationLaw({ legs: [{ status: "missing" }] }, clock);
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
  // headOid and updatedAt are both identity tuple members — same fail-closed shape.
  for (const row of [
    {
      name: "headOid",
      sequence: [
        samplePull({ headOid: "head-a" }),
        samplePull({ headOid: "head-b" }),
        samplePull({ headOid: "head-c" }),
        samplePull({ headOid: "head-d" }),
      ],
    },
    {
      name: "updatedAt",
      sequence: [
        samplePull({ headOid: "head-a", updatedAt: "t0" }),
        samplePull({ headOid: "head-a", updatedAt: "t1" }),
        samplePull({ headOid: "head-a", updatedAt: "t2" }),
        samplePull({ headOid: "head-a", updatedAt: "t3" }),
      ],
    },
  ] as const) {
    const clock = clockAt("2024-01-01T00:00:00Z");
    const transport = createFakeGitHubTransport({
      user: sampleUser(),
      pullRequest: row.sequence[0]!,
      pullRequestSequence: [...row.sequence],
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
      row.name,
    );
    assert.equal(transport.calls.pull, 4, `${row.name}: exactly one full-surface retry`);
    assert.equal(ledger.fatal, true, row.name);
    assert.match(ledger.fatalReason ?? "", /observe failed|drift/i);
    assert.equal(ledger.allEvidence().length, 0, row.name);
    assert.equal(ledger.allSnapshots().length, 0, row.name);
    assert.equal(ledger.latestCompleteSnapshotId, undefined, row.name);
  }
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

test("applyEvidenceVersionHistory first-sighting mono boundary keeps or nulls submitted_at", () => {
  const deadlineMono = 900_000;
  const rows = [
    { firstObservedMono: deadlineMono, expected: "2024-01-01T00:00:00Z" as string | null },
    { firstObservedMono: deadlineMono + 60_000, expected: null },
    { firstObservedMono: Number.NaN, expected: null },
  ] as const;
  for (const row of rows) {
    const review = normalizeReviewEvidence(
      sampleReview({
        id: 9,
        userLogin: "codexbot",
        submittedAt: "2024-01-01T00:00:00Z",
      }),
      "2024-01-01T00:25:00Z",
    );
    applyEvidenceVersionHistory([review], [], {
      deadlineMono,
      firstObservedMono: row.firstObservedMono,
    });
    assert.equal(review.authoritativeTime, row.expected, String(row.firstObservedMono));
  }

  // Known-version null reuse (R5): same versionId reuses stored null.
  const late = normalizeReviewEvidence(
    sampleReview({
      id: 30,
      userLogin: "codexbot",
      state: "APPROVED",
      body: "late first sighting",
      commitId: "head-c",
      submittedAt: "2024-01-01T00:00:00Z",
    }),
    "2024-01-01T00:20:00Z",
  );
  applyEvidenceVersionHistory([late], [], {
    deadlineMono,
    firstObservedMono: deadlineMono + 60_000,
  });
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
  again.authoritativeTime = again.submittedAt ?? null;
  applyEvidenceVersionHistory([again], [late], {
    deadlineMono,
    firstObservedMono: deadlineMono + 120_000,
  });
  assert.equal(again.authoritativeTime, null);
});

test("snapshot byte boundary uses the real production limit", () => {
  assert.doesNotThrow(() =>
    assertCollectorByteLimit("snapshot", COLLECTOR_SNAPSHOT_MAX_BYTES, COLLECTOR_SNAPSHOT_MAX_BYTES),
  );
  assert.throws(
    () => assertCollectorByteLimit("snapshot", COLLECTOR_SNAPSHOT_MAX_BYTES + 1, COLLECTOR_SNAPSHOT_MAX_BYTES),
    new RegExp(`Collector snapshot exceeded ${COLLECTOR_SNAPSHOT_MAX_BYTES} UTF-8 bytes`),
  );
  assert.equal(COLLECTOR_SNAPSHOT_MAX_BYTES, 8 * 1024 * 1024);
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
  const first = ledger.allEvidence().find((item) => item.kind === "review")!;
  assert.equal(first.windowRelation, "before");
  assert.equal(first.authoritativeTime, "2024-01-01T00:00:00Z");

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
  const versions = ledger.allEvidence().filter((item) => item.kind === "review");
  assert.ok(versions.some((item) => item.versionId === first.versionId), "earlier version retained");
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

test("R9 updatedAt drift-once retry surfaces late review evidence", async () => {
  // Fail-closed repeated churn lives in the identity-drift table; this row owns retry-visible evidence.
  const clock = clockAt("2024-01-01T00:00:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-a", updatedAt: "2024-01-01T00:00:00Z" }),
    pullRequestSequence: [
      samplePull({ headOid: "head-a", updatedAt: "2024-01-01T00:00:00Z" }),
      samplePull({ headOid: "head-a", updatedAt: "2024-01-01T00:01:00Z" }),
      samplePull({ headOid: "head-a", updatedAt: "2024-01-01T00:01:00Z" }),
      samplePull({ headOid: "head-a", updatedAt: "2024-01-01T00:01:00Z" }),
    ],
    reviews: [],
    issueComments: [],
    reviewComments: [],
  });
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
});

