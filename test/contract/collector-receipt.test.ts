import assert from "node:assert/strict";
import test from "node:test";

import {
  COLLECTOR_RECEIPT_MAX_BYTES,
  type CollectorClock,
} from "../../src/collector-evidence.ts";
import {
  classifyCollectorBatch,
  collectorToolArgumentsValid,
  COLLECTOR_OBSERVE_TOOL,
  COLLECTOR_OUTPUT_TOOL,
  createCollectorLedger,
} from "../../src/collector-ledger.ts";
import {
  buildCollectorReceipt,
  parseCollectorOutputCandidate,
} from "../../src/collector-receipt.ts";
import {
  createFakeGitHubTransport,
  sampleIssueComment,
  samplePull,
  sampleReview,
  sampleReviewComment,
  sampleUser,
} from "../helpers/fake-github-transport.ts";

function clockAt(startWall: string): CollectorClock & {
  advance(ms: number): void;
  setWall(iso: string): void;
} {
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
    setWall(iso) {
      wall = new Date(iso);
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

test("receipt full embed resolves every included snapshot evidence id", async () => {
  const clock = clockAt("2024-01-01T00:10:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser("collector-bot"),
    pullRequest: samplePull({ headOid: "head-a" }),
    reviews: [],
    issueComments: [
      sampleIssueComment({
        id: 50,
        userLogin: "random-user",
        body: "unrelated chatter",
      }),
    ],
    reviewComments: [],
  });
  const ledger = createCollectorLedger(baseConfig());
  ledger.recordActivation(clock);
  await ledger.observe(transport, clock);
  // Second snapshot on new HEAD with a first-seen qualifying review (not an edit).
  transport.state.pullRequest = samplePull({ headOid: "head-b" });
  transport.state.reviews = [
    sampleReview({
      id: 2,
      userLogin: "codexbot",
      state: "APPROVED",
      commitId: "head-b",
      submittedAt: "2024-01-01T00:00:00Z",
    }),
  ];
  await ledger.observe(transport, clock);
  const review = ledger.allEvidence().find((item) =>
    item.kind === "review" && item.commitOid === "head-b"
  )!;
  const receipt = buildCollectorReceipt(ledger, {
    legs: [{
      legId: "codex",
      status: "valid",
      rationale: "ok",
      evidenceRefs: [review.evidenceId],
    }],
  }, clock);
  assert.ok(receipt.snapshots.length >= 2);
  assert.ok(
    receipt.evidenceRecords.some((r) =>
      r.kind === "issue_comment" && r.authorLogin === "random-user"
    ),
    "full embed retains unrelated non-author rows",
  );
  const evidenceIds = new Set(receipt.evidenceRecords.map((r) => r.evidenceId));
  const snapshotIds = new Set(receipt.snapshots.map((s) => s.snapshotId));
  for (const snap of receipt.snapshots) {
    for (const id of snap.evidenceIds) {
      assert.ok(
        evidenceIds.has(id) || snapshotIds.has(id),
        `snapshot ${snap.snapshotId} evidence id ${id} must resolve`,
      );
    }
  }
  for (const leg of receipt.legs) {
    for (const ref of leg.evidenceRefs) {
      assert.ok(evidenceIds.has(ref) || snapshotIds.has(ref));
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

test("global unavailable covers new head; target rejects H1-established comment still on H2", async () => {
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
  // Comment remains present on the new HEAD; establishment HEAD is still H1.
  transport.state.pullRequest = samplePull({ headOid: "head-b" });
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
  const establishedAtH1 = ledger2.allEvidence().find((i) => i.kind === "issue_comment")!;
  // Persistent H1 comment still present on H2 final snapshot — target must not relabel.
  t2.state.pullRequest = samplePull({ headOid: "head-b" });
  await ledger2.observe(t2, clock2);
  assert.ok(
    ledger2.getSnapshot(ledger2.latestCompleteSnapshotId!)!.evidenceIds.includes(
      establishedAtH1.evidenceId,
    ),
    "comment still present on final H2 snapshot",
  );
  assert.throws(
    () => buildCollectorReceipt(ledger2, {
      legs: [{
        legId: "codex",
        status: "unavailable",
        rationale: "stale target establishment",
        evidenceRefs: [establishedAtH1.evidenceId],
        unavailableScope: "target",
      }],
    }, clock2),
    /unavailable|scope|eligible|establishment/i,
  );

  // Headless issue_comment never proves target (no synthetic HEAD binder);
  // same evidence still qualifies for global.
  const ledger3 = createCollectorLedger(baseConfig());
  const clock3 = clockAt("2024-01-01T00:10:00Z");
  ledger3.recordActivation(clock3);
  const t3 = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-b" }),
    reviews: [],
    issueComments: [
      sampleIssueComment({
        id: 3,
        userLogin: "codexbot",
        body: "decline on final head",
        updatedAt: "2024-01-01T00:11:00Z",
      }),
    ],
    reviewComments: [],
  });
  await ledger3.observe(t3, clock3);
  const onFinal = ledger3.allEvidence().find((i) => i.kind === "issue_comment")!;
  assert.throws(
    () => buildCollectorReceipt(ledger3, {
      legs: [{
        legId: "codex",
        status: "unavailable",
        rationale: "headless cannot prove target",
        evidenceRefs: [onFinal.evidenceId],
        unavailableScope: "target",
      }],
    }, clock3),
    /unavailable|scope|eligible|target/i,
  );
  const globalOk = buildCollectorReceipt(ledger3, {
    legs: [{
      legId: "codex",
      status: "unavailable",
      rationale: "headless still proves global",
      evidenceRefs: [onFinal.evidenceId],
      unavailableScope: "global",
    }],
  }, clock3);
  assert.equal(globalOk.legs[0]?.status, "unavailable");
  const globalTerm = globalOk.reports.find((r) => r.kind === "terminal-fact");
  assert.ok(globalTerm && globalTerm.kind === "terminal-fact");
  assert.equal(globalTerm.scope, "global");
});

test("target unavailable requires exact-head review or review_comment; stale carried HEAD rejects", async () => {
  // Stale review first seen on final HEAD still rejects target (carried commitOid).
  {
    const clock = clockAt("2024-01-01T00:10:00Z");
    const transport = createFakeGitHubTransport({
      user: sampleUser(),
      pullRequest: samplePull({ headOid: "head-b" }),
      reviews: [
        sampleReview({
          id: 10,
          userLogin: "codexbot",
          state: "COMMENTED",
          body: "decline on old head",
          commitId: "head-a",
          submittedAt: "2024-01-01T00:11:00Z",
        }),
      ],
      issueComments: [],
      reviewComments: [],
    });
    const ledger = createCollectorLedger(baseConfig());
    ledger.recordActivation(clock);
    await ledger.observe(transport, clock);
    const staleReview = ledger.allEvidence().find((i) =>
      i.kind === "review" && i.body === "decline on old head"
    )!;
    assert.throws(
      () => buildCollectorReceipt(ledger, {
        legs: [{
          legId: "codex",
          status: "unavailable",
          rationale: "stale carried head cannot prove target",
          evidenceRefs: [staleReview.evidenceId],
          unavailableScope: "target",
        }],
      }, clock),
      /unavailable|scope|eligible|target/i,
    );
  }

  // Stale review_comment rejects target.
  {
    const clock = clockAt("2024-01-01T00:10:00Z");
    const transport = createFakeGitHubTransport({
      user: sampleUser(),
      pullRequest: samplePull({ headOid: "head-b" }),
      reviews: [],
      issueComments: [],
      reviewComments: [
        sampleReviewComment({
          id: 20,
          userLogin: "codexbot",
          body: "inline decline stale",
          commitId: "head-a",
          pullRequestReviewId: 10,
          updatedAt: "2024-01-01T00:11:00Z",
        }),
      ],
    });
    const ledger = createCollectorLedger(baseConfig());
    ledger.recordActivation(clock);
    await ledger.observe(transport, clock);
    const staleInline = ledger.allEvidence().find((i) =>
      i.kind === "review_comment" && i.body === "inline decline stale"
    )!;
    assert.throws(
      () => buildCollectorReceipt(ledger, {
        legs: [{
          legId: "codex",
          status: "unavailable",
          rationale: "stale inline cannot prove target",
          evidenceRefs: [staleInline.evidenceId],
          unavailableScope: "target",
        }],
      }, clock),
      /unavailable|scope|eligible|target/i,
    );
  }

  // Exact-head review proves target. Use PENDING so R1 valid-precedence does not fire.
  {
    const clock = clockAt("2024-01-01T00:10:00Z");
    const transport = createFakeGitHubTransport({
      user: sampleUser(),
      pullRequest: samplePull({ headOid: "head-b" }),
      reviews: [
        sampleReview({
          id: 11,
          userLogin: "codexbot",
          state: "PENDING",
          body: "decline on target head",
          commitId: "head-b",
          submittedAt: "2024-01-01T00:11:00Z",
        }),
      ],
      issueComments: [],
      reviewComments: [],
    });
    const ledger = createCollectorLedger(baseConfig());
    ledger.recordActivation(clock);
    await ledger.observe(transport, clock);
    const exactReview = ledger.allEvidence().find((i) =>
      i.kind === "review" && i.body === "decline on target head"
    )!;
    const receipt = buildCollectorReceipt(ledger, {
      legs: [{
        legId: "codex",
        status: "unavailable",
        rationale: "exact-head target decline",
        evidenceRefs: [exactReview.evidenceId],
        unavailableScope: "target",
      }],
    }, clock);
    assert.equal(receipt.legs[0]?.status, "unavailable");
    const term = receipt.reports.find((r) => r.kind === "terminal-fact");
    assert.ok(term && term.kind === "terminal-fact");
    assert.equal(term.targetSnapshotHead, "head-b");
  }

  // Exact-head review_comment proves target (no qualifying valid review present).
  {
    const clock = clockAt("2024-01-01T00:10:00Z");
    const transport = createFakeGitHubTransport({
      user: sampleUser(),
      pullRequest: samplePull({ headOid: "head-b" }),
      reviews: [],
      issueComments: [],
      reviewComments: [
        sampleReviewComment({
          id: 21,
          userLogin: "codexbot",
          body: "inline decline target",
          commitId: "head-b",
          pullRequestReviewId: 11,
          updatedAt: "2024-01-01T00:11:00Z",
        }),
      ],
    });
    const ledger = createCollectorLedger(baseConfig());
    ledger.recordActivation(clock);
    await ledger.observe(transport, clock);
    const exactInline = ledger.allEvidence().find((i) =>
      i.kind === "review_comment" && i.body === "inline decline target"
    )!;
    const receipt = buildCollectorReceipt(ledger, {
      legs: [{
        legId: "codex",
        status: "unavailable",
        rationale: "exact-head inline target decline",
        evidenceRefs: [exactInline.evidenceId],
        unavailableScope: "target",
      }],
    }, clock);
    assert.equal(receipt.legs[0]?.status, "unavailable");
    const term = receipt.reports.find((r) => r.kind === "terminal-fact");
    assert.ok(term && term.kind === "terminal-fact");
    assert.equal(term.targetSnapshotHead, "head-b");
  }
});

test("intruder inline sharing pullRequestReviewId is excluded from report attachment", async () => {
  const clock = clockAt("2024-01-01T00:10:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-c" }),
    reviews: [
      sampleReview({
        id: 1,
        userLogin: "codexbot",
        state: "CHANGES_REQUESTED",
        body: "parent review body",
        commitId: "head-c",
        submittedAt: "2024-01-01T00:11:00Z",
      }),
    ],
    issueComments: [],
    reviewComments: [
      sampleReviewComment({
        id: 50,
        userLogin: "intruder",
        body: "intruder inline should not attach",
        pullRequestReviewId: 1,
        commitId: "head-c",
        path: "src/a.ts",
        line: 10,
        updatedAt: "2024-01-01T00:11:00Z",
      }),
      sampleReviewComment({
        id: 51,
        userLogin: "codexbot",
        body: "owned inline stays",
        pullRequestReviewId: 1,
        commitId: "head-c",
        path: "src/b.ts",
        line: 3,
        updatedAt: "2024-01-01T00:11:00Z",
      }),
    ],
  });
  const ledger = createCollectorLedger(baseConfig());
  ledger.recordActivation(clock);
  await ledger.observe(transport, clock);
  const intruder = ledger.allEvidence().find((i) =>
    i.kind === "review_comment" && i.body === "intruder inline should not attach"
  )!;
  const owned = ledger.allEvidence().find((i) =>
    i.kind === "review_comment" && i.body === "owned inline stays"
  )!;
  const parent = ledger.allEvidence().find((i) =>
    i.kind === "review" && i.body === "parent review body"
  )!;
  assert.ok(intruder);
  assert.ok(
    ledger.getSnapshot(ledger.latestCompleteSnapshotId!)!.evidenceIds.includes(
      intruder.evidenceId,
    ),
    "intruder retained in snapshot evidenceIds",
  );

  const receipt = buildCollectorReceipt(ledger, {
    legs: [{
      legId: "codex",
      status: "valid",
      rationale: "owned review only",
      // Valid cites only the parent review; inline attachment is report-derived.
      evidenceRefs: [parent.evidenceId],
    }],
  }, clock);
  const reviewReport = receipt.reports.find((r) => r.kind === "review");
  assert.ok(reviewReport && reviewReport.kind === "review");
  assert.match(reviewReport.report, /parent review body/);
  assert.match(reviewReport.report, /owned inline stays/);
  assert.doesNotMatch(reviewReport.report, /intruder inline/);
  assert.ok(!reviewReport.evidenceRefs.includes(intruder.evidenceId));
  assert.ok(reviewReport.evidenceRefs.includes(owned.evidenceId));
  assert.ok(reviewReport.evidenceRefs.includes(parent.evidenceId));
  assert.ok(
    ledger.allEvidence().some((i) => i.evidenceId === intruder.evidenceId),
    "intruder still in allEvidence",
  );
});

test("after-deadline first observation of review cannot prove valid or unavailable", async () => {
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
  // Advance past eligibility cutoff (activation + 15m = 00:25) before first observe.
  clock.advance(16 * 60 * 1000); // wall now 00:26
  transport.state.reviews = [
    sampleReview({
      id: 30,
      userLogin: "codexbot",
      state: "APPROVED",
      body: "late first sighting",
      commitId: "head-c",
      submittedAt: "2024-01-01T00:00:00Z",
    }),
  ];
  await ledger.observe(transport, clock);
  const late = ledger.allEvidence().find((i) =>
    i.kind === "review" && i.body === "late first sighting"
  )!;
  assert.equal(late.authoritativeTime, null);
  assert.equal(late.windowRelation, "uncertain");

  assert.throws(() => buildCollectorReceipt(ledger, {
    legs: [{
      legId: "codex",
      status: "unavailable",
      rationale: "late first seen cannot prove",
      evidenceRefs: [late.evidenceId],
      unavailableScope: "global",
    }],
  }, clock), /unavailable|eligible|window|uncertain/i);

  assert.throws(() => buildCollectorReceipt(ledger, {
    legs: [{
      legId: "codex",
      status: "valid",
      rationale: "late first seen cannot prove valid",
      evidenceRefs: [late.evidenceId],
    }],
  }, clock), /valid|qualifying|window|head/i);
});

test("mono past deadline with wall before deadline nulls first-sighting trust", async () => {
  // Packet reproduction: activation mono 0 / deadline mono 900000; advance mono
  // to 960000 while wall is still before wall deadline; submitted_at before
  // window must not prove valid/unavailable via wall-only first-sighting gate.
  const clock = clockAt("2024-01-01T00:10:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-c" }),
    reviews: [],
    issueComments: [],
    reviewComments: [],
  });
  const ledger = createCollectorLedger(baseConfig());
  ledger.recordActivation(clock); // activation mono 0, wall 00:10; deadline mono 900000 / wall 00:25
  clock.advance(960_000); // mono 960000, wall would be 00:26
  clock.setWall("2024-01-01T00:20:00Z"); // wall before deadline; mono still past cutoff
  transport.state.reviews = [
    sampleReview({
      id: 31,
      userLogin: "codexbot",
      state: "APPROVED",
      body: "wall-skew late first sighting",
      commitId: "head-c",
      submittedAt: "2024-01-01T00:05:00Z",
    }),
  ];
  await ledger.observe(transport, clock);
  const skewed = ledger.allEvidence().find((i) =>
    i.kind === "review" && i.body === "wall-skew late first sighting"
  )!;
  assert.ok(skewed, "review must be stored");
  assert.equal(skewed.firstObservedAt, "2024-01-01T00:20:00.000Z");
  assert.equal(skewed.authoritativeTime, null);
  assert.notEqual(skewed.windowRelation, "before");
  assert.notEqual(skewed.windowRelation, "within");
  assert.equal(skewed.windowRelation, "uncertain");

  assert.throws(() => buildCollectorReceipt(ledger, {
    legs: [{
      legId: "codex",
      status: "valid",
      rationale: "wall-before mono-after cannot prove valid",
      evidenceRefs: [skewed.evidenceId],
    }],
  }, clock), /valid|qualifying|window|head/i);

  assert.throws(() => buildCollectorReceipt(ledger, {
    legs: [{
      legId: "codex",
      status: "unavailable",
      rationale: "wall-before mono-after cannot prove unavailable",
      evidenceRefs: [skewed.evidenceId],
      unavailableScope: "global",
    }],
  }, clock), /unavailable|eligible|window|uncertain/i);
});

test("observe start-before finish-after cutoff newly appearing review cannot prove valid", async () => {
  // activation 00:10 → deadline 00:25; observe starts 00:24:59 empty, mid-fetch
  // crosses cutoff and injects a new review; first-sighting must be conservative.
  const clock = clockAt("2024-01-01T00:10:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-c" }),
    reviews: [],
    issueComments: [],
    reviewComments: [],
  });
  const originalListReviews = transport.listPullRequestReviews.bind(transport);
  let reviewListCount = 0;
  transport.listPullRequestReviews = async (input) => {
    reviewListCount += 1;
    if (reviewListCount === 1) {
      // Observe already started at 00:24:59; surfaces arrive after deadline.
      clock.advance(2_000); // 00:25:01
      transport.state.reviews = [
        sampleReview({
          id: 40,
          userLogin: "codexbot",
          state: "APPROVED",
          body: "appeared mid-observe after cutoff",
          commitId: "head-c",
          submittedAt: "2024-01-01T00:00:00Z",
        }),
      ];
    }
    return originalListReviews(input);
  };

  const ledger = createCollectorLedger(baseConfig());
  ledger.recordActivation(clock);
  // Start observe just before eligibility cutoff (activation + 15m = 00:25).
  clock.advance(14 * 60 * 1000 + 59_000); // wall now 00:24:59
  assert.equal(clock.wallNow().toISOString(), "2024-01-01T00:24:59.000Z");
  const { snapshot } = await ledger.observe(transport, clock);
  assert.ok(Date.parse(snapshot.observedAt) < Date.parse("2024-01-01T00:25:00.000Z"));
  assert.ok(Date.parse(snapshot.completedAt) > Date.parse("2024-01-01T00:25:00.000Z"));

  const late = ledger.allEvidence().find((item) =>
    item.kind === "review" && item.body === "appeared mid-observe after cutoff"
  )!;
  assert.ok(late, "review must be stored");
  assert.ok(
    Date.parse(late.firstObservedAt) > Date.parse("2024-01-01T00:25:00.000Z"),
    `firstObservedAt must be after deadline, got ${late.firstObservedAt}`,
  );
  assert.equal(late.authoritativeTime, null);
  assert.notEqual(late.windowRelation, "before");
  assert.notEqual(late.windowRelation, "within");

  assert.throws(() => buildCollectorReceipt(ledger, {
    legs: [{
      legId: "codex",
      status: "valid",
      rationale: "mid-observe after-cutoff first sighting cannot prove valid",
      evidenceRefs: [late.evidenceId],
    }],
  }, clock), /valid|qualifying|window|head/i);

  assert.throws(() => buildCollectorReceipt(ledger, {
    legs: [{
      legId: "codex",
      status: "unavailable",
      rationale: "mid-observe after-cutoff first sighting cannot prove unavailable",
      evidenceRefs: [late.evidenceId],
      unavailableScope: "global",
    }],
  }, clock), /unavailable|eligible|window|uncertain/i);
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
  // Injectable few-KiB materialization cap (production default stays COLLECTOR_RECEIPT_MAX_BYTES).
  const receiptMaxBytes = 4_096;
  const clock = clockAt("2024-01-01T00:10:00Z");
  const ledger = createCollectorLedger({ ...baseConfig(), receiptMaxBytes });
  ledger.recordActivation(clock);
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-c" }),
    reviews: [],
    issueComments: [],
    reviewComments: [],
  });

  let overflowed = false;
  for (let i = 0; i < 8; i++) {
    transport.state.reviews = [
      sampleReview({
        id: 99,
        userLogin: "codexbot",
        state: "COMMENTED",
        commitId: "head-c",
        submittedAt: "2024-01-01T00:00:00Z",
        body: `${"Z".repeat(800)}-${i}`,
      }),
    ];
    try {
      await ledger.observe(transport, clock);
    } catch (error) {
      overflowed = true;
      assert.equal(ledger.fatal, true);
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(`${receiptMaxBytes}|bytes|ledger|receipt`, "i"));
      assert.equal((error as { collectorFatal?: boolean }).collectorFatal, true);
      break;
    }
  }
  assert.equal(overflowed, true);
  assert.equal(COLLECTOR_RECEIPT_MAX_BYTES, 32 * 1024 * 1024);
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
    ["out-of-enum status", {
      legs: [{
        legId: "codex",
        status: "refused",
        rationale: "nope",
        evidenceRefs: ["x"],
      }],
    }],
    ["unknown leg field", {
      legs: [{
        legId: "codex",
        status: "valid",
        rationale: "ok",
        evidenceRefs: ["x"],
        extra: true,
      }],
    }],
    ["unknown leg field reports", {
      legs: [{
        legId: "codex",
        status: "valid",
        rationale: "ok",
        evidenceRefs: ["x"],
        reports: [],
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
  // observe envelope at classify: undefined|null illegal; {} legal sole operational
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
  const observeEmpty = classifyCollectorBatch(
    [{
      type: "toolCall",
      id: "obs-ok",
      name: COLLECTOR_OBSERVE_TOOL,
      arguments: {},
    }],
    { outputAccepted: false, hasCompletedOperationalOrSnapshot: false },
  );
  assert.equal(observeEmpty.allow, true, "observe {} legal");
  assert.ok(observeEmpty.allow);
  assert.equal(observeEmpty.permitted.kind, "operational");
  assert.equal(observeEmpty.permitted.name, COLLECTOR_OBSERVE_TOOL);
  assert.equal(observeEmpty.permitted.callId, "obs-ok");
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

// F2 two-leg missing contamination absorbed by F2-latestRelevant-recovered-then-succeeded
// (leg-owned refs ≡ terminal-fact refs + cross-leg non-contamination).

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

test("F3-timestamp-less review edit loses authoritativeTime (state and text)", async () => {
  // One contract, 2-cell trigger matrix: state edit blocks valid; text edit blocks unavailable.
  // Retention of prior versions is owned by dedicated F3 retention tests.
  for (const cell of [
    {
      id: 1,
      first: { state: "APPROVED" as const, body: "LGTM" },
      later: { state: "DISMISSED" as const, body: "LGTM" },
      pickFirst: (r: { kind: string; state?: string }) => r.kind === "review" && r.state === "APPROVED",
      pickLater: (r: { kind: string; state?: string }) => r.kind === "review" && r.state === "DISMISSED",
      claim: {
        legId: "codex",
        status: "valid" as const,
        rationale: "dismissed only",
        evidenceRefs: [] as string[],
      },
      diagnostic: /qualifying|valid/i,
      assertStableId: false,
    },
    {
      id: 2,
      first: { state: "COMMENTED" as const, body: "still looking" },
      later: { state: "COMMENTED" as const, body: "I will not review this PR" },
      pickFirst: (r: { kind: string; body?: string }) => r.kind === "review" && r.body === "still looking",
      pickLater: (r: { kind: string; body?: string }) =>
        r.kind === "review" && r.body === "I will not review this PR",
      claim: {
        legId: "codex",
        status: "unavailable" as const,
        rationale: "uncertain text",
        evidenceRefs: [] as string[],
        unavailableScope: "target" as const,
      },
      diagnostic: /unavailable|eligible|window/i,
      assertStableId: true,
    },
  ]) {
    const clock = clockAt("2024-01-01T00:10:00Z");
    const transport = createFakeGitHubTransport({
      user: sampleUser(),
      pullRequest: samplePull({ headOid: "head-c" }),
      reviews: [
        sampleReview({
          id: cell.id,
          userLogin: "codexbot",
          state: cell.first.state,
          body: cell.first.body,
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
    const first = ledger.allEvidence().find(cell.pickFirst)!;
    assert.equal(first.authoritativeTime, "2024-01-01T00:00:00Z");
    assert.equal(first.windowRelation, "before");

    transport.state.reviews = [
      sampleReview({
        id: cell.id,
        userLogin: "codexbot",
        state: cell.later.state,
        body: cell.later.body,
        commitId: "head-c",
        submittedAt: "2024-01-01T00:00:00Z",
        raw: {},
      }),
    ];
    await ledger.observe(transport, clock);
    const later = ledger.allEvidence().find(cell.pickLater)!;
    assert.equal(later.authoritativeTime, null);
    assert.equal(later.windowRelation, "uncertain");
    if (cell.assertStableId) assert.equal(later.stableGitHubId, "review:2");
    assert.throws(
      () => buildCollectorReceipt(ledger, {
        legs: [{ ...cell.claim, evidenceRefs: [later.evidenceId] }],
      }, clock),
      cell.diagnostic,
    );
  }
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
        evidenceRefs: [review.evidenceId],
      }],
    }, clock),
    /ambiguous|namespaces/i,
  );
});

// ---------------------------------------------------------------------------
// F3 §3.4 32 MiB receipt exact boundary (builder path)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// R1–R4 / R7 first-order receipt repairs
// ---------------------------------------------------------------------------

test("R1 terminal missing and unavailable lose to final exact-head qualifying valid", async () => {
  const { ledger, snapshot, clock } = await observeWith([
    {
      id: 1,
      userLogin: "codexbot",
      state: "APPROVED",
      commitId: "head-c",
      submittedAt: "2024-01-01T00:00:00Z",
    },
  ]);
  const review = ledger.allEvidence().find((item) => item.kind === "review")!;
  // Even with a same-leg review cite, unavailable is illegal when valid proof exists.
  assert.throws(
    () => buildCollectorReceipt(ledger, {
      legs: [{
        legId: "codex",
        status: "unavailable",
        rationale: "pretend decline",
        evidenceRefs: [review.evidenceId],
        unavailableScope: "global",
      }],
    }, clock),
    /qualifying|valid|exact-head/i,
  );

  // Missing check after cutoff so observation-law does not mask terminal-precedence.
  clock.advance(16 * 60 * 1000);
  await ledger.observe(
    createFakeGitHubTransport({
      user: sampleUser("collector-bot"),
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
    }),
    clock,
  );
  assert.throws(
    () => buildCollectorReceipt(ledger, {
      legs: [{
        legId: "codex",
        status: "missing",
        rationale: "pretend missing",
        evidenceRefs: [ledger.latestCompleteSnapshotId!],
      }],
    }, clock),
    /qualifying|valid|exact-head/i,
  );
  const receipt = buildCollectorReceipt(ledger, {
    legs: [{
      legId: "codex",
      status: "valid",
      rationale: "approved",
      evidenceRefs: [review.evidenceId],
    }],
  }, clock);
  assert.equal(receipt.legs[0]?.status, "valid");
  void snapshot;
});

test("R1 terminal statuses still work when no qualifying final review exists", async () => {
  const clock = clockAt("2024-01-01T00:10:00Z");
  const transport = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-c" }),
    reviews: [],
    issueComments: [
      sampleIssueComment({
        id: 9,
        userLogin: "codexbot",
        body: "I decline",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      }),
    ],
    reviewComments: [],
  });
  const ledger = createCollectorLedger(baseConfig());
  ledger.recordActivation(clock);
  const { snapshot } = await ledger.observe(transport, clock);
  const comment = ledger.allEvidence().find((item) => item.kind === "issue_comment")!;
  const unavailable = buildCollectorReceipt(ledger, {
    legs: [{
      legId: "codex",
      status: "unavailable",
      rationale: "declined",
      evidenceRefs: [comment.evidenceId],
      unavailableScope: "global",
    }],
  }, clock);
  assert.equal(unavailable.legs[0]?.status, "unavailable");

  const ledger2 = createCollectorLedger(baseConfig());
  const clock2 = clockAt("2024-01-01T00:00:00Z");
  ledger2.recordActivation(clock2);
  const t2 = createFakeGitHubTransport({
    user: sampleUser(),
    pullRequest: samplePull({ headOid: "head-c" }),
    reviews: [],
    issueComments: [],
    reviewComments: [],
  });
  const first = await ledger2.observe(t2, clock2);
  clock2.advance(16 * 60 * 1000);
  await ledger2.observe(t2, clock2);
  const missing = buildCollectorReceipt(ledger2, {
    legs: [{
      legId: "codex",
      status: "missing",
      rationale: "never arrived",
      evidenceRefs: [ledger2.latestCompleteSnapshotId!],
    }],
  }, clock2);
  assert.equal(missing.legs[0]?.status, "missing");
  void snapshot;
  void first;
});

test("R2 valid rejects cross-leg cites and rebinds only same-leg qualifying proofs", async () => {
  const clock = clockAt("2024-01-01T00:10:00Z");
  const config = {
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
          expectedAuthors: ["codexbot"],
          requestBody: "Please review.",
        },
        {
          id: "claude",
          expectedAuthors: ["claudebot"],
          requestBody: "Please review.",
        },
      ],
      canonicalJson: "{}\n",
      digest: "b".repeat(64),
      sourcePath: "/tmp/legs.json",
    },
  };
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
        body: "A ok",
      }),
      sampleReview({
        id: 2,
        userLogin: "claudebot",
        state: "APPROVED",
        commitId: "head-c",
        submittedAt: "2024-01-01T00:00:00Z",
        body: "B ok",
      }),
    ],
    issueComments: [],
    reviewComments: [],
  });
  const ledger = createCollectorLedger(config);
  ledger.recordActivation(clock);
  await ledger.observe(transport, clock);
  const a = ledger.allEvidence().find((item) =>
    item.kind === "review" && item.authorLogin === "codexbot"
  )!;
  const b = ledger.allEvidence().find((item) =>
    item.kind === "review" && item.authorLogin === "claudebot"
  )!;

  assert.throws(
    () => buildCollectorReceipt(ledger, {
      legs: [
        {
          legId: "codex",
          status: "valid",
          rationale: "cross cite alone",
          evidenceRefs: [b.evidenceId],
        },
        {
          legId: "claude",
          status: "valid",
          rationale: "ok",
          evidenceRefs: [b.evidenceId],
        },
      ],
    }, clock),
    /non-qualifying|valid|exact-head/i,
  );
  assert.throws(
    () => buildCollectorReceipt(ledger, {
      legs: [
        {
          legId: "codex",
          status: "valid",
          rationale: "mixed cross cite",
          evidenceRefs: [a.evidenceId, b.evidenceId],
        },
        {
          legId: "claude",
          status: "valid",
          rationale: "ok",
          evidenceRefs: [b.evidenceId],
        },
      ],
    }, clock),
    /non-qualifying|valid|exact-head/i,
  );

  const receipt = buildCollectorReceipt(ledger, {
    legs: [
      {
        legId: "codex",
        status: "valid",
        rationale: "A only",
        evidenceRefs: [a.evidenceId],
      },
      {
        legId: "claude",
        status: "valid",
        rationale: "B only",
        evidenceRefs: [b.evidenceId],
      },
    ],
  }, clock);
  const legA = receipt.legs.find((leg) => leg.legId === "codex")!;
  assert.deepEqual(legA.evidenceRefs, [a.evidenceId]);
  assert.equal(legA.evidenceRefs.includes(b.evidenceId), false);
});

test("R7 outdated inline originalLine falls back in report location", async () => {
  const { ledger, clock } = await observeWith(
    [
      {
        id: 10,
        userLogin: "codexbot",
        state: "CHANGES_REQUESTED",
        commitId: "head-c",
        submittedAt: "2024-01-01T00:00:00Z",
        body: "needs work",
      },
    ],
    {
      reviewComments: [
        sampleReviewComment({
          id: 99,
          userLogin: "codexbot",
          pullRequestReviewId: 10,
          path: "src/x.ts",
          line: null,
          originalLine: 42,
          body: "outdated nit",
        }),
      ],
    },
  );
  const review = ledger.allEvidence().find((item) => item.kind === "review")!;
  const inline = ledger.allEvidence().find((item) => item.kind === "review_comment")!;
  assert.equal(inline.line, null);
  assert.equal(inline.originalLine, 42);
  const receipt = buildCollectorReceipt(ledger, {
    legs: [{
      legId: "codex",
      status: "valid",
      rationale: "inline",
      evidenceRefs: [review.evidenceId],
    }],
  }, clock);
  const text = receipt.reports
    .filter((r) => r.kind === "review")
    .map((r) => r.report)
    .join("\n");
  assert.match(text, /src\/x\.ts:42/);
  assert.doesNotMatch(text, /src\/x\.ts:\?/);
});
