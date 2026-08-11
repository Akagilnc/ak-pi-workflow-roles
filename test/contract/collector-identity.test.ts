import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeIssueComment } from "../../src/collector-github.ts";
import { groupGitHubMaterialsByIdentity } from "../../src/collector-identity.ts";

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
