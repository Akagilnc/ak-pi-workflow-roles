import assert from "node:assert/strict";
import test from "node:test";

import {
  COLLECTOR_RECEIPT_MAX_BYTES,
  type CollectorClock,
} from "../src/collector-evidence.ts";
import {
  classifyCollectorBatch,
  collectorToolArgumentsValid,
  COLLECTOR_OBSERVE_TOOL,
  COLLECTOR_OUTPUT_TOOL,
  createCollectorLedger,
} from "../src/collector-ledger.ts";
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
    /failed schema validation/i,
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
    /failed schema validation/i,
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
      // late review is expected-author material: allowed as a model cite, not auto-linked
      evidenceRefs: [snapshot.snapshotId, review.evidenceId],
    }],
  }, clock);
  assert.equal(receipt.legs[0]?.status, "missing");
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

// ---------------------------------------------------------------------------
// F1 schema owner matrix
// ---------------------------------------------------------------------------

test("F1 parseCollectorOutputCandidate schema matrix", () => {
  assert.deepEqual(
    parseCollectorOutputCandidate({
      legs: [{
        legId: "codex",
        status: "missing",
        rationale: "line1\nline2 still nonblank",
        evidenceRefs: ["snap"],
      }],
    }).legs[0]?.rationale,
    "line1\nline2 still nonblank",
  );
  const unavailable = parseCollectorOutputCandidate({
    legs: [{
      legId: "codex",
      status: "unavailable",
      rationale: "declined",
      evidenceRefs: ["e1"],
      unavailableScope: "global",
    }],
  });
  assert.equal(unavailable.legs[0]?.unavailableScope, "global");

  const invalids: Array<[string, unknown]> = [
    ["unknown leg field", {
      legs: [{
        legId: "codex",
        status: "valid",
        rationale: "ok",
        evidenceRefs: ["x"],
        extra: true,
      }],
    }],
    ["unavailable missing scope", {
      legs: [{
        legId: "codex",
        status: "unavailable",
        rationale: "ok",
        evidenceRefs: ["x"],
      }],
    }],
    ["unavailable invalid scope", {
      legs: [{
        legId: "codex",
        status: "unavailable",
        rationale: "ok",
        evidenceRefs: ["x"],
        unavailableScope: "galaxy",
      }],
    }],
    ["scope on valid", {
      legs: [{
        legId: "codex",
        status: "valid",
        rationale: "ok",
        evidenceRefs: ["x"],
        unavailableScope: "global",
      }],
    }],
    ["scope on missing", {
      legs: [{
        legId: "codex",
        status: "missing",
        rationale: "ok",
        evidenceRefs: ["x"],
        unavailableScope: "target",
      }],
    }],
    ["blank rationale", {
      legs: [{
        legId: "codex",
        status: "valid",
        rationale: "   ",
        evidenceRefs: ["x"],
      }],
    }],
    ["empty refs", {
      legs: [{
        legId: "codex",
        status: "valid",
        rationale: "ok",
        evidenceRefs: [],
      }],
    }],
    ["unknown top-level", {
      legs: [{
        legId: "codex",
        status: "valid",
        rationale: "ok",
        evidenceRefs: ["x"],
      }],
      extra: 1,
    }],
    ["missing legs", {}],
    ["null raw", null],
  ];
  for (const [label, raw] of invalids) {
    assert.throws(
      () => parseCollectorOutputCandidate(raw),
      /failed schema validation/i,
      label,
    );
  }

  // Shared Check owner used by batch classify — no second validator fork.
  assert.equal(collectorToolArgumentsValid(COLLECTOR_OBSERVE_TOOL, undefined), false);
  assert.equal(collectorToolArgumentsValid(COLLECTOR_OBSERVE_TOOL, null), false);
  assert.equal(collectorToolArgumentsValid(COLLECTOR_OBSERVE_TOOL, {}), true);
  // observe rejects non-empty object (additionalProperties: false)
  assert.equal(collectorToolArgumentsValid(COLLECTOR_OBSERVE_TOOL, { x: 1 }), false);

  for (const [label, raw] of invalids) {
    if (raw === null) continue;
    assert.equal(
      collectorToolArgumentsValid(COLLECTOR_OUTPUT_TOOL, raw),
      false,
      `shared-check ${label}`,
    );
    const batch = classifyCollectorBatch(
      [{
        type: "toolCall",
        id: "out-1",
        name: COLLECTOR_OUTPUT_TOOL,
        arguments: raw,
      }],
      { outputAccepted: false, hasCompletedOperationalOrSnapshot: true },
    );
    assert.equal(batch.allow, false, `batch ${label}`);
  }
  // observe envelope at classify: undefined|null illegal; {} legal shape
  for (const bad of [undefined, null]) {
    const batch = classifyCollectorBatch(
      [{
        type: "toolCall",
        id: "obs-1",
        name: COLLECTOR_OBSERVE_TOOL,
        arguments: bad,
      }],
      { outputAccepted: false, hasCompletedOperationalOrSnapshot: false },
    );
    assert.equal(batch.allow, false, `observe ${String(bad)}`);
  }
  // Empty-object observe is schema-valid (batch may still deny for other laws).
  assert.equal(
    collectorToolArgumentsValid(COLLECTOR_OBSERVE_TOOL, {}),
    true,
  );
});

// ---------------------------------------------------------------------------
// F2 leg-owned receipt refs
// ---------------------------------------------------------------------------

function twoLegConfig() {
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
          id: "a",
          expectedAuthors: ["author-a"],
          requestBody: "Please review a.",
        },
        {
          id: "b",
          expectedAuthors: ["author-b"],
          requestBody: "Please review b.",
        },
      ],
      canonicalJson: "{}\n",
      digest: "c".repeat(64),
      sourcePath: "/tmp/legs-two.json",
    },
  };
}

test("F2-latestRelevant-recovered-then-succeeded", async () => {
  const clock = clockAt("2024-01-01T00:00:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser("collector-bot"),
    pullRequest: samplePull({ headOid: "head-a" }),
    reviews: [],
    issueComments: [],
    reviewComments: [],
  });
  const ledger = createCollectorLedger(twoLegConfig());
  ledger.recordActivation(clock);

  const snapA = (await ledger.observe(transport, clock)).snapshot;

  transport.state.createComment = async () => ({
    kind: "ambiguous_loss",
    diagnostics: "lost POST",
  });
  const reqA1 = await ledger.request(
    { legId: "a", snapshotId: snapA.snapshotId },
    transport,
    clock,
  ) as { marker: string; status: string };
  assert.equal(reqA1.status, "ambiguous_loss");

  transport.state.issueComments = [
    sampleIssueComment({
      id: 501,
      userLogin: "collector-bot",
      body: `Please review.\n${reqA1.marker}\n`,
      createdAt: "2024-01-01T00:01:00Z",
      updatedAt: "2024-01-01T00:01:00Z",
    }),
  ];
  const snapRecover = (await ledger.observe(transport, clock)).snapshot;
  const older = ledger.requestAttempts().find((t) =>
    t.legId === "a" && t.status === "recovered"
  )!;
  assert.equal(older.status, "recovered");
  assert.equal(typeof older.commentEvidenceId, "string");
  assert.equal(older.snapshotId, snapA.snapshotId);
  assert.equal(older.recoverySnapshotId, snapRecover.snapshotId);
  assert.ok(
    typeof older.commentEvidenceId === "string" &&
      typeof older.snapshotId === "string" &&
      typeof older.recoverySnapshotId === "string",
  );

  transport.state.pullRequest = samplePull({ headOid: "head-b" });
  delete transport.state.createComment;
  // keep older marker comment immutable
  const snapB = (await ledger.observe(transport, clock)).snapshot;
  const reqA2 = await ledger.request(
    { legId: "a", snapshotId: snapB.snapshotId },
    transport,
    clock,
  ) as { status: string };
  assert.equal(reqA2.status, "succeeded");
  const later = ledger.requestAttempts().filter((t) => t.legId === "a").at(-1)!;
  assert.equal(later.status, "succeeded");
  assert.notEqual(later.attemptId, older.attemptId);
  assert.equal(later.snapshotId, snapB.snapshotId);
  assert.equal(later.recoverySnapshotId, undefined);
  assert.equal(typeof later.commentEvidenceId, "string");

  clock.advance(16 * 60 * 1000);
  const final = (await ledger.observe(transport, clock)).snapshot;
  const receipt = buildCollectorReceipt(ledger, {
    legs: [
      {
        legId: "a",
        status: "missing",
        rationale: "a missing",
        evidenceRefs: [final.snapshotId],
      },
      {
        legId: "b",
        status: "missing",
        rationale: "b missing",
        evidenceRefs: [final.snapshotId],
      },
    ],
  }, clock);

  const legA = receipt.legs.find((l) => l.legId === "a")!;
  const reportA = receipt.reports.find((r) =>
    r.kind === "terminal-fact" && r.legId === "a"
  )!;
  const legB = receipt.legs.find((l) => l.legId === "b")!;
  const reportB = receipt.reports.find((r) =>
    r.kind === "terminal-fact" && r.legId === "b"
  )!;
  for (const refs of [legA.evidenceRefs, reportA.evidenceRefs]) {
    assert.ok(refs.includes(later.commentEvidenceId!));
    assert.ok(refs.includes(later.snapshotId));
    assert.ok(refs.includes(final.snapshotId));
    assert.equal(refs.includes(older.commentEvidenceId!), false);
    assert.equal(refs.includes(older.snapshotId), false);
    assert.equal(refs.includes(older.recoverySnapshotId!), false);
  }
  assert.deepEqual(legA.evidenceRefs, reportA.evidenceRefs);

  const aOwned = [
    older.commentEvidenceId!,
    older.snapshotId,
    older.recoverySnapshotId!,
    later.commentEvidenceId!,
    later.snapshotId,
  ];
  for (const refs of [legB.evidenceRefs, reportB.evidenceRefs]) {
    for (const id of aOwned) {
      assert.equal(refs.includes(id), false, `leg b contaminated by ${id}`);
    }
  }
  assert.deepEqual(legB.evidenceRefs, reportB.evidenceRefs);
});

test("F2 two-leg missing contamination: request only a", async () => {
  const clock = clockAt("2024-01-01T00:00:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser("collector-bot"),
    pullRequest: samplePull({ headOid: "head-a" }),
    reviews: [],
    issueComments: [],
    reviewComments: [],
  });
  const ledger = createCollectorLedger(twoLegConfig());
  ledger.recordActivation(clock);
  const first = (await ledger.observe(transport, clock)).snapshot;
  const req = await ledger.request(
    { legId: "a", snapshotId: first.snapshotId },
    transport,
    clock,
  ) as { status: string; commentEvidenceId?: string };
  assert.equal(req.status, "succeeded");
  clock.advance(16 * 60 * 1000);
  const final = (await ledger.observe(transport, clock)).snapshot;
  const attempt = ledger.requestAttempts().find((t) => t.legId === "a")!;
  const receipt = buildCollectorReceipt(ledger, {
    legs: [
      {
        legId: "a",
        status: "missing",
        rationale: "a",
        evidenceRefs: [final.snapshotId],
      },
      {
        legId: "b",
        status: "missing",
        rationale: "b",
        evidenceRefs: [final.snapshotId],
      },
    ],
  }, clock);
  const legA = receipt.legs.find((l) => l.legId === "a")!;
  const legB = receipt.legs.find((l) => l.legId === "b")!;
  const termA = receipt.reports.find((r) =>
    r.kind === "terminal-fact" && r.legId === "a"
  )!;
  const termB = receipt.reports.find((r) =>
    r.kind === "terminal-fact" && r.legId === "b"
  )!;
  assert.ok(legA.evidenceRefs.includes(attempt.commentEvidenceId!));
  assert.deepEqual(legA.evidenceRefs, termA.evidenceRefs);
  assert.equal(legB.evidenceRefs.includes(attempt.commentEvidenceId!), false);
  assert.equal(legB.evidenceRefs.includes(attempt.snapshotId), false);
  assert.deepEqual(legB.evidenceRefs, termB.evidenceRefs);
});

test("F2 M1-M3b missing decoys fail closed one at a time", async () => {
  const clock = clockAt("2024-01-01T00:00:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser("collector-bot"),
    pullRequest: samplePull({ headOid: "head-a" }),
    reviews: [],
    issueComments: [],
    reviewComments: [],
  });
  const ledger = createCollectorLedger(twoLegConfig());
  ledger.recordActivation(clock);
  const snapA = (await ledger.observe(transport, clock)).snapshot;

  // recover path for recoverySnapshotId source
  transport.state.createComment = async () => ({
    kind: "ambiguous_loss",
    diagnostics: "lost",
  });
  const reqA1 = await ledger.request(
    { legId: "a", snapshotId: snapA.snapshotId },
    transport,
    clock,
  ) as { marker: string };
  transport.state.issueComments = [
    sampleIssueComment({
      id: 601,
      userLogin: "collector-bot",
      body: `Please review.\n${reqA1.marker}\n`,
    }),
  ];
  await ledger.observe(transport, clock);
  const recovered = ledger.requestAttempts().find((t) =>
    t.legId === "a" && t.status === "recovered"
  )!;

  delete transport.state.createComment;
  transport.state.pullRequest = samplePull({ headOid: "head-b" });
  const snapB = (await ledger.observe(transport, clock)).snapshot;
  await ledger.request(
    { legId: "a", snapshotId: snapB.snapshotId },
    transport,
    clock,
  );
  const succeeded = ledger.requestAttempts().filter((t) =>
    t.legId === "a" && t.status === "succeeded"
  ).at(-1)!;

  clock.advance(16 * 60 * 1000);
  const final = (await ledger.observe(transport, clock)).snapshot;

  const missingBoth = (aRefs: string[], bRefs: string[]) => ({
    legs: [
      { legId: "a", status: "missing" as const, rationale: "a", evidenceRefs: aRefs },
      { legId: "b", status: "missing" as const, rationale: "b", evidenceRefs: bRefs },
    ],
  });

  // M1 cross-leg a.commentEvidenceId on b
  assert.throws(
    () => buildCollectorReceipt(ledger, missingBoth(
      [final.snapshotId],
      [final.snapshotId, succeeded.commentEvidenceId!],
    ), clock),
    /disallowed|missing/i,
  );
  // M2a cross-leg a.snapshotId on b
  assert.throws(
    () => buildCollectorReceipt(ledger, missingBoth(
      [final.snapshotId],
      [final.snapshotId, succeeded.snapshotId],
    ), clock),
    /disallowed|missing/i,
  );
  // M2b cross-leg a.recoverySnapshotId on b
  assert.throws(
    () => buildCollectorReceipt(ledger, missingBoth(
      [final.snapshotId],
      [final.snapshotId, recovered.recoverySnapshotId!],
    ), clock),
    /disallowed|missing/i,
  );
  // M3a dangling evidence id
  assert.throws(
    () => buildCollectorReceipt(ledger, missingBoth(
      [final.snapshotId, "ev:dangling-missing"],
      [final.snapshotId],
    ), clock),
    /absent|disallowed|missing/i,
  );
  // M3b dangling snapshot id
  assert.throws(
    () => buildCollectorReceipt(ledger, missingBoth(
      [final.snapshotId, "snap:dangling-missing"],
      [final.snapshotId],
    ), clock),
    /absent|disallowed|missing/i,
  );
  // M-clean: leg refs ≡ terminal-fact refs per leg
  const clean = buildCollectorReceipt(ledger, missingBoth(
    [final.snapshotId],
    [final.snapshotId],
  ), clock);
  assert.equal(clean.legs.length, 2);
  for (const legId of ["a", "b"] as const) {
    const leg = clean.legs.find((l) => l.legId === legId)!;
    const term = clean.reports.find((r) =>
      r.kind === "terminal-fact" && r.legId === legId
    )!;
    assert.deepEqual(leg.evidenceRefs, term.evidenceRefs, `M-clean ${legId}`);
  }
});

test("F2 U1-U5 unavailable mandated decoys fail closed one at a time", async () => {
  const clock = clockAt("2024-01-01T00:00:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser("collector-bot"),
    pullRequest: samplePull({ headOid: "head-c" }),
    reviews: [],
    issueComments: [],
    reviewComments: [],
  });
  const ledger = createCollectorLedger(twoLegConfig());
  ledger.recordActivation(clock);

  // Establish authenticated requester marker on leg a.
  const first = (await ledger.observe(transport, clock)).snapshot;
  const req = await ledger.request(
    { legId: "a", snapshotId: first.snapshotId },
    transport,
    clock,
  ) as { status: string; commentEvidenceId?: string };
  assert.equal(req.status, "succeeded");
  const markerAttempt = ledger.requestAttempts().find((t) => t.legId === "a")!;
  const markerCommentId = markerAttempt.commentEvidenceId!;

  // Expected-author proofs + wrong-author extra on same PR.
  transport.state.issueComments = [
    ...(transport.state.issueComments ?? []),
    sampleIssueComment({
      id: 101,
      userLogin: "author-a",
      body: "I decline a",
      createdAt: "2024-01-01T00:01:00Z",
      updatedAt: "2024-01-01T00:01:00Z",
    }),
    sampleIssueComment({
      id: 102,
      userLogin: "author-b",
      body: "I decline b",
      createdAt: "2024-01-01T00:01:00Z",
      updatedAt: "2024-01-01T00:01:00Z",
    }),
    sampleIssueComment({
      id: 103,
      userLogin: "evil",
      body: "decoy",
      createdAt: "2024-01-01T00:01:00Z",
      updatedAt: "2024-01-01T00:01:00Z",
    }),
  ];
  await ledger.observe(transport, clock);
  const aProof = ledger.allEvidence().find((e) =>
    e.kind === "issue_comment" && e.authorLogin === "author-a" && e.body === "I decline a"
  )!;
  const bProof = ledger.allEvidence().find((e) =>
    e.kind === "issue_comment" && e.authorLogin === "author-b" && e.body === "I decline b"
  )!;
  const wrongAuthor = ledger.allEvidence().find((e) =>
    e.kind === "issue_comment" && e.authorLogin === "evil"
  )!;

  // Separate real ledger fixture for unrelated PR evidence + snapshot ids.
  const unrelatedClock = clockAt("2024-02-01T00:00:00Z");
  const unrelatedTransport = createFakeGitHubTransport({
    user: sampleUser("other-bot"),
    pullRequest: samplePull({ number: 99, headOid: "unrelated-head" }),
    reviews: [
      sampleReview({
        id: 9001,
        userLogin: "author-a",
        state: "COMMENTED",
        body: "unrelated PR proof",
        commitId: "unrelated-head",
        submittedAt: "2024-02-01T00:00:00Z",
      }),
    ],
    issueComments: [],
    reviewComments: [],
  });
  const unrelatedLedger = createCollectorLedger({
    ...twoLegConfig(),
    prNumber: 99,
    repository: {
      display: "Other/Repo",
      canonical: "other/repo",
      owner: "other",
      repo: "repo",
    },
  });
  unrelatedLedger.recordActivation(unrelatedClock);
  await unrelatedLedger.observe(unrelatedTransport, unrelatedClock);
  const unrelatedEvidence = unrelatedLedger.allEvidence().find((e) =>
    e.kind === "review" && e.body === "unrelated PR proof"
  )!;
  const unrelatedSnapshotId = unrelatedLedger.latestCompleteSnapshotId!;
  assert.notEqual(unrelatedEvidence.evidenceId, aProof.evidenceId);
  assert.notEqual(unrelatedSnapshotId, ledger.latestCompleteSnapshotId);

  const unavail = (aRefs: string[], bRefs: string[]) => ({
    legs: [
      {
        legId: "a",
        status: "unavailable" as const,
        rationale: "a",
        evidenceRefs: aRefs,
        unavailableScope: "global" as const,
      },
      {
        legId: "b",
        status: "unavailable" as const,
        rationale: "b",
        evidenceRefs: bRefs,
        unavailableScope: "global" as const,
      },
    ],
  });

  // U1 cross-leg authenticated requester marker/comment on b
  assert.throws(
    () => buildCollectorReceipt(
      ledger,
      unavail([aProof.evidenceId], [markerCommentId]),
      clock,
    ),
    /ownership|disallowed|non-eligible|unavailable|wrong-author|non-qualifying/i,
  );
  // U2 cross-leg expected-author evidence (a proof on b)
  assert.throws(
    () => buildCollectorReceipt(
      ledger,
      unavail([aProof.evidenceId], [aProof.evidenceId]),
      clock,
    ),
    /ownership|disallowed|non-eligible|unavailable|wrong-author/i,
  );
  // U3 after-window evidence
  {
    const clock2 = clockAt("2024-01-01T00:10:00Z");
    const t2 = createFakeGitHubTransport({
      user: sampleUser("collector-bot"),
      pullRequest: samplePull({ headOid: "head-c" }),
      reviews: [],
      issueComments: [],
      reviewComments: [],
    });
    const ledger2 = createCollectorLedger(twoLegConfig());
    ledger2.recordActivation(clock2);
    await ledger2.observe(t2, clock2);
    clock2.advance(20 * 60 * 1000);
    t2.state.issueComments = [
      sampleIssueComment({
        id: 9,
        userLogin: "author-a",
        body: "late decline",
        createdAt: "2024-01-01T00:40:00Z",
        updatedAt: "2024-01-01T00:40:00Z",
      }),
      sampleIssueComment({
        id: 10,
        userLogin: "author-b",
        body: "ok b",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      }),
    ];
    await ledger2.observe(t2, clock2);
    const lateA = ledger2.allEvidence().find((e) =>
      e.kind === "issue_comment" && e.authorLogin === "author-a"
    )!;
    const goodB = ledger2.allEvidence().find((e) =>
      e.kind === "issue_comment" && e.authorLogin === "author-b"
    )!;
    assert.throws(
      () => buildCollectorReceipt(ledger2, {
        legs: [
          {
            legId: "a",
            status: "unavailable",
            rationale: "late",
            evidenceRefs: [lateA.evidenceId],
            unavailableScope: "global",
          },
          {
            legId: "b",
            status: "unavailable",
            rationale: "b",
            evidenceRefs: [goodB.evidenceId],
            unavailableScope: "global",
          },
        ],
      }, clock2),
      /non-eligible|unavailable|window|non-qualifying/i,
    );
  }
  // U4 actual unrelated PR evidence id (from separate real ledger fixture)
  assert.throws(
    () => buildCollectorReceipt(
      ledger,
      unavail([unrelatedEvidence.evidenceId], [bProof.evidenceId]),
      clock,
    ),
    /absent|non-qualifying|unavailable|non-eligible/i,
  );
  // U5 actual unrelated snapshot id (from separate real ledger fixture)
  assert.throws(
    () => buildCollectorReceipt(
      ledger,
      unavail([unrelatedSnapshotId], [bProof.evidenceId]),
      clock,
    ),
    /absent|non-qualifying|unavailable|non-eligible/i,
  );

  // Extras only (not substitutes for the five mandated rows)
  assert.throws(
    () => buildCollectorReceipt(
      ledger,
      unavail([wrongAuthor.evidenceId], [bProof.evidenceId]),
      clock,
    ),
    /wrong-author|non-eligible|unavailable/i,
  );
  assert.throws(
    () => buildCollectorReceipt(
      ledger,
      unavail(["ev:dangling-extra"], [bProof.evidenceId]),
      clock,
    ),
    /absent|non-qualifying|unavailable/i,
  );

  // U-clean: leg + terminal-fact refs match per leg (proof only)
  const clean = buildCollectorReceipt(
    ledger,
    unavail([aProof.evidenceId], [bProof.evidenceId]),
    clock,
  );
  const termA = clean.reports.find((r) =>
    r.kind === "terminal-fact" && r.legId === "a"
  )!;
  const termB = clean.reports.find((r) =>
    r.kind === "terminal-fact" && r.legId === "b"
  )!;
  const legA = clean.legs.find((l) => l.legId === "a")!;
  const legB = clean.legs.find((l) => l.legId === "b")!;
  assert.deepEqual(legA.evidenceRefs, [aProof.evidenceId]);
  assert.deepEqual(legB.evidenceRefs, [bProof.evidenceId]);
  assert.deepEqual(termA.evidenceRefs, legA.evidenceRefs);
  assert.deepEqual(termB.evidenceRefs, legB.evidenceRefs);
});

// ---------------------------------------------------------------------------
// F3 §3.1 timestamp-less review + retention
// ---------------------------------------------------------------------------

test("F3-timestamp-less-review-state", async () => {
  const clock = clockAt("2024-01-01T00:10:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-c" }),
    reviews: [
      sampleReview({
        id: 1,
        userLogin: "codexbot",
        state: "APPROVED",
        body: "LGTM",
        commitId: "head-c",
        submittedAt: "2024-01-01T00:00:00Z",
        raw: {},
      }),
    ],
    issueComments: [],
    reviewComments: [],
  });
  const ledger = createCollectorLedger(baseConfig());
  ledger.recordActivation(clock);
  await ledger.observe(transport, clock);
  const first = ledger.allEvidence().find((r) =>
    r.kind === "review" && r.state === "APPROVED"
  )!;
  assert.equal(first.authoritativeTime, "2024-01-01T00:00:00Z");
  assert.equal(first.windowRelation, "before");

  transport.state.reviews = [
    sampleReview({
      id: 1,
      userLogin: "codexbot",
      state: "DISMISSED",
      body: "LGTM",
      commitId: "head-c",
      submittedAt: "2024-01-01T00:00:00Z",
      raw: {},
    }),
  ];
  await ledger.observe(transport, clock);
  const later = ledger.allEvidence().find((r) =>
    r.kind === "review" && r.state === "DISMISSED"
  )!;
  assert.notEqual(later.versionId, first.versionId);
  assert.equal(later.authoritativeTime, null);
  assert.equal(later.windowRelation, "uncertain");
  assert.ok(
    ledger.allEvidence().some((r) =>
      r.kind === "review" && r.versionId === first.versionId
    ),
  );
  assert.throws(
    () => buildCollectorReceipt(ledger, {
      legs: [{
        legId: "codex",
        status: "valid",
        rationale: "dismissed only",
        evidenceRefs: [later.evidenceId],
      }],
    }, clock),
    /qualifying|valid/i,
  );
});

test("F3-timestamp-less-review-text", async () => {
  const clock = clockAt("2024-01-01T00:10:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-c" }),
    reviews: [
      sampleReview({
        id: 2,
        userLogin: "codexbot",
        state: "COMMENTED",
        body: "still looking",
        commitId: "head-c",
        submittedAt: "2024-01-01T00:00:00Z",
        raw: {},
      }),
    ],
    issueComments: [],
    reviewComments: [],
  });
  const ledger = createCollectorLedger(baseConfig());
  ledger.recordActivation(clock);
  await ledger.observe(transport, clock);
  const first = ledger.allEvidence().find((r) =>
    r.kind === "review" && r.body === "still looking"
  )!;
  assert.equal(first.authoritativeTime, "2024-01-01T00:00:00Z");
  assert.equal(first.windowRelation, "before");

  transport.state.reviews = [
    sampleReview({
      id: 2,
      userLogin: "codexbot",
      state: "COMMENTED",
      body: "I will not review this PR",
      commitId: "head-c",
      submittedAt: "2024-01-01T00:00:00Z",
      raw: {},
    }),
  ];
  await ledger.observe(transport, clock);
  const later = ledger.allEvidence().find((r) =>
    r.kind === "review" && r.body === "I will not review this PR"
  )!;
  assert.equal(later.authoritativeTime, null);
  assert.equal(later.windowRelation, "uncertain");
  assert.equal(later.stableGitHubId, "review:2");
  assert.ok(
    ledger.allEvidence().some((r) =>
      r.kind === "review" && r.body === "still looking"
    ),
  );
  assert.throws(
    () => buildCollectorReceipt(ledger, {
      legs: [{
        legId: "codex",
        status: "unavailable",
        rationale: "uncertain text",
        evidenceRefs: [later.evidenceId],
        unavailableScope: "target",
      }],
    }, clock),
    /unavailable|eligible|window/i,
  );
});

test("F3 v3 before-deadline comment edit after deadline", async () => {
  const clock = clockAt("2024-01-01T00:10:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-c" }),
    reviews: [],
    issueComments: [
      sampleIssueComment({
        id: 100,
        userLogin: "codexbot",
        body: "early decline",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      }),
    ],
    reviewComments: [],
  });
  const ledger = createCollectorLedger(baseConfig());
  ledger.recordActivation(clock);
  await ledger.observe(transport, clock);
  const early = ledger.allEvidence().find((e) =>
    e.kind === "issue_comment" && e.body === "early decline"
  )!;
  assert.equal(early.windowRelation, "before");

  clock.advance(20 * 60 * 1000);
  transport.state.issueComments = [
    sampleIssueComment({
      id: 100,
      userLogin: "codexbot",
      body: "edited after deadline",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:40:00Z",
    }),
  ];
  await ledger.observe(transport, clock);
  const terminal = ledger.allEvidence().find((e) =>
    e.kind === "issue_comment" && e.body === "edited after deadline"
  )!;
  assert.equal(terminal.windowRelation, "after");
  assert.ok(
    ledger.allEvidence().some((e) =>
      e.kind === "issue_comment" && e.body === "early decline"
    ),
  );
  assert.throws(
    () => buildCollectorReceipt(ledger, {
      legs: [{
        legId: "codex",
        status: "unavailable",
        rationale: "only terminal",
        evidenceRefs: [terminal.evidenceId],
        unavailableScope: "global",
      }],
    }, clock),
    /unavailable|eligible|window/i,
  );
  // missing may preserve both via model cites
  const snap = ledger.latestCompleteSnapshotId!;
  const missing = buildCollectorReceipt(ledger, {
    legs: [{
      legId: "codex",
      status: "missing",
      rationale: "no eligible",
      evidenceRefs: [snap, early.evidenceId, terminal.evidenceId],
    }],
  }, clock);
  assert.ok(missing.legs[0]!.evidenceRefs.includes(early.evidenceId));
  assert.ok(missing.legs[0]!.evidenceRefs.includes(terminal.evidenceId));
});

async function retentionLedgerAndReceipt(input: {
  initial: ReturnType<typeof sampleReview>[];
  later: ReturnType<typeof sampleReview>[];
}) {
  const clock = clockAt("2024-01-01T00:10:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-c" }),
    reviews: input.initial,
    issueComments: [],
    reviewComments: [],
  });
  const ledger = createCollectorLedger(baseConfig());
  ledger.recordActivation(clock);
  await ledger.observe(transport, clock);
  transport.state.reviews = input.later;
  await ledger.observe(transport, clock);
  // Missing is only legal at/after eligibility cutoff.
  clock.advance(16 * 60 * 1000);
  await ledger.observe(transport, clock);
  const snap = ledger.latestCompleteSnapshotId!;
  const receipt = buildCollectorReceipt(ledger, {
    legs: [{
      legId: "codex",
      status: "missing",
      rationale: "retention probe",
      evidenceRefs: [snap],
    }],
  }, clock);
  return { ledger, receipt };
}

function reviewReportsFor(
  receipt: ReturnType<typeof buildCollectorReceipt>,
  body: string,
) {
  return receipt.reports.filter((r) =>
    r.kind === "review" && r.report.includes(body)
  );
}

test("F3 review edit retention", async () => {
  const { ledger, receipt } = await retentionLedgerAndReceipt({
    initial: [
      sampleReview({
        id: 10,
        userLogin: "codexbot",
        state: "APPROVED",
        body: "v1 body",
        commitId: "head-c",
        submittedAt: "2024-01-01T00:00:00Z",
      }),
    ],
    later: [
      sampleReview({
        id: 10,
        userLogin: "codexbot",
        state: "APPROVED",
        body: "v2 edited body",
        commitId: "head-c",
        submittedAt: "2024-01-01T00:00:00Z",
      }),
    ],
  });
  const v1 = ledger.allEvidence().find((r) =>
    r.kind === "review" && r.body === "v1 body"
  )!;
  const v2 = ledger.allEvidence().find((r) =>
    r.kind === "review" && r.body === "v2 edited body"
  )!;
  const reportsV1 = reviewReportsFor(receipt, "v1 body");
  const reportsV2 = reviewReportsFor(receipt, "v2 edited body");
  assert.equal(reportsV1.length, 1);
  assert.equal(reportsV2.length, 1);
  assert.ok(reportsV1[0]!.evidenceRefs.includes(v1.evidenceId));
  assert.ok(reportsV2[0]!.evidenceRefs.includes(v2.evidenceId));
  assert.deepEqual(reportsV1[0]!.evidenceRefs, [v1.evidenceId]);
  assert.deepEqual(reportsV2[0]!.evidenceRefs, [v2.evidenceId]);
});

test("F3 review dismiss retention", async () => {
  const { ledger, receipt } = await retentionLedgerAndReceipt({
    initial: [
      sampleReview({
        id: 11,
        userLogin: "codexbot",
        state: "COMMENTED",
        body: "will dismiss",
        commitId: "head-c",
        submittedAt: "2024-01-01T00:01:00Z",
      }),
    ],
    later: [
      sampleReview({
        id: 11,
        userLogin: "codexbot",
        state: "DISMISSED",
        body: "will dismiss",
        commitId: "head-c",
        submittedAt: "2024-01-01T00:01:00Z",
      }),
    ],
  });
  const prior = ledger.allEvidence().find((r) =>
    r.kind === "review" && r.state === "COMMENTED" && r.body === "will dismiss"
  )!;
  const dismissed = ledger.allEvidence().find((r) =>
    r.kind === "review" && r.state === "DISMISSED" && r.body === "will dismiss"
  )!;
  const priorReports = receipt.reports.filter((r) =>
    r.kind === "review" && r.evidenceRefs.includes(prior.evidenceId)
  );
  const dismissedReports = receipt.reports.filter((r) =>
    r.kind === "review" && r.evidenceRefs.includes(dismissed.evidenceId)
  );
  assert.equal(priorReports.length, 1);
  assert.equal(dismissedReports.length, 1);
  assert.ok(priorReports[0]!.evidenceRefs.includes(prior.evidenceId));
  assert.ok(dismissedReports[0]!.evidenceRefs.includes(dismissed.evidenceId));
});

test("F3 review disappearance retention", async () => {
  const { ledger, receipt } = await retentionLedgerAndReceipt({
    initial: [
      sampleReview({
        id: 12,
        userLogin: "codexbot",
        state: "CHANGES_REQUESTED",
        body: "will disappear",
        commitId: "head-c",
        submittedAt: "2024-01-01T00:02:00Z",
      }),
    ],
    later: [],
  });
  const disappeared = ledger.allEvidence().find((r) =>
    r.kind === "review" && r.body === "will disappear"
  )!;
  const reports = receipt.reports.filter((r) =>
    r.kind === "review" && r.evidenceRefs.includes(disappeared.evidenceId)
  );
  assert.equal(reports.length, 1);
  assert.ok(reports[0]!.report.includes("will disappear"));
  assert.deepEqual(reports[0]!.evidenceRefs, [disappeared.evidenceId]);
});

// ---------------------------------------------------------------------------
// F3 §3.2 collision facades
// ---------------------------------------------------------------------------

function ledgerFacade(
  real: ReturnType<typeof createCollectorLedger>,
  overrides: Record<string | symbol, unknown>,
): ReturnType<typeof createCollectorLedger> {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) {
        const value = overrides[prop];
        return typeof value === "function" ? value.bind(receiver) : value;
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("F3-collision-duplicate-evidenceId", async () => {
  const clock = clockAt("2024-01-01T00:10:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-c" }),
    reviews: [
      sampleReview({
        id: 1,
        userLogin: "codexbot",
        state: "APPROVED",
        commitId: "head-c",
        submittedAt: "2024-01-01T00:00:00Z",
      }),
    ],
    issueComments: [],
    reviewComments: [],
  });
  const real = createCollectorLedger(baseConfig());
  real.recordActivation(clock);
  await real.observe(transport, clock);
  const review = real.allEvidence().find((r) => r.kind === "review")!;

  const facade = ledgerFacade(real, {
    allEvidence() {
      const rows = [...real.allEvidence()];
      const prRow = rows.find((r) => r.kind === "pull_request")!;
      return [
        ...rows,
        { ...prRow, versionId: "forged-dup-evidence-version" },
      ];
    },
    getEvidence(this: ReturnType<typeof createCollectorLedger>, id: string) {
      return this.allEvidence().find((r) => r.evidenceId === id) ??
        real.getEvidence(id);
    },
  });

  assert.throws(
    () => buildCollectorReceipt(facade, {
      legs: [{
        legId: "codex",
        status: "valid",
        rationale: "ok",
        evidenceRefs: [review.evidenceId],
      }],
    }, clock),
    /evidenceId collision/i,
  );
});

test("F3-collision-duplicate-snapshotId", async () => {
  const clock = clockAt("2024-01-01T00:10:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-c" }),
    reviews: [
      sampleReview({
        id: 1,
        userLogin: "codexbot",
        state: "APPROVED",
        commitId: "head-c",
        submittedAt: "2024-01-01T00:00:00Z",
      }),
    ],
    issueComments: [],
    reviewComments: [],
  });
  const real = createCollectorLedger(baseConfig());
  real.recordActivation(clock);
  await real.observe(transport, clock);
  const review = real.allEvidence().find((r) => r.kind === "review")!;

  const facade = ledgerFacade(real, {
    allSnapshots() {
      const snaps = [...real.allSnapshots()];
      const final = snaps.find((s) =>
        s.snapshotId === real.latestCompleteSnapshotId
      )!;
      return [
        ...snaps,
        { ...final, observedAt: "1970-01-01T00:00:00.000Z" },
      ];
    },
    getSnapshot(this: ReturnType<typeof createCollectorLedger>, id: string) {
      return this.allSnapshots().find((s) => s.snapshotId === id) ??
        real.getSnapshot(id);
    },
  });

  assert.throws(
    () => buildCollectorReceipt(facade, {
      legs: [{
        legId: "codex",
        status: "valid",
        rationale: "ok",
        evidenceRefs: [review.evidenceId],
      }],
    }, clock),
    /snapshotId collision/i,
  );
});

test("F3-collision-cross-namespace", async () => {
  const clock = clockAt("2024-01-01T00:10:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-c" }),
    reviews: [
      sampleReview({
        id: 1,
        userLogin: "codexbot",
        state: "APPROVED",
        commitId: "head-c",
        submittedAt: "2024-01-01T00:00:00Z",
      }),
    ],
    issueComments: [],
    reviewComments: [],
  });
  const real = createCollectorLedger(baseConfig());
  real.recordActivation(clock);
  await real.observe(transport, clock);
  const review = real.allEvidence().find((r) => r.kind === "review")!;
  const pr = real.allEvidence().find((r) => r.kind === "pull_request")!;
  const collisionId = pr.evidenceId;
  const forgedSnapshot = {
    ...real.getSnapshot(real.latestCompleteSnapshotId!)!,
    snapshotId: collisionId,
    observedAt: "1970-01-01T00:00:00.000Z",
  };

  const facade = ledgerFacade(real, {
    allSnapshots() {
      return [...real.allSnapshots(), forgedSnapshot];
    },
    getSnapshot(id: string) {
      if (id === collisionId) return forgedSnapshot;
      return real.getSnapshot(id);
    },
  });

  assert.throws(
    () => buildCollectorReceipt(facade, {
      legs: [{
        legId: "codex",
        status: "valid",
        rationale: "ok",
        evidenceRefs: [review.evidenceId, collisionId],
      }],
    }, clock),
    /ambiguous|namespaces/i,
  );
});

// ---------------------------------------------------------------------------
// F3 §3.4 32 MiB receipt exact boundary (builder path)
// ---------------------------------------------------------------------------

test("F3 receipt exact 32 MiB valid-rationale MAX accept and MAX+1 fatal", async () => {
  async function freshLedger() {
    const clock = clockAt("2024-01-01T00:10:00Z");
    const transport = createFakeGitHubTransport({
      user: sampleUser(),
      pullRequest: samplePull({ headOid: "head-c" }),
      reviews: [
        sampleReview({
          id: 1,
          userLogin: "codexbot",
          state: "APPROVED",
          commitId: "head-c",
          submittedAt: "2024-01-01T00:00:00Z",
          body: "ok",
          raw: {},
        }),
      ],
      issueComments: [],
      reviewComments: [],
    });
    const ledger = createCollectorLedger(baseConfig());
    ledger.recordActivation(clock);
    await ledger.observe(transport, clock);
    const review = ledger.allEvidence().find((r) => r.kind === "review")!;
    return { ledger, clock, reviewId: review.evidenceId };
  }

  function measureReceipt(
    ledger: ReturnType<typeof createCollectorLedger>,
    clock: ReturnType<typeof clockAt>,
    reviewId: string,
    n: number,
  ): number {
    const receipt = buildCollectorReceipt(ledger, {
      legs: [{
        legId: "codex",
        status: "valid",
        rationale: "x".repeat(n),
        evidenceRefs: [reviewId],
      }],
    }, clock);
    return Buffer.byteLength(JSON.stringify(receipt), "utf8");
  }

  const MAX = COLLECTOR_RECEIPT_MAX_BYTES;
  const { ledger, clock, reviewId } = await freshLedger();
  const b1 = measureReceipt(ledger, clock, reviewId, 1);
  // rebuild with fresh ledger because first measure already accepted? No -
  // buildCollectorReceipt doesn't mark outputAccepted; but second call on same
  // ledger is allowed until markOutputAccepted. Good.
  const nMax = MAX - b1 + 1;
  const nMax1 = nMax + 1;

  const { ledger: ledgerMax, clock: clockMax, reviewId: idMax } = await freshLedger();
  assert.equal(measureReceipt(ledgerMax, clockMax, idMax, nMax), MAX);
  assert.equal(ledgerMax.fatal, false);

  const { ledger: ledgerMax1, clock: clockMax1, reviewId: idMax1 } =
    await freshLedger();
  await assert.rejects(
    async () => measureReceipt(ledgerMax1, clockMax1, idMax1, nMax1),
    /receipt exceeded|33554432|bytes/i,
  );
  assert.equal(ledgerMax1.fatal, true);
});
