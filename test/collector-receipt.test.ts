import assert from "node:assert/strict";
import test from "node:test";

import {
  COLLECTOR_RECEIPT_MAX_BYTES,
  type CollectorClock,
} from "../src/collector-evidence.ts";
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
  const { ledger, snapshot, clock } = await observeWith([
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
  }, clock);
  assert.equal(receipt.targetHead, "head-c");
  assert.equal(receipt.legs[0]?.status, "valid");
  assert.equal(receipt.finalObservationTime, snapshot.completedAt);
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
    const { ledger, clock } = await observeWith([
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
    }, clock);
    assert.equal(receipt.legs[0]?.status, "valid", state);
  }

  for (const state of ["PENDING", "DISMISSED", "", "UNKNOWN"]) {
    const { ledger, clock } = await observeWith([
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
      }, clock),
      /qualifying|valid/i,
      state,
    );
  }
});

test("blank-body zero-inline review is valid with factual non-finding report", async () => {
  const { ledger, clock } = await observeWith([
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
  }, clock);
  const report = receipt.reports.find((item) => item.kind === "review");
  assert.ok(report);
  assert.match(report.report, /non-finding|blank body|inline comments: 0/i);
});

test("comment-only completion without review commit cannot be valid", async () => {
  const { ledger, clock } = await observeWith([], {
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
    }, clock),
    /qualifying|valid/i,
  );
});

test("prior head findings remain prior after A→B→C and auto-join into reports", async () => {
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
      state: "COMMENTED",
      body: "note on B",
      commitId: "head-b",
      submittedAt: "2024-01-01T00:12:00Z",
    }),
  ];
  transport.state.reviewComments = [];
  await ledger.observe(transport, clock);
  transport.state.pullRequest = samplePull({ headOid: "head-c" });
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
      state: "COMMENTED",
      body: "note on B",
      commitId: "head-b",
      submittedAt: "2024-01-01T00:12:00Z",
    }),
    sampleReview({
      id: 3,
      userLogin: "codexbot",
      state: "APPROVED",
      body: "ok on C",
      commitId: "head-c",
      submittedAt: "2024-01-01T00:13:00Z",
    }),
  ];
  const third = await ledger.observe(transport, clock);
  const current = ledger.allEvidence().find((item) =>
    item.kind === "review" && item.commitOid === "head-c"
  )!;
  const receipt = buildCollectorReceipt(ledger, {
    legs: [{
      legId: "codex",
      status: "valid",
      rationale: "C approved",
      evidenceRefs: [current.evidenceId],
    }],
  }, clock);
  assert.equal(receipt.targetHead, "head-c");
  const reviewReports = receipt.reports.filter((report) => report.kind === "review");
  assert.ok(reviewReports.length >= 3, "all substantive head versions retained");
  assert.ok(reviewReports.some((r) => r.kind === "review" && r.headRelation === "prior" && /fix A|line issue on A/.test(r.report)));
  assert.ok(reviewReports.some((r) => r.kind === "review" && r.headRelation === "current"));
  assert.ok(receipt.snapshots.some((s) => s.snapshotId === third.snapshot.snapshotId));
});

test("inline removal keeps prior membership variant with old inline text", async () => {
  const clock = clockAt("2024-01-01T00:10:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-a" }),
    reviews: [
      sampleReview({
        id: 1,
        userLogin: "codexbot",
        state: "CHANGES_REQUESTED",
        body: "needs work",
        commitId: "head-a",
        submittedAt: "2024-01-01T00:11:00Z",
      }),
    ],
    issueComments: [],
    reviewComments: [
      sampleReviewComment({
        id: 50,
        userLogin: "codexbot",
        pullRequestReviewId: 1,
        body: "prior inline finding",
        commitId: "head-a",
      }),
    ],
  });
  const ledger = createCollectorLedger(baseConfig());
  ledger.recordActivation(clock);
  await ledger.observe(transport, clock);
  // same review version, inline removed
  transport.state.reviewComments = [];
  await ledger.observe(transport, clock);
  const review = ledger.allEvidence().find((item) => item.kind === "review")!;
  const receipt = buildCollectorReceipt(ledger, {
    legs: [{
      legId: "codex",
      status: "valid",
      rationale: "still changes requested",
      evidenceRefs: [review.evidenceId],
    }],
  }, clock);
  const variants = receipt.reports.filter((r) => r.kind === "review");
  assert.ok(variants.length >= 2, "membership variants for inline present/absent");
  assert.ok(variants.some((r) => r.kind === "review" && /prior inline finding/.test(r.report)));
  assert.ok(variants.some((r) => r.kind === "review" && !/prior inline finding/.test(r.report)));
});

test("inline edit preserves both inline versions on appropriate variants", async () => {
  const clock = clockAt("2024-01-01T00:10:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-a" }),
    reviews: [
      sampleReview({
        id: 1,
        userLogin: "codexbot",
        state: "COMMENTED",
        body: "review",
        commitId: "head-a",
        submittedAt: "2024-01-01T00:11:00Z",
      }),
    ],
    issueComments: [],
    reviewComments: [
      sampleReviewComment({
        id: 70,
        userLogin: "codexbot",
        pullRequestReviewId: 1,
        body: "inline v1",
        commitId: "head-a",
        updatedAt: "2024-01-01T00:11:00Z",
      }),
    ],
  });
  const ledger = createCollectorLedger(baseConfig());
  ledger.recordActivation(clock);
  await ledger.observe(transport, clock);
  transport.state.reviewComments = [
    sampleReviewComment({
      id: 70,
      userLogin: "codexbot",
      pullRequestReviewId: 1,
      body: "inline v2 edited",
      commitId: "head-a",
      updatedAt: "2024-01-01T00:12:00Z",
    }),
  ];
  await ledger.observe(transport, clock);
  const review = ledger.allEvidence().find((item) => item.kind === "review")!;
  const receipt = buildCollectorReceipt(ledger, {
    legs: [{
      legId: "codex",
      status: "valid",
      rationale: "commented",
      evidenceRefs: [review.evidenceId],
    }],
  }, clock);
  const text = receipt.reports.filter((r) => r.kind === "review").map((r) => r.report).join("\n");
  assert.match(text, /inline v1/);
  assert.match(text, /inline v2 edited/);
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
    }, clock),
    /qualifying|window|valid/i,
  );
  const receipt = buildCollectorReceipt(ledger, {
    legs: [{
      legId: "codex",
      status: "missing",
      rationale: "no eligible review by deadline",
      evidenceRefs: [snapshot.snapshotId],
    }],
  }, clock);
  assert.equal(receipt.legs[0]?.status, "missing");
  // auto-linked proof must include final snapshot and late review material
  assert.ok(receipt.legs[0]!.evidenceRefs.includes(snapshot.snapshotId));
  assert.ok(receipt.legs[0]!.evidenceRefs.includes(review.evidenceId));
  const terminal = receipt.reports.find((r) => r.kind === "terminal-fact");
  assert.ok(terminal && terminal.kind === "terminal-fact");
  assert.equal(terminal.terminalStatus, "missing");
  assert.ok(terminal.evidenceRefs.includes(review.evidenceId));
  assert.equal("reviewedHead" in terminal, false);
});

test("missing rejects early without clock past cutoff", async () => {
  const { ledger, snapshot, clock } = await observeWith([]);
  assert.throws(
    () => buildCollectorReceipt(ledger, {
      legs: [{
        legId: "codex",
        status: "missing",
        rationale: "too early",
        evidenceRefs: [snapshot.snapshotId],
      }],
    }, clock),
    /missing.*before|cutoff/i,
  );
});

test("post-request stale output rejected until re-observe", async () => {
  const clock = clockAt("2024-01-01T00:00:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser("collector-bot"),
    pullRequest: samplePull({ headOid: "head-a" }),
    reviews: [],
    issueComments: [
      sampleIssueComment({
        id: 1,
        userLogin: "codexbot",
        body: "I will not review",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      }),
    ],
    reviewComments: [],
  });
  const ledger = createCollectorLedger(baseConfig());
  ledger.recordActivation(clock);
  const first = await ledger.observe(transport, clock);
  await ledger.request(
    { legId: "codex", snapshotId: first.snapshot.snapshotId },
    transport,
    clock,
  );
  const decline = ledger.allEvidence().find((item) =>
    item.kind === "issue_comment" && item.authorLogin === "codexbot"
  )!;
  assert.throws(
    () => buildCollectorReceipt(ledger, {
      legs: [{
        legId: "codex",
        status: "unavailable",
        rationale: "declined",
        evidenceRefs: [decline.evidenceId],
        unavailableScope: "global",
      }],
    }, clock),
    /observe after|mutation/i,
  );
  await ledger.observe(transport, clock);
  const receipt = buildCollectorReceipt(ledger, {
    legs: [{
      legId: "codex",
      status: "unavailable",
      rationale: "declined",
      evidenceRefs: [decline.evidenceId],
      unavailableScope: "global",
    }],
  }, clock);
  assert.equal(receipt.legs[0]?.status, "unavailable");
});

test("non-OPEN final snapshot fails with no receipt", async () => {
  const { ledger, clock } = await observeWith([], { prState: "CLOSED" });
  const snap = ledger.latestCompleteSnapshotId!;
  assert.throws(
    () => buildCollectorReceipt(ledger, {
      legs: [{
        legId: "codex",
        status: "missing",
        rationale: "closed",
        evidenceRefs: [snap],
      }],
    }, clock),
    /OPEN/,
  );
});

test("receipt embeds referenced subset and omits unrelated non-author records", async () => {
  const { ledger, snapshot, clock } = await observeWith(
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
  }, clock);
  assert.ok(receipt.evidenceRecords.some((r) => r.evidenceId === review.evidenceId));
  assert.equal(
    receipt.evidenceRecords.some((r) =>
      r.kind === "issue_comment" && r.authorLogin === "random-user"
    ),
    false,
  );
  assert.ok(receipt.snapshots.some((s) => s.snapshotId === snapshot.snapshotId));
  for (const leg of receipt.legs) {
    for (const ref of leg.evidenceRefs) {
      assert.ok(
        receipt.evidenceRecords.some((r) => r.evidenceId === ref) ||
          receipt.snapshots.some((s) => s.snapshotId === ref),
      );
    }
  }
});

test("unavailable rejects wrong-author decoy and binds windowRelation to qualifying proof", async () => {
  const { ledger, clock } = await observeWith([], {
    issueComments: [
      sampleIssueComment({
        id: 1,
        userLogin: "codexbot",
        body: "I decline",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      }),
      sampleIssueComment({
        id: 2,
        userLogin: "evil-author",
        body: "decoy",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      }),
    ],
  });
  const good = ledger.allEvidence().find((item) =>
    item.kind === "issue_comment" && item.authorLogin === "codexbot"
  )!;
  const decoy = ledger.allEvidence().find((item) =>
    item.kind === "issue_comment" && item.authorLogin === "evil-author"
  )!;
  assert.throws(
    () => buildCollectorReceipt(ledger, {
      legs: [{
        legId: "codex",
        status: "unavailable",
        rationale: "mixed",
        evidenceRefs: [decoy.evidenceId, good.evidenceId],
        unavailableScope: "global",
      }],
    }, clock),
    /wrong-author|decoy/i,
  );
  const receipt = buildCollectorReceipt(ledger, {
    legs: [{
      legId: "codex",
      status: "unavailable",
      rationale: "declined",
      evidenceRefs: [good.evidenceId],
      unavailableScope: "global",
    }],
  }, clock);
  const terminal = receipt.reports.find((r) => r.kind === "terminal-fact");
  assert.ok(terminal && terminal.kind === "terminal-fact");
  assert.equal(terminal.windowRelation, "before");
  assert.ok(terminal.evidenceRefs.includes(good.evidenceId));
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
  transport.state.issueComments = [];
  await ledger.observe(transport, clock);

  const globalReceipt = buildCollectorReceipt(ledger, {
    legs: [{
      legId: "codex",
      status: "unavailable",
      rationale: "explicit global decline",
      evidenceRefs: [unavailable.evidenceId],
      unavailableScope: "global",
    }],
  }, clock);
  assert.equal(globalReceipt.legs[0]?.status, "unavailable");
  const terminal = globalReceipt.reports.find((r) => r.kind === "terminal-fact");
  assert.ok(terminal && terminal.kind === "terminal-fact");
  assert.equal(terminal.scope, "global");
  assert.equal("reviewedHead" in terminal, false);

  const ledger2 = createCollectorLedger(baseConfig());
  const clock2 = clockAt("2024-01-01T00:10:00Z");
  ledger2.recordActivation(clock2);
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
  await ledger2.observe(t2, clock2);
  const stale = ledger2.allEvidence().find((i) => i.kind === "issue_comment")!;
  t2.state.pullRequest = samplePull({ headOid: "head-b" });
  t2.state.issueComments = [];
  await ledger2.observe(t2, clock2);
  assert.throws(
    () => buildCollectorReceipt(ledger2, {
      legs: [{
        legId: "codex",
        status: "unavailable",
        rationale: "stale target",
        evidenceRefs: [stale.evidenceId],
        unavailableScope: "target",
      }],
    }, clock2),
    /unavailable|scope|eligible/i,
  );
});

test("recovery attempt embeds recoverySnapshotId in receipt", async () => {
  const clock = clockAt("2024-01-01T00:00:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser("collector-bot"),
    pullRequest: samplePull({ headOid: "head-a" }),
    reviews: [],
    issueComments: [],
    reviewComments: [],
  });
  const ledger = createCollectorLedger(baseConfig());
  ledger.recordActivation(clock);
  const first = await ledger.observe(transport, clock);
  transport.state.createComment = async () => ({
    kind: "ambiguous_loss",
    diagnostics: "lost POST",
  });
  const req = await ledger.request(
    { legId: "codex", snapshotId: first.snapshot.snapshotId },
    transport,
    clock,
  ) as { marker: string };
  transport.state.issueComments = [
    sampleIssueComment({
      id: 99,
      userLogin: "collector-bot",
      body: `Please review.\n${req.marker}\n`,
    }),
  ];
  // also provide decline so we can terminate unavailable after recovery
  transport.state.issueComments.push(
    sampleIssueComment({
      id: 100,
      userLogin: "codexbot",
      body: "I decline",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }),
  );
  const second = await ledger.observe(transport, clock);
  const attempt = ledger.requestAttempts().find((item) => item.status === "recovered")!;
  assert.equal(attempt.recoverySnapshotId, second.snapshot.snapshotId);
  const decline = ledger.allEvidence().find((item) =>
    item.kind === "issue_comment" && item.authorLogin === "codexbot"
  )!;
  const receipt = buildCollectorReceipt(ledger, {
    legs: [{
      legId: "codex",
      status: "unavailable",
      rationale: "declined after recovery",
      evidenceRefs: [decline.evidenceId],
      unavailableScope: "global",
    }],
  }, clock);
  assert.ok(
    receipt.requestAttempts.some((item) =>
      item.status === "recovered" &&
      item.recoverySnapshotId === second.snapshot.snapshotId
    ),
  );
  assert.ok(
    receipt.snapshots.some((s) => s.snapshotId === attempt.recoverySnapshotId),
  );
});

test("edited review after deadline cannot prove unavailable via backdated submitted_at", async () => {
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
  const ledger = createCollectorLedger(baseConfig());
  ledger.recordActivation(clock);
  await ledger.observe(transport, clock);
  clock.advance(20 * 60 * 1000);
  transport.state.reviews = [
    sampleReview({
      id: 1,
      userLogin: "codexbot",
      state: "COMMENTED",
      body: "I decline after deadline",
      commitId: "head-c",
      submittedAt: "2024-01-01T00:00:00Z",
    }),
  ];
  await ledger.observe(transport, clock);
  const later = ledger.allEvidence().find((item) =>
    item.kind === "review" && item.body?.includes("decline")
  )!;
  assert.equal(later.windowRelation, "uncertain");
  // unavailable based solely on uncertain post-edit must fail
  assert.throws(
    () => buildCollectorReceipt(ledger, {
      legs: [{
        legId: "codex",
        status: "unavailable",
        rationale: "edited decline",
        evidenceRefs: [later.evidenceId],
        unavailableScope: "target",
      }],
    }, clock),
    /unavailable|eligible|window/i,
  );
});

test("receipt and ledger overflow latch fatal infrastructure failure", async () => {
  const clock = clockAt("2024-01-01T00:10:00Z");
  const ledger = createCollectorLedger(baseConfig());
  ledger.recordActivation(clock);
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-c" }),
    reviews: [],
    issueComments: [],
    reviewComments: [],
  });

  // Grow ledger materialization past 32 MiB; observe must latchFatal (not model-retriable).
  let overflowed = false;
  for (let i = 0; i < 20; i++) {
    transport.state.reviews = [
      sampleReview({
        id: 99,
        userLogin: "codexbot",
        state: "COMMENTED",
        commitId: "head-c",
        submittedAt: "2024-01-01T00:00:00Z",
        body: `${"Z".repeat(2_000_000)}-${i}`,
      }),
    ];
    try {
      await ledger.observe(transport, clock);
    } catch (error) {
      overflowed = true;
      assert.equal(ledger.fatal, true);
      assert.ok(error instanceof Error);
      assert.match(error.message, /32|bytes|ledger|receipt/i);
      assert.equal((error as { collectorFatal?: boolean }).collectorFatal, true);
      break;
    }
  }
  assert.equal(overflowed, true);
  assert.ok(COLLECTOR_RECEIPT_MAX_BYTES === 32 * 1024 * 1024);
});
