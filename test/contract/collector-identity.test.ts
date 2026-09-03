import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeIssueComment, normalizePullRequestReaction, normalizeReview, normalizeReviewComment } from "../../src/collector-github.ts";
import { normalizeIssueCommentEvidence, normalizePullRequestReactionEvidence, normalizeReviewCommentEvidence, normalizeReviewEvidence, type CollectorEvidenceRecord } from "../../src/collector-evidence.ts";
import { enrichCollectorFindings, extractCollectorEvidenceIdentityGroups } from "../../src/collector-identity.ts";

const reactionFixture = new URL("../fixtures/collector/codex-pr-reaction-1165.json", import.meta.url);
const noFindingFixture = new URL("../fixtures/collector/codex-nofinding-5234537035.json", import.meta.url);

const observedAt = "2026-08-11T00:00:00Z";

async function loadEvidence(name: string, normalize: (raw: any, observedAt: string) => CollectorEvidenceRecord, surface: (raw: any) => any): Promise<CollectorEvidenceRecord[]> {
  const raw = JSON.parse(await readFile(new URL(`../fixtures/collector/${name}`, import.meta.url), "utf8"));
  const raws = Array.isArray(raw) ? raw : [raw];
  return raws.map((item: any) => normalize(surface(item), observedAt));
}

test("real PR reaction bytes make Codex present with zero findings by stable user id", async () => {
  const raw = JSON.parse(await readFile(reactionFixture, "utf8"));
  const evidence = raw.map((item: any) => normalizePullRequestReactionEvidence(normalizePullRequestReaction(item), observedAt));
  const group = extractCollectorEvidenceIdentityGroups(evidence, "target-head")[0]!;

  assert.deepEqual(group.identity, { userType: "User", userId: 199175422 });
  assert.equal(group.attendance, true);
  assert.deepEqual(group.findings, []);
  assert.deepEqual(group.materials, [{ kind: "reaction", id: 445776942, evidenceId: evidence[0]!.evidenceId, headRelation: "unbound" }]);
});

test("real GitHub bytes group attendance by machine user and App identity", async () => {
  const raw = JSON.parse(await readFile(noFindingFixture, "utf8"));
  const evidence = (Array.isArray(raw) ? raw : [raw]).map((item: any) => normalizeIssueCommentEvidence(normalizeIssueComment(item), observedAt));
  const groups = extractCollectorEvidenceIdentityGroups(evidence, "target-head");

  assert.deepEqual(groups, [{
    identity: { userType: "Bot", userId: 199175422, appId: 1144995 },
    displayLogin: "chatgpt-codex-connector[bot]",
    attendance: true,
    findings: [],
    materials: [{ kind: "issue_comment", id: 5234537035, evidenceId: evidence[0]!.evidenceId, headRelation: "unbound" }],
  }]);
});

test("real Codex reaction and App comment preserve the richest machine identity in either order", async () => {
  const reactionRaw = JSON.parse(await readFile(reactionFixture, "utf8"))[0];
  const commentRaw = JSON.parse(await readFile(noFindingFixture, "utf8"));
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

test("#245 full PR 1168 replay keeps typed attendance, pointer materials, evidence ownership, and head relation — findings split by the LLM, not code", async () => {
  const load = async (name: string) => JSON.parse(await readFile(new URL(`../fixtures/collector/${name}`, import.meta.url), "utf8"));
  const reviews = (await load("pr-1168-reviews.json")).map(normalizeReview);
  const comments = (await load("pr-1168-review-comments.json")).map(normalizeReviewComment);
  assert.equal(reviews.length, 9);
  assert.equal(comments.length, 33);

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
  // #641: splitting/classification belongs to the collector LLM; the code
  // extractor keeps attendance + pointer materials only.
  assert.deepEqual(codex.findings, []);
  assert.deepEqual(rabbit.findings, []);
  assert.ok(codex.materials.some((material) => codexIds.has(material.id)));
  assert.ok(rabbit.materials.some((material) => rabbitIds.has(material.id)));
  for (const material of [...codex.materials, ...rabbit.materials]) {
    assert.equal("body" in material, false, "materials must not transcribe bodies");
    assert.equal(typeof material.evidenceId, "string");
  }
  assert.ok(codex.materials.some((material) => material.id === 4895614344 && material.headRelation === "current"));
  assert.ok(rabbit.materials.some((material) => material.id === 4895713581 && material.headRelation === "current"));
  assert.ok([...codex.materials, ...rabbit.materials].some((material) => material.headRelation === "prior"));
});

test("Codex attendance is invariant under no-finding and usage-limit prose", async () => {
  const noFinding = await loadEvidence("codex-nofinding-5234537035.json", normalizeIssueCommentEvidence, normalizeIssueComment);
  const limited = await loadEvidence("codex-usagelimit-5244073043.json", normalizeIssueCommentEvidence, normalizeIssueComment);
  const noFindingGroups = extractCollectorEvidenceIdentityGroups(noFinding, "target-head");
  const limitedGroups = extractCollectorEvidenceIdentityGroups(limited, "target-head");
  assert.equal(noFindingGroups[0]!.attendance, true);
  assert.deepEqual(noFindingGroups[0]!.findings, []);
  assert.equal(limitedGroups[0]!.attendance, true);
  assert.deepEqual(limitedGroups[0]!.findings, []);
});

test("evidence extractor binds real evidenceId refs and head relation", async () => {
  const [record] = await loadEvidence("sourcery-ratelimit-review-4892027495.json", normalizeReviewEvidence, normalizeReview);
  const group = extractCollectorEvidenceIdentityGroups([record!], "other-head")[0]!;

  assert.deepEqual(group.identity, { userType: "Bot", userId: 58596630 });
  assert.equal(group.attendance, true);
  assert.deepEqual(group.findings, []);
  assert.deepEqual(group.materials, [{
    kind: "review",
    id: 4892027495,
    evidenceId: record!.evidenceId,
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
  assert.deepEqual(groups[0]!.findings, []);
});

test("machine identity ignores display changes, separates user IDs, and leaves tombstones unassigned", async () => {
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
  ].map((item) => normalizeIssueCommentEvidence(item, observedAt));

  const groups = extractCollectorEvidenceIdentityGroups(materials, "target-head");
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map((group) => group.identity), [
    { userType: "Bot", userId: 7 },
    { userType: "Bot", userId: 8 },
    null,
  ]);
  assert.deepEqual(groups.map((group) => group.materials.length), [2, 1, 1]);
});

test("#641 chain① enrichment turns model pointer refs into receipt findings with machine locators", async () => {
  const raw = JSON.parse(await readFile(new URL("../fixtures/collector/coderabbit-inline-review-4895713581.json", import.meta.url), "utf8"));
  const records = raw.map((item: any) => normalizeReviewCommentEvidence(normalizeReviewComment(item), observedAt));
  const targetHead = records[0]!.commitOid!;
  const groups = extractCollectorEvidenceIdentityGroups(records, targetHead);
  enrichCollectorFindings({
    candidate: {
      findings: [
        { evidenceId: records[0]!.evidenceId, category: " correctness " },
        { evidenceId: records[0]!.evidenceId, category: "性能" },
        { evidenceId: records[records.length - 1]!.evidenceId },
      ],
    },
    records,
    groups,
    targetHead,
    repository: "acme/widgets",
    prNumber: 1168,
  });
  const findings = groups.flatMap((group) => group.findings);
  assert.equal(findings.length, 3, "one comment may split into multiple LLM findings");
  for (const finding of findings) {
    assert.equal(finding.pointer.repository, "acme/widgets");
    assert.equal(finding.pointer.prNumber, 1168);
    assert.equal(finding.pointer.kind, "review_comment");
    assert.equal(typeof finding.pointer.commentId, "number");
    assert.equal(typeof finding.pointer.htmlUrl, "string");
    assert.equal(finding.source.headRelation, "current");
    assert.equal("body" in finding, false, "findings must not transcribe bodies");
  }
  assert.equal(findings[0]!.category, "correctness", "category is a short LLM label, trimmed");
  assert.equal(findings[2]!.category, undefined);
});

test("#641 chain① enrichment fails closed on unresolvable pointers without latching fatal", () => {
  const groups = extractCollectorEvidenceIdentityGroups([], "head");
  assert.throws(
    () => enrichCollectorFindings({ candidate: { findings: [{ evidenceId: "missing" }] }, records: [], groups, targetHead: "head", repository: "r", prNumber: 1 }),
    /指针不可解析/,
  );
  assert.throws(
    () => enrichCollectorFindings({ candidate: { findings: "nope" }, records: [], groups, targetHead: "head", repository: "r", prNumber: 1 }),
    /必须为数组/,
  );
  assert.throws(
    () => enrichCollectorFindings({ candidate: { findings: [{ evidenceId: 3 }] }, records: [], groups, targetHead: "head", repository: "r", prNumber: 1 }),
    /缺少可解析的 evidenceId 指针/,
  );
});
