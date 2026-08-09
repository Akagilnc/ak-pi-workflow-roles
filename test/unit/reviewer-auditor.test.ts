import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  createPiReviewerAuditor,
  ReviewerAuditEvidenceError,
} from "../../src/reviewer-auditor.ts";

const input: any = {
  soul: "Reviewer law",
  canonicalSkill: "complete raw canonical Skill",
  task: "opaque task",
  record: {
    transportRejections: [],
    rejections: [],
    accepted: {
      identity: "dispatch-1", recipe: "reviewer-dispatch-v1" as const,
      input: { task: { text: "opaque task", utf8Length: 11, sha256: "task" }, canonicalSkillSha256: "skill", capabilityDocument: { text: "{}", utf8Length: 2, sha256: "capabilities" } },
      target: { repositoryRoot: "/repo", objectFormat: "sha1" as const, targetHead: "head", refs: {} },
      prerequisiteOperations: [],
      range: { base: "base", target: "head", diffCommand: "git diff base...head", diffSha256: "diff", commits: ["head"] },
      materials: { standards: [{ id: "rules", repositoryPath: "RULES.md", text: "rules", utf8Length: 5, sha256: "rules" }], noSpecEvidence: [{ id: "absence", repositoryPath: "README.md", text: "absence", utf8Length: 7, sha256: "absence" }] },
      legs: [{ axis: "standards" as const, prompt: { text: "Inspect the pinned diff", utf8Length: 23, sha256: "prompt" }, grant: { tools: ["read"] as const, bashCommands: [], prerequisiteOperations: [] } }],
    },
    started: { dispatchIdentity: "dispatch-1", cardinality: 1 as const },
    results: { standards: { dispatchIdentity: "dispatch-1", axis: "standards" as const, status: "successful" as const, prompt: { text: "Inspect the pinned diff", utf8Length: 23, sha256: "prompt" }, target: { repositoryRoot: "/repo", objectFormat: "sha1" as const, targetHead: "head", refs: {} }, report: "No findings", workspaceDisposition: "deleted" as const } },
  },
  candidate: {
    version: 2 as const, status: "completed" as const, acceptedBatch: { identity: "dispatch-1", legs: [] },
    reports: { standards: { text: "No findings" } },
    outcomes: {}, identities: { canonicalSkill: { text: "complete raw canonical Skill" } },
  },
};

const context = {
  model: { provider: "test", id: "reviewer" },
  modelRegistry: {
    async getProviderAuth() { return { auth: { apiKey: "secret" } }; },
    async getApiKeyAndHeaders() { return { ok: true, apiKey: "secret" }; },
  },
  sessionManager: SessionManager.inMemory(),
} as unknown as ExtensionContext;

test("Reviewer auditor rejects a current-shaped receipt when a materialized leg is not readable", async () => {
  const currentRecord = structuredClone(input.record) as any;
  currentRecord.accepted.materials = [{ id: "rules", repositoryPath: "RULES.md", source: "pinned-git", sourcePath: "RULES.md", text: "rules", utf8Length: 5, sha256: "rules" }];
  currentRecord.accepted.bundle = { manifestSha256: "manifest", entries: [{ id: "canonical-skill", relativeClonePath: ".ak-reviewer/materials/canonical-skill.md", utf8Length: 1, sha256: "skill" }] };
  currentRecord.results.standards.runtimeConstructionEvidence = { leg: "standards", workspaceIdentity: "workspace", manifestSha256: "manifest", entries: [{ id: "canonical-skill", relativeClonePath: ".ak-reviewer/materials/canonical-skill.md", utf8Length: 1, sha256: "skill", verified: true }] };
  const audit = createPiReviewerAuditor(async () => {
    throw new Error("provider must not run");
  });
  await assert.rejects(audit({ ...input, record: currentRecord }, { context }), ReviewerAuditEvidenceError);
});
