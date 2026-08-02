import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxToolCall,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  AUDIT_ESCALATION_KIND,
  disposeComplianceDecision,
  isAuditEscalationResult,
  projectAuditEscalation,
} from "../src/audit-escalation.ts";
import {
  AUDITOR_SOUL_PATHS,
  AUDITOR_SOUL_ROLES,
  loadAuditorSoul,
} from "../src/auditor-soul.ts";
import { createPiDoctorAuditor, DOCTOR_AUDIT_TOOL_NAME } from "../src/doctor-auditor.ts";
import { createPiFixerAuditor, FIXER_AUDIT_TOOL_NAME } from "../src/fixer-auditor.ts";
import { createPiJudgeAuditor, JUDGE_AUDIT_TOOL_NAME } from "../src/judge-auditor.ts";
import { createPiReviewerAuditor, REVIEWER_AUDIT_TOOL_NAME } from "../src/reviewer-auditor.ts";
import {
  JUDGE_OUTPUT_TOOL_NAME,
  validateAcceptedDetails,
} from "../src/package-contracts/terminating-tools.ts";

const context = {
  model: { provider: "audit-test", id: "same-model" },
  modelRegistry: {
    async getProviderAuth() {
      return { auth: { apiKey: "secret" } };
    },
    async getApiKeyAndHeaders() {
      return { ok: true as const, apiKey: "secret" };
    },
  },
} as unknown as ExtensionContext;

const escalationArguments = {
  status: "escalate",
  conflicts: ["Soul authority and controlling authority disagree"],
  decisionGate: {
    question: "Which authority governs this submission?",
    options: ["Use the Soul", "Use the controlling authority"],
  },
};

function response(toolName: string): AssistantMessage {
  return fauxAssistantMessage(
    fauxToolCall(toolName, escalationArguments),
    { stopReason: "toolUse" },
  );
}

function captureSystemPrompt(toolName: string, systemPrompt: { value: string | undefined }) {
  return async (_model: unknown, request: Context) => {
    systemPrompt.value = request.systemPrompt;
    return response(toolName);
  };
}

const judgeInput = {
  soul: "judge law",
  transcript: "judge record",
  verdict: { judgeStatus: "converged" as const },
};
const fixerInput = {
  soul: "fixer law",
  packet: { version: 1 as const, instructions: "repair", prerequisites: [] },
  phase: "apply" as const,
  transcript: "fixer record",
  candidate: { status: "completed" as const, report: "done", classResults: [] },
};
const reviewerInput = {
  soul: "reviewer law",
  canonicalSkill: "skill",
  task: "task",
  record: {} as any,
  candidate: {} as any,
};
const doctorInput = {
  soul: "doctor law",
  patient: {
    version: 1 as const,
    identity: { issueNumber: 58, runsPath: ".ak/work/issues/58/runs" },
    evidence: [],
    cost: { invocations: { total: 0, sources: [] }, bytes: 0 },
  },
  readRecord: [],
  testimony: { status: "refused" as const, reason: "missing", missingEvidence: [] },
} as any;

const auditorCases = [
  {
    role: "judge" as const,
    toolName: JUDGE_AUDIT_TOOL_NAME,
    run: (complete: any) => createPiJudgeAuditor(complete)(judgeInput, { context }),
  },
  {
    role: "fixer" as const,
    toolName: FIXER_AUDIT_TOOL_NAME,
    run: (complete: any) => createPiFixerAuditor(complete)(fixerInput, { context }),
  },
  {
    role: "reviewer" as const,
    toolName: REVIEWER_AUDIT_TOOL_NAME,
    run: (complete: any) => createPiReviewerAuditor(complete)(reviewerInput, { context }),
  },
  {
    role: "doctor" as const,
    toolName: DOCTOR_AUDIT_TOOL_NAME,
    run: (complete: any) => createPiDoctorAuditor(complete)(doctorInput, { context }),
  },
] as const;

test("all retained auditors load their exact Soul and share typed escalation", async () => {
  assert.deepEqual(AUDITOR_SOUL_ROLES, ["judge", "fixer", "reviewer", "doctor"]);
  for (const entry of auditorCases) {
    const prompt = { value: undefined as string | undefined };
    const result = await entry.run(captureSystemPrompt(entry.toolName, prompt));
    assert.equal(result.status, "escalate");
    assert.deepEqual(result.conflicts, escalationArguments.conflicts);
    assert.deepEqual(result.decisionGate, escalationArguments.decisionGate);
    assert.equal(
      prompt.value,
      await readFile(AUDITOR_SOUL_PATHS[entry.role], "utf8"),
      `${entry.role} audit prompt must be exactly its Soul file`,
    );
  }
});

test("changing one loader source affects only that role's next audit", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "ak-auditor-soul-"));
  const replacement = resolve(directory, "judge.md");
  const originalPath = AUDITOR_SOUL_PATHS.judge;
  const originalMap = AUDITOR_SOUL_PATHS as Record<string, string>;
  await writeFile(replacement, "JUDGE SOUL EDIT\n", "utf8");
  originalMap.judge = replacement;
  try {
    const judgePrompt = { value: undefined as string | undefined };
    const reviewerPrompt = { value: undefined as string | undefined };
    await createPiJudgeAuditor(captureSystemPrompt(JUDGE_AUDIT_TOOL_NAME, judgePrompt))(
      judgeInput,
      { context },
    );
    await createPiReviewerAuditor(captureSystemPrompt(REVIEWER_AUDIT_TOOL_NAME, reviewerPrompt))(
      reviewerInput,
      { context },
    );
    assert.equal(judgePrompt.value, "JUDGE SOUL EDIT\n");
    assert.equal(reviewerPrompt.value, await readFile(AUDITOR_SOUL_PATHS.reviewer, "utf8"));
  } finally {
    originalMap.judge = originalPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Soul load failures preserve missing causes and reject blank files", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "ak-auditor-soul-failure-"));
  const originalPath = AUDITOR_SOUL_PATHS.judge;
  const originalMap = AUDITOR_SOUL_PATHS as Record<string, string>;
  try {
    originalMap.judge = resolve(directory, "missing.md");
    await assert.rejects(loadAuditorSoul("judge"), (error: unknown) =>
      (error as NodeJS.ErrnoException).code === "ENOENT",
    );
    const blank = resolve(directory, "blank.md");
    await writeFile(blank, "  \n", "utf8");
    originalMap.judge = blank;
    await assert.rejects(loadAuditorSoul("judge"), /judge auditor Soul is blank/);
  } finally {
    originalMap.judge = originalPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("escalation projects one terminating human decision and is not an accepted Receipt", async () => {
  const decision = {
    status: "escalate" as const,
    conflicts: escalationArguments.conflicts,
    decisionGate: escalationArguments.decisionGate,
  };
  let passCalls = 0;
  let reviseCalls = 0;
  const result = await disposeComplianceDecision(decision, {
    pass: () => { passCalls += 1; throw new Error("pass branch used"); },
    revise: () => { reviseCalls += 1; throw new Error("revise branch used"); },
    escalate: (value) => value,
  });
  assert.equal(passCalls, 0);
  assert.equal(reviseCalls, 0);
  assert.equal(result.terminate, true);
  assert.equal(result.details.kind, AUDIT_ESCALATION_KIND);
  assert.deepEqual(result.details.conflicts, decision.conflicts);
  assert.deepEqual(result.details.decisionGate, decision.decisionGate);
  assert.match(result.content[0].text, /Human decision required/);
  assert.doesNotMatch(result.content[0].text, /accepted/i);
  assert.equal(isAuditEscalationResult(result.details), true);
  assert.throws(
    () => validateAcceptedDetails(JUDGE_OUTPUT_TOOL_NAME, result.details),
    /not an accepted role receipt/,
  );
  assert.deepEqual(projectAuditEscalation(decision).details, result.details);
});
