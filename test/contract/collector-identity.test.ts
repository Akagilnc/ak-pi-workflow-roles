import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeIssueComment, normalizePullRequestReaction, normalizeReview, normalizeReviewComment } from "../../src/collector-github.ts";
import { normalizeIssueCommentEvidence, normalizePullRequestReactionEvidence, normalizeReviewCommentEvidence, normalizeReviewEvidence } from "../../src/collector-evidence.ts";
import { extractCollectorEvidenceIdentityGroups, extractGitHubIdentityGroups, groupGitHubMaterialsByIdentity } from "../../src/collector-identity.ts";

const reactionFixture = new URL("../fixtures/collector/codex-pr-reaction-1165.json", import.meta.url);
const noFindingFixture = new URL("../fixtures/collector/codex-nofinding-5234537035.json", import.meta.url);

test("real PR reaction bytes make Codex present with zero findings by stable user id", async () => {
  const raw = JSON.parse(await readFile(reactionFixture, "utf8"));
  const group = extractGitHubIdentityGroups(raw.map(normalizePullRequestReaction))[0]!;

  assert.deepEqual(group.identity, { userType: "User", userId: 199175422 });
  assert.equal(group.attendance, true);
  assert.deepEqual(group.findings, []);
  assert.deepEqual(group.materials, [{ kind: "reaction", id: 445776942 }]);
});

test("real GitHub bytes group attendance by machine user and App identity", async () => {
  const raw = JSON.parse(await readFile(noFindingFixture, "utf8"));
  const material = normalizeIssueComment(raw);
  const groups = groupGitHubMaterialsByIdentity([material]);

  assert.deepEqual(groups, [{
    identity: { userType: "Bot", userId: 199175422, appId: 1144995 },
    displayLogin: "chatgpt-codex-connector[bot]",
    materials: [{ kind: "issue_comment", id: 5234537035 }],
  }]);
});

test("real Codex reaction and App comment preserve the richest machine identity in either order", async () => {
  const reactionRaw = JSON.parse(await readFile(reactionFixture, "utf8"))[0];
  const commentRaw = JSON.parse(await readFile(noFindingFixture, "utf8"));
  const observedAt = "2026-08-11T00:00:00Z";
  const reaction = normalizePullRequestReactionEvidence(normalizePullRequestReaction(reactionRaw), observedAt);
  const comment = normalizeIssueCommentEvidence(normalizeIssueComment(commentRaw), observedAt);

  for (const records of [[reaction, comment], [comment, reaction]]) {
    const groups = extractCollectorEvidenceIdentityGroups(records, "target-head");
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0]!.identity, { userType: "Bot", userId: 199175422, appId: 1144995 });
    assert.deepEqual(groups[0]!.materials.map(({ kind, id }) => ({ kind, id })).sort((a, b) => a.id - b.id), [
      { kind: "reaction", id: 445776942 },
      { kind: "issue_comment", id: 5234537035 },
    ]);
  }
});

test("#245 full PR 1168 replay preserves typed attendance, findings, evidence ownership, and head relation", async () => {
  const load = async (name: string) => JSON.parse(await readFile(new URL(`../fixtures/collector/${name}`, import.meta.url), "utf8"));
  const reviews = (await load("pr-1168-reviews.json")).map(normalizeReview);
  const comments = (await load("pr-1168-review-comments.json")).map(normalizeReviewComment);
  assert.equal(reviews.length, 9);
  assert.equal(comments.length, 33);

  const observedAt = "2026-08-11T00:00:00Z";
  const evidence = [
    ...reviews.map((value: Parameters<typeof normalizeReviewEvidence>[0]) => normalizeReviewEvidence(value, observedAt)),
    ...comments.map((value: Parameters<typeof normalizeReviewCommentEvidence>[0]) => normalizeReviewCommentEvidence(value, observedAt)),
  ];
  const groups = extractCollectorEvidenceIdentityGroups(evidence, "9207feb5e46322d14cda1bf625368c3c8a9227a8");
  const codex = groups.find((group) => group.identity?.userType === "Bot" && group.identity.userId === 199175422)!;
  const rabbit = groups.find((group) => group.identity?.userType === "Bot" && group.identity.userId === 136622811)!;
  assert.equal(codex.attendance, true);
  assert.equal(rabbit.attendance, true);

  const commentIdsFor = (reviewId: number) => new Set(comments.filter((comment: { pullRequestReviewId: number }) => comment.pullRequestReviewId === reviewId).map((comment: { id: number }) => comment.id));
  const codexIds = commentIdsFor(4895614344);
  const rabbitIds = commentIdsFor(4895713581);
  const codexCurrent = codex.findings.filter((finding) => codexIds.has(finding.source.id));
  assert.equal(codexCurrent.length, 5);
  const rabbitCurrent = rabbit.findings.filter((finding) => rabbitIds.has(finding.source.id));
  assert.equal(rabbitCurrent.filter((finding) => finding.category === "inline").length, 4);
  assert.ok(!rabbit.findings.some((finding) => finding.source.id === 4895713581));
  assert.equal(
    rabbit.materials.find((material) => material.id === 4895713581)!.body,
    reviews.find((review: { id: number }) => review.id === 4895713581)!.body,
  );
  for (const [group, findings] of [[codex, codexCurrent], [rabbit, rabbitCurrent]] as const) {
    assert.ok(findings.every((finding) => finding.identity.userId === group.identity?.userId && typeof finding.source.evidenceId === "string"));
  }
  assert.ok(codex.materials.some((material) => material.id === 4895614344 && material.headRelation === "current"));
  assert.ok(rabbit.materials.some((material) => material.id === 4895713581 && material.headRelation === "current"));
  assert.ok([...codex.materials, ...rabbit.materials].some((material) => material.headRelation === "prior"));
});

test("Codex frozen inline review yields five identity-owned findings with evidence refs", async () => {
  const raw = JSON.parse(await readFile(new URL("../fixtures/collector/codex-inline-review-4895614344.json", import.meta.url), "utf8"));
  const group = extractGitHubIdentityGroups(raw.map(normalizeReviewComment))[0]!;
  assert.equal(group.attendance, true);
  assert.equal(group.findings.length, 5);
  assert.ok(group.findings.every((finding) => finding.identity.userId === 199175422 && finding.source.kind === "review_comment"));
});

test("Codex attendance is invariant under no-finding and usage-limit prose", async () => {
  const load = async (name: string) => normalizeIssueComment(JSON.parse(await readFile(new URL(`../fixtures/collector/${name}`, import.meta.url), "utf8")));
  const noFinding = extractGitHubIdentityGroups([await load("codex-nofinding-5234537035.json")])[0]!;
  const limited = extractGitHubIdentityGroups([await load("codex-usagelimit-5244073043.json")])[0]!;
  assert.equal(noFinding.attendance, true);
  assert.deepEqual(noFinding.findings, []);
  assert.equal(limited.attendance, true);
  assert.deepEqual(limited.findings, []);
});

test("CodeRabbit frozen review body remains material and only structured inline objects become findings", async () => {
  const review = normalizeReview(JSON.parse(await readFile(new URL("../fixtures/collector/coderabbit-review-4895713581.json", import.meta.url), "utf8")));
  const inlineRaw = JSON.parse(await readFile(new URL("../fixtures/collector/coderabbit-inline-review-4895713581.json", import.meta.url), "utf8"));
  const group = extractGitHubIdentityGroups([review, ...inlineRaw.map(normalizeReviewComment)])[0]!;
  assert.equal(group.materials.find((material) => material.id === review.id)!.body, review.body);
  assert.ok(!group.findings.some((finding) => finding.source.id === review.id));
  assert.equal(group.findings.filter((finding) => finding.category === "inline").length, 4);
  assert.ok(group.findings.every((finding) => finding.source.id > 0 && finding.identity.userId === 136622811));
});

test("CodeRabbit LGTM review records attendance and material with zero findings", () => {
  const review = normalizeReview({
    id: 1,
    body: "LGTM",
    state: "APPROVED",
    commit_id: "a".repeat(40),
    submitted_at: "2026-08-11T00:00:00Z",
    html_url: "https://example.test/review/1",
    user: { login: "irrelevant[bot]", type: "Bot", id: 136622811 },
  });
  const group = extractGitHubIdentityGroups([review])[0]!;

  assert.equal(group.attendance, true);
  assert.deepEqual(group.findings, []);
  assert.deepEqual(group.materials, [{ kind: "review", id: 1, body: "LGTM" }]);
});

test("evidence extractor binds real evidenceId refs and head relation",  async () => {
  const raw = JSON.parse(await readFile(new URL("../fixtures/collector/sourcery-ratelimit-review-4892027495.json", import.meta.url), "utf8"));
  const record = normalizeReviewEvidence(normalizeReview(raw), "2026-08-11T00:00:00Z");
  const group = extractCollectorEvidenceIdentityGroups([record], "other-head")[0]!;

  assert.deepEqual(group.identity, { userType: "Bot", userId: 58596630 });
  assert.equal(group.attendance, true);
  assert.deepEqual(group.findings, []);
  assert.deepEqual(group.materials, [{
    kind: "review",
    id: 4892027495,
    body: record.body,
    evidenceId: record.evidenceId,
    headRelation: "prior",
  }]);
});

test("historical versions of one GitHub record retain their own evidence closure", async () => {
  const raw = JSON.parse(await readFile(new URL("../fixtures/collector/coderabbit-review-4895713581.json", import.meta.url), "utf8"));
  const prior = normalizeReviewEvidence(normalizeReview(raw), "2026-08-11T00:00:00Z");
  const current = normalizeReviewEvidence(normalizeReview({ ...raw, commit_id: "f".repeat(40), body: `${raw.body}\nupdated` }), "2026-08-11T00:01:00Z");
  const groups = extractCollectorEvidenceIdentityGroups([prior, current], current.commitOid!);
  const materials = groups[0]!.materials;
  assert.deepEqual(materials.map(({ evidenceId, headRelation }) => ({ evidenceId, headRelation })), [
    { evidenceId: prior.evidenceId, headRelation: "prior" },
    { evidenceId: current.evidenceId, headRelation: "current" },
  ]);
  assert.deepEqual(materials.map(({ body }) => body), [raw.body, `${raw.body}\nupdated`]);
  assert.deepEqual(groups[0]!.findings, []);
});

test("machine identity ignores display changes, separates user IDs, and leaves tombstones unassigned", () => {
  const base = {
    id: 1,
    body: "anything",
    created_at: "2026-08-10T00:04:29Z",
    updated_at: "2026-08-10T00:04:29Z",
    html_url: "https://example.test/1",
  };
  const materials = [
    normalizeIssueComment({ ...base, id: 1, user: { login: "old", type: "Bot", id: 7 } }),
    normalizeIssueComment({ ...base, id: 2, user: { login: "renamed", type: "Bot", id: 7 } }),
    normalizeIssueComment({ ...base, id: 3, user: { login: "renamed", type: "Bot", id: 8 } }),
    normalizeIssueComment({ ...base, id: 4, user: null }),
  ];

  const groups = groupGitHubMaterialsByIdentity(materials);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map((group) => group.identity), [
    { userType: "Bot", userId: 7 },
    { userType: "Bot", userId: 8 },
    null,
  ]);
  assert.deepEqual(groups.map((group) => group.materials.length), [2, 1, 1]);
});
