import assert from "node:assert/strict";
import test from "node:test";

import {
  COLLECTOR_RECEIPT_MAX_BYTES,
  COLLECTOR_SNAPSHOT_MAX_BYTES,
  computeWindowRelation,
  type CollectorClock,
} from "../src/collector-evidence.ts";
import {
  COLLECTOR_OBSERVE_TOOL,
  COLLECTOR_OUTPUT_TOOL,
  COLLECTOR_REQUEST_TOOL,
  COLLECTOR_WAIT_TOOL,
  createCollectorLedger,
} from "../src/collector-ledger.ts";
import { buildCollectorRequestMarker } from "../src/collector-github.ts";
import {
  createFakeGitHubTransport,
  sampleIssueComment,
  samplePull,
  sampleReview,
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
  assert.deepEqual(
    ledger.evaluateBatch([
      { type: "toolCall", id: "1", name: COLLECTOR_OBSERVE_TOOL },
    ]),
    { allow: true },
  );
  assert.equal(
    ledger.evaluateBatch([
      { type: "toolCall", id: "1", name: COLLECTOR_OBSERVE_TOOL },
      { type: "toolCall", id: "2", name: COLLECTOR_REQUEST_TOOL },
    ]).allow,
    false,
  );
  assert.equal(ledger.fatal, true);

  const ledger2 = createCollectorLedger(config());
  assert.equal(
    ledger2.evaluateBatch([
      { type: "toolCall", id: "1", name: COLLECTOR_OBSERVE_TOOL },
      { type: "toolCall", id: "2", name: COLLECTOR_OUTPUT_TOOL },
    ]).allow,
    false,
  );

  const ledger3 = createCollectorLedger(config());
  // output without prior operational/snapshot
  assert.equal(
    ledger3.evaluateBatch([
      { type: "toolCall", id: "1", name: COLLECTOR_OUTPUT_TOOL },
    ]).allow,
    false,
  );
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

  const marker = requestResult.marker;
  transport.state.issueComments = [
    sampleIssueComment({
      id: 99,
      userLogin: "collector-bot",
      body: `Please review.\n${marker}\n`,
    }),
  ];
  await ledger.observe(transport, clock);
  assert.equal(ledger.unresolvedTransportFailure, false);
  assert.equal(
    ledger.requestAttempts().some((attempt) => attempt.status === "recovered"),
    true,
  );
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

  await assert.rejects(
    () => ledger.wait({ durationMs: 1_000 }, clock),
    /cutoff/,
  );
});

test("existing exact-head qualifying review blocks request", async () => {
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
      })),
    );
    assert.equal(decision.allow, false, names.join("+"));
    assert.equal(ledger.fatal, true, names.join("+"));
  }
});
