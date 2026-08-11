import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeIssueComment, normalizeReview, normalizeReviewComment } from "../../src/collector-github.ts";
import { normalizeReviewEvidence } from "../../src/collector-evidence.ts";
import { extractCollectorEvidenceIdentityGroups, extractGitHubIdentityGroups, groupGitHubMaterialsByIdentity } from "../../src/collector-identity.ts";

const noFindingFixture = new URL("../fixtures/collector/codex-nofinding-5234537035.json", import.meta.url);

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

test("Codex frozen inline review yields five identity-owned findings with evidence refs", async () => {
  const raw = JSON.parse(await readFile(new URL("../fixtures/collector/codex-inline-review-4895614344.json", import.meta.url), "utf8"));
  const group = extractGitHubIdentityGroups(raw.map(normalizeReviewComment))[0]!;
  assert.equal(group.attendance, true);
  assert.equal(group.degraded, false);
  assert.equal(group.findings.length, 5);
  assert.ok(group.findings.every((finding) => finding.identity.userId === 199175422 && finding.source.kind === "review_comment"));
});

test("Codex no-finding and usage-limit bytes distinguish empty findings from degraded attendance", async () => {
  const load = async (name: string) => normalizeIssueComment(JSON.parse(await readFile(new URL(`../fixtures/collector/${name}`, import.meta.url), "utf8")));
  const noFinding = extractGitHubIdentityGroups([await load("codex-nofinding-5234537035.json")])[0]!;
  const limited = extractGitHubIdentityGroups([await load("codex-usagelimit-5244073043.json")])[0]!;
  assert.equal(noFinding.attendance, true);
  assert.deepEqual(noFinding.findings, []);
  assert.equal(noFinding.degraded, false);
  assert.equal(limited.attendance, true);
  assert.deepEqual(limited.findings, []);
  assert.equal(limited.degraded, true);
});

test("CodeRabbit frozen HTML containers yield outside-diff and nitpick findings plus four inline", async () => {
  const review = normalizeReview(JSON.parse(await readFile(new URL("../fixtures/collector/coderabbit-review-4895713581.json", import.meta.url), "utf8")));
  const inlineRaw = JSON.parse(await readFile(new URL("../fixtures/collector/coderabbit-inline-review-4895713581.json", import.meta.url), "utf8"));
  const group = extractGitHubIdentityGroups([review, ...inlineRaw.map(normalizeReviewComment)])[0]!;
  assert.equal(group.findings.filter((finding) => finding.category === "outside_diff").length, 8);
  assert.equal(group.findings.filter((finding) => finding.category === "nitpick").length, 2);
  assert.equal(group.findings.filter((finding) => finding.category === "inline").length, 4);
  assert.ok(group.findings.every((finding) => finding.source.id > 0 && finding.identity.userId === 136622811));
});

test("evidence extractor binds real evidenceId refs and head relation", async () => {
  const raw = JSON.parse(await readFile(new URL("../fixtures/collector/sourcery-ratelimit-review-4892027495.json", import.meta.url), "utf8"));
  const record = normalizeReviewEvidence(normalizeReview(raw), "2026-08-11T00:00:00Z");
  const group = extractCollectorEvidenceIdentityGroups([record], "other-head")[0]!;

  assert.deepEqual(group.identity, { userType: "Bot", userId: 58596630 });
  assert.equal(group.attendance, true);
  assert.equal(group.degraded, true);
  assert.deepEqual(group.findings, []);
  assert.deepEqual(group.materials, [{
    kind: "review",
    id: 4892027495,
    evidenceId: record.evidenceId,
    headRelation: "prior",
  }]);
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
