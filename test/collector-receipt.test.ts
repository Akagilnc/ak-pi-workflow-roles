import assert from "node:assert/strict";
import test from "node:test";

import type { CollectorClock } from "../src/collector-evidence.ts";
import { createCollectorLedger } from "../src/collector-ledger.ts";
import {
  buildCollectorReceipt,
  parseCollectorOutputCandidate,
} from "../src/collector-receipt.ts";
import {
  createFakeGitHubTransport,
  sampleIssueComment,
  samplePull,
  sampleReview,
  sampleReviewComment,
  sampleUser,
} from "./helpers/fake-github-transport.ts";

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

function baseConfig(authors = ["codexbot"]) {
  return {
    repository: {
      display: "Acme/Widgets",
      canonical: "acme/widgets",
      owner: "acme",
      repo: "widgets",
    },
    prNumber: 1,
    manifest: {
      version: 1 as const,
      legs: [
        {
          id: "codex",
          expectedAuthors: authors,
          requestBody: "Please review.",
        },
      ],
      canonicalJson: "{}\n",
      digest: "b".repeat(64),
      sourcePath: "/tmp/legs.json",
    },
  };
}

async function observeWith(
  reviews: Parameters<typeof sampleReview>[0][],
  options: {
    head?: string;
    issueComments?: ReturnType<typeof sampleIssueComment>[];
    reviewComments?: ReturnType<typeof sampleReviewComment>[];
    activation?: string;
    prState?: string;
  } = {},
) {
  const clock = clockAt(options.activation ?? "2024-01-01T00:10:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser("collector-bot"),
    pullRequest: samplePull({
      headOid: options.head ?? "head-c",
      state: options.prState ?? "OPEN",
    }),
    reviews: reviews.map((entry) => sampleReview(entry)),
    issueComments: options.issueComments ?? [],
    reviewComments: options.reviewComments ?? [],
  });
  const ledger = createCollectorLedger(baseConfig());
  ledger.recordActivation(clock);
  const { snapshot } = await ledger.observe(transport, clock);
  return { ledger, snapshot, clock, transport };
}

test("parseCollectorOutputCandidate accepts narrow semantic legs only", () => {
  const parsed = parseCollectorOutputCandidate({
    legs: [{
      legId: "codex",
      status: "missing",
      rationale: "no review",
      evidenceRefs: ["snap"],
    }],
  });
  assert.equal(parsed.legs.length, 1);
  assert.throws(
    () => parseCollectorOutputCandidate({
      legs: [{
        legId: "codex",
        status: "refused",
        rationale: "nope",
        evidenceRefs: ["x"],
      }],
    }),
    /valid\|unavailable\|missing|status/i,
  );
  assert.throws(
    () => parseCollectorOutputCandidate({
      legs: [{
        legId: "codex",
        status: "valid",
        rationale: "ok",
        evidenceRefs: ["x"],
        reports: [],
      }],
    }),
    /unknown field/i,
  );
});

test("pre-existing exact-head review with before relation proves valid", async () => {
  const { ledger, snapshot } = await observeWith([
    {
      id: 1,
      userLogin: "codexbot",
      state: "APPROVED",
      commitId: "head-c",
      body: "ship it",
      submittedAt: "2024-01-01T00:00:00Z",
    },
  ]);
  const review = ledger.allEvidence().find((item) => item.kind === "review")!;
  const receipt = buildCollectorReceipt(ledger, {
    legs: [{
      legId: "codex",
      status: "valid",
      rationale: "exact-head approved review",
      evidenceRefs: [review.evidenceId],
    }],
  });
  assert.equal(receipt.targetHead, "head-c");
  assert.equal(receipt.legs[0]?.status, "valid");
  assert.equal(receipt.reports.some((report) => report.kind === "review"), true);
  const reviewReport = receipt.reports.find((report) => report.kind === "review");
  assert.ok(reviewReport && reviewReport.kind === "review");
  assert.equal(reviewReport.headRelation, "current");
  assert.equal(reviewReport.windowRelation, "before");
  assert.ok(receipt.snapshots.some((item) => item.snapshotId === snapshot.snapshotId));
  assert.ok(
    receipt.evidenceRecords.some((item) => item.evidenceId === review.evidenceId),
  );
});

test("accepted review states and rejected PENDING/DISMISSED/blank/unknown", async () => {
  for (const state of ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"] as const) {
    const { ledger } = await observeWith([
      {
        id: 1,
        userLogin: "codexbot",
        state,
        commitId: "head-c",
        submittedAt: "2024-01-01T00:00:00Z",
      },
    ]);
    const review = ledger.allEvidence().find((item) => item.kind === "review")!;
    const receipt = buildCollectorReceipt(ledger, {
      legs: [{
        legId: "codex",
        status: "valid",
        rationale: state,
        evidenceRefs: [review.evidenceId],
      }],
    });
    assert.equal(receipt.legs[0]?.status, "valid", state);
  }

  for (const state of ["PENDING", "DISMISSED", "", "UNKNOWN"]) {
    const { ledger } = await observeWith([
      {
        id: 2,
        userLogin: "codexbot",
        state,
        commitId: "head-c",
        submittedAt: "2024-01-01T00:00:00Z",
      },
    ]);
    const review = ledger.allEvidence().find((item) => item.kind === "review")!;
    assert.throws(
      () => buildCollectorReceipt(ledger, {
        legs: [{
          legId: "codex",
          status: "valid",
          rationale: "bad state",
          evidenceRefs: [review.evidenceId],
        }],
      }),
      /qualifying|valid/i,
      state,
    );
  }
});

test("blank-body zero-inline review is valid with factual non-finding report", async () => {
  const { ledger } = await observeWith([
    {
      id: 3,
      userLogin: "codexbot",
      state: "APPROVED",
      body: "",
      commitId: "head-c",
      submittedAt: "2024-01-01T00:00:00Z",
    },
  ]);
  const review = ledger.allEvidence().find((item) => item.kind === "review")!;
  const receipt = buildCollectorReceipt(ledger, {
    legs: [{
      legId: "codex",
      status: "valid",
      rationale: "blank approved",
      evidenceRefs: [review.evidenceId],
    }],
  });
  const report = receipt.reports.find((item) => item.kind === "review");
  assert.ok(report);
  assert.match(report.report, /non-finding|blank body|inline comments: 0/i);
});

test("comment-only completion without review commit cannot be valid", async () => {
  const { ledger } = await observeWith([], {
    issueComments: [
      sampleIssueComment({
        id: 9,
        userLogin: "codexbot",
        body: "I approve this",
      }),
    ],
  });
  const comment = ledger.allEvidence().find((item) => item.kind === "issue_comment")!;
  assert.throws(
    () => buildCollectorReceipt(ledger, {
      legs: [{
        legId: "codex",
        status: "valid",
        rationale: "comment only",
        evidenceRefs: [comment.evidenceId],
      }],
    }),
    /qualifying|valid/i,
  );
});

test("prior head findings remain prior after A→B and auto-join into reports", async () => {
  const clock = clockAt("2024-01-01T00:10:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-a" }),
    reviews: [
      sampleReview({
        id: 1,
        userLogin: "codexbot",
        state: "CHANGES_REQUESTED",
        body: "fix A",
        commitId: "head-a",
        submittedAt: "2024-01-01T00:11:00Z",
      }),
    ],
    issueComments: [],
    reviewComments: [
      sampleReviewComment({
        id: 11,
        userLogin: "codexbot",
        pullRequestReviewId: 1,
        body: "line issue on A",
        commitId: "head-a",
      }),
    ],
  });
  const ledger = createCollectorLedger(baseConfig());
  ledger.recordActivation(clock);
  await ledger.observe(transport, clock);
  transport.state.pullRequest = samplePull({ headOid: "head-b" });
  transport.state.reviews = [
    sampleReview({
      id: 1,
      userLogin: "codexbot",
      state: "CHANGES_REQUESTED",
      body: "fix A",
      commitId: "head-a",
      submittedAt: "2024-01-01T00:11:00Z",
    }),
    sampleReview({
      id: 2,
      userLogin: "codexbot",
      state: "APPROVED",
      body: "ok on B",
      commitId: "head-b",
      submittedAt: "2024-01-01T00:12:00Z",
    }),
  ];
  const second = await ledger.observe(transport, clock);
  const current = ledger.allEvidence().find((item) =>
    item.kind === "review" && item.commitOid === "head-b"
  )!;
  const receipt = buildCollectorReceipt(ledger, {
    legs: [{
      legId: "codex",
      status: "valid",
      rationale: "B approved",
      evidenceRefs: [current.evidenceId],
    }],
  });
  assert.equal(receipt.targetHead, "head-b");
  const prior = receipt.reports.filter((report) =>
    report.kind === "review" && report.headRelation === "prior"
  );
  const curr = receipt.reports.filter((report) =>
    report.kind === "review" && report.headRelation === "current"
  );
  assert.ok(prior.length >= 1);
  assert.ok(curr.length >= 1);
  assert.match(prior.map((r) => r.report).join("\n"), /fix A|line issue on A/);
  assert.ok(receipt.snapshots.some((s) => s.snapshotId === second.snapshot.snapshotId));
});

test("after/uncertain evidence cannot replace deadline missing", async () => {
  const clock = clockAt("2024-01-01T00:10:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-c" }),
    reviews: [],
    issueComments: [],
    reviewComments: [],
  });
  const ledger = createCollectorLedger(baseConfig());
  ledger.recordActivation(clock);
  // Jump past deadline then observe a late review
  clock.advance(16 * 60 * 1000);
  ledger.noteCutoffObserved();
  transport.state.reviews = [
    sampleReview({
      id: 9,
      userLogin: "codexbot",
      state: "APPROVED",
      commitId: "head-c",
      submittedAt: "2024-01-01T00:30:00Z",
    }),
  ];
  const { snapshot } = await ledger.observe(transport, clock);
  const review = ledger.allEvidence().find((item) => item.kind === "review")!;
  assert.throws(
    () => buildCollectorReceipt(ledger, {
      legs: [{
        legId: "codex",
        status: "valid",
        rationale: "late",
        evidenceRefs: [review.evidenceId],
      }],
    }),
    /qualifying|window|valid/i,
  );
  const receipt = buildCollectorReceipt(ledger, {
    legs: [{
      legId: "codex",
      status: "missing",
      rationale: "no eligible review by deadline",
      evidenceRefs: [snapshot.snapshotId, review.evidenceId],
    }],
  });
  assert.equal(receipt.legs[0]?.status, "missing");
  const terminal = receipt.reports.find((r) => r.kind === "terminal-fact");
  assert.ok(terminal && terminal.kind === "terminal-fact");
  assert.equal(terminal.terminalStatus, "missing");
  assert.equal("reviewedHead" in terminal, false);
});

test("non-OPEN final snapshot fails with no receipt", async () => {
  const { ledger } = await observeWith([], { prState: "CLOSED" });
  const snap = ledger.latestCompleteSnapshotId!;
  assert.throws(
    () => buildCollectorReceipt(ledger, {
      legs: [{
        legId: "codex",
        status: "missing",
        rationale: "closed",
        evidenceRefs: [snap],
      }],
    }),
    /OPEN/,
  );
});

test("receipt embeds referenced subset and omits unrelated non-author records", async () => {
  const { ledger, snapshot } = await observeWith(
    [
      {
        id: 1,
        userLogin: "codexbot",
        state: "APPROVED",
        commitId: "head-c",
        submittedAt: "2024-01-01T00:00:00Z",
      },
    ],
    {
      issueComments: [
        sampleIssueComment({
          id: 50,
          userLogin: "random-user",
          body: "unrelated chatter",
        }),
      ],
    },
  );
  const review = ledger.allEvidence().find((item) => item.kind === "review")!;
  const receipt = buildCollectorReceipt(ledger, {
    legs: [{
      legId: "codex",
      status: "valid",
      rationale: "ok",
      evidenceRefs: [review.evidenceId],
    }],
  });
  assert.ok(receipt.evidenceRecords.some((r) => r.evidenceId === review.evidenceId));
  assert.equal(
    receipt.evidenceRecords.some((r) =>
      r.kind === "issue_comment" && r.authorLogin === "random-user"
    ),
    false,
    "unrelated non-author records are not copied merely because observed",
  );
  assert.ok(receipt.snapshots.some((s) => s.snapshotId === snapshot.snapshotId));
  // every leg/report ref resolves
  for (const leg of receipt.legs) {
    for (const ref of leg.evidenceRefs) {
      assert.ok(
        receipt.evidenceRecords.some((r) => r.evidenceId === ref) ||
          receipt.snapshots.some((s) => s.snapshotId === ref),
      );
    }
  }
});

test("global unavailable can cover a new head while target-scoped stale cannot", async () => {
  const clock = clockAt("2024-01-01T00:10:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-a" }),
    reviews: [],
    issueComments: [
      sampleIssueComment({
        id: 1,
        userLogin: "codexbot",
        body: "I will not review any PR in this run.",
        createdAt: "2024-01-01T00:11:00Z",
        updatedAt: "2024-01-01T00:11:00Z",
      }),
    ],
    reviewComments: [],
  });
  const ledger = createCollectorLedger(baseConfig());
  ledger.recordActivation(clock);
  await ledger.observe(transport, clock);
  const unavailable = ledger.allEvidence().find((item) =>
    item.kind === "issue_comment"
  )!;
  transport.state.pullRequest = samplePull({ headOid: "head-b" });
  // comment no longer present on new head snapshot
  transport.state.issueComments = [];
  await ledger.observe(transport, clock);

  // global scope can still terminate using historical evidence
  const globalReceipt = buildCollectorReceipt(ledger, {
    legs: [{
      legId: "codex",
      status: "unavailable",
      rationale: "explicit global decline",
      evidenceRefs: [unavailable.evidenceId],
      unavailableScope: "global",
    }],
  });
  assert.equal(globalReceipt.legs[0]?.status, "unavailable");
  const terminal = globalReceipt.reports.find((r) => r.kind === "terminal-fact");
  assert.ok(terminal && terminal.kind === "terminal-fact");
  assert.equal(terminal.scope, "global");
  assert.equal("reviewedHead" in terminal, false);

  // target-scoped cannot use evidence absent from final snapshot
  const ledger2 = createCollectorLedger(baseConfig());
  ledger2.recordActivation(clockAt("2024-01-01T00:10:00Z"));
  const t2 = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-a" }),
    reviews: [],
    issueComments: [
      sampleIssueComment({
        id: 2,
        userLogin: "codexbot",
        body: "not reviewing this head",
        createdAt: "2024-01-01T00:11:00Z",
        updatedAt: "2024-01-01T00:11:00Z",
      }),
    ],
    reviewComments: [],
  });
  await ledger2.observe(t2, clockAt("2024-01-01T00:10:00Z"));
  const stale = ledger2.allEvidence().find((i) => i.kind === "issue_comment")!;
  t2.state.pullRequest = samplePull({ headOid: "head-b" });
  t2.state.issueComments = [];
  await ledger2.observe(t2, clockAt("2024-01-01T00:10:00Z"));
  assert.throws(
    () => buildCollectorReceipt(ledger2, {
      legs: [{
        legId: "codex",
        status: "unavailable",
        rationale: "stale target",
        evidenceRefs: [stale.evidenceId],
        unavailableScope: "target",
      }],
    }),
    /unavailable|scope|eligible/i,
  );
});
