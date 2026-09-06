// #420 整改移档（自 test/integration/collector-github.test.ts）：纯函数/序列化
// 投影按性质归位快档。契约断言一字不减；真 spawn / 真管道条仍留 integration。
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCollectorRequestBody,
  buildCollectorRequestMarker,
  normalizePullRequest,
  normalizeReview,
} from "../../src/collector-github.ts";
import { normalizeAuthenticatedUserEvidence } from "../../src/collector-evidence.ts";

test("normalize helpers accept OPEN and valid review states and reject missing head", () => {
  // MERGED vs CLOSED public REST→Terminal proof lives on public-cli-collector-run (#676 D).
  // Keep only the OPEN happy path + missing-head reject here — no parallel MERGED unit helper.
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

test("request marker is deterministic for digest/request/head", () => {
  const marker = buildCollectorRequestMarker({
    manifestDigest: "abcdef0123456789",
    requestId: "codex",
    headOid: "head1",
  });
  assert.match(
    marker,
    /^<!-- ak-collector:v1 manifest=abcdef012345 request=[a-f0-9]{64} head=head1 -->$/,
  );
  const built = buildCollectorRequestBody({
    configuredBody: "Please review.",
    manifestDigest: "abcdef0123456789",
    requestId: "codex",
    headOid: "head1",
  });
  assert.equal(built.body.startsWith("Please review.\n"), true);
  assert.ok(built.body.includes(marker));
  const hostile = buildCollectorRequestMarker({
    manifestDigest: "abcdef0123456789",
    requestId: `UPPER --> ${"長".repeat(80)}`,
    headOid: "head1",
  });
  assert.equal(hostile.includes("UPPER"), false);
  assert.equal(hostile.match(/-->/g)?.length, 1);
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
