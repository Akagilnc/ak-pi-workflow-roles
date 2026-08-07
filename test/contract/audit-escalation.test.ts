import assert from "node:assert/strict";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxToolCall,
  type AssistantMessage,
  type Context,
  type ProviderStreamOptions,
} from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  AUDIT_ESCALATION_KIND,
  disposeComplianceDecision,
  isAuditEscalationResult,
  projectAuditEscalation,
} from "../../src/audit-escalation.ts";
import { AUDITOR_SOUL_ROLES } from "../../src/auditor-soul.ts";
import { createPiDoctorAuditor, DOCTOR_AUDIT_TOOL_NAME } from "../../src/doctor-auditor.ts";
import { createPiFixerAuditor, FIXER_AUDIT_TOOL_NAME } from "../../src/fixer-auditor.ts";
import { createPiJudgeAuditor, JUDGE_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";
import { createPiReviewerAuditor, REVIEWER_AUDIT_TOOL_NAME } from "../../src/reviewer-auditor.ts";
import {
  JUDGE_OUTPUT_TOOL_NAME,
  validateAcceptedDetails,
} from "../../src/package-contracts/terminating-tools.ts";

const context = {
  model: { provider: "audit-test", id: "same-model", api: "openai-responses" },
  modelRegistry: {
    async getProviderAuth() {
      return { auth: { apiKey: "secret" } };
    },
    async getApiKeyAndHeaders() {
      return { ok: true as const, apiKey: "secret" };
    },
  },
  sessionManager: SessionManager.inMemory(),
} as unknown as ExtensionContext;

const escalationArguments = {
  status: "escalate",
  violations: [],
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
    run: (complete: any, auditContext: ExtensionContext = context) => createPiJudgeAuditor(complete)(judgeInput, { context: auditContext }),
  },
  {
    role: "fixer" as const,
    toolName: FIXER_AUDIT_TOOL_NAME,
    run: (complete: any, auditContext: ExtensionContext = context) => createPiFixerAuditor(complete)(fixerInput, { context: auditContext }),
  },
  {
    role: "reviewer" as const,
    toolName: REVIEWER_AUDIT_TOOL_NAME,
    run: (complete: any, auditContext: ExtensionContext = context) => createPiReviewerAuditor(complete)(reviewerInput, { context: auditContext }),
  },
  {
    role: "doctor" as const,
    toolName: DOCTOR_AUDIT_TOOL_NAME,
    run: (complete: any, auditContext: ExtensionContext = context) => createPiDoctorAuditor(complete)(doctorInput, { context: auditContext }),
  },
] as const;

test("all retained auditors share typed escalation", async () => {
  // Census is fixture integrity for this loop — assert once at the top, not as a sibling test.
  assert.deepEqual(auditorCases.map((entry) => entry.role), AUDITOR_SOUL_ROLES);
  for (const entry of auditorCases) {
    const prompt = { value: undefined as string | undefined };
    const result = await entry.run(captureSystemPrompt(entry.toolName, prompt));
    assert.equal(result.status, "escalate");
    assert.deepEqual(result.conflicts, escalationArguments.conflicts);
    assert.deepEqual(result.decisionGate, escalationArguments.decisionGate);
    assert.match(prompt.value ?? "", /./, `${entry.role} audit must load a nonblank Soul`);
  }
});

test("shared compliance transport forces the active decision tool and one call", async () => {
  for (const api of ["openai-responses", "openai-codex-responses"] as const) {
    const auditContext = {
      ...context,
      model: { provider: "audit-test", id: "same-model", api },
    } as unknown as ExtensionContext;
    for (const entry of auditorCases) {
      let seen: { context: Context; options: ProviderStreamOptions } | undefined;
      await entry.run(async (_model: unknown, request: Context, options: ProviderStreamOptions) => {
        seen = { context: request, options };
        return response(entry.toolName);
      }, auditContext);
      assert.deepEqual(
        seen?.context.tools?.map((tool) => tool.name),
        [entry.toolName],
        `${entry.role} must expose only its active decision tool`,
      );
      const parameters = seen?.context.tools?.[0]?.parameters as Record<string, unknown> | undefined;
      assert.equal(parameters?.type, "object", `${entry.role} audit schema must have an object root`);
      assert.equal(parameters?.anyOf, undefined, `${entry.role} audit schema must not have a root union`);
      assert.deepEqual(
        seen?.options.toolChoice,
        api === "openai-responses"
          ? { type: "function", name: entry.toolName }
          : "required",
        `${entry.role} must force its active decision tool for ${api}`,
      );
      const payload = await seen?.options.onPayload?.(
        { tool_choice: "auto", parallel_tool_calls: true },
        auditContext.model!,
      );
      if (api === "openai-responses" || api === "openai-codex-responses") {
        assert.deepEqual(payload, {
          tool_choice: api === "openai-responses"
            ? { type: "function", name: entry.toolName }
            : "required",
          parallel_tool_calls: false,
        });
      }
    }
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

test("isAuditEscalationResult recognises by kind only — mixed elements and empty gate stay lawful", () => {
  const shapes = [
    {
      kind: AUDIT_ESCALATION_KIND,
      conflicts: ["ok", 4],
      decisionGate: { question: "Q", options: ["A"] },
    },
    {
      kind: AUDIT_ESCALATION_KIND,
      conflicts: ["c"],
      decisionGate: { question: "Q", options: ["A", 7] },
    },
    {
      kind: AUDIT_ESCALATION_KIND,
      conflicts: ["only"],
      decisionGate: { question: "", options: [] },
    },
    {
      kind: AUDIT_ESCALATION_KIND,
      conflicts: [],
      decisionGate: { question: "", options: [] },
    },
  ];
  for (const shape of shapes) {
    assert.equal(isAuditEscalationResult(shape), true, JSON.stringify(shape));
  }
  assert.equal(isAuditEscalationResult({ kind: "other" }), false);
  assert.equal(isAuditEscalationResult({ conflicts: ["c"] }), false);
});

test("disposeComplianceDecision preserves delivered role output on escalate face", async () => {
  const decision = {
    status: "escalate" as const,
    conflicts: ["conflict"],
    decisionGate: { question: "", options: [] as unknown[] },
  };
  const delivered = { judgeStatus: "converged" as const, note: "keep-me" };
  const result = await disposeComplianceDecision(
    decision,
    {
      pass: () => {
        throw new Error("pass");
      },
      revise: () => {
        throw new Error("revise");
      },
      escalate: (value) => value,
    },
    delivered,
  );
  assert.equal(result.details.kind, AUDIT_ESCALATION_KIND);
  assert.equal(
    (result.details as { judgeStatus?: unknown }).judgeStatus,
    "converged",
  );
  assert.equal((result.details as { note?: unknown }).note, "keep-me");
  assert.deepEqual(result.details.conflicts, ["conflict"]);
  // Without delivered output, verdict fields are absent (negative control).
  const stripped = projectAuditEscalation(decision).details;
  assert.equal((stripped as { note?: unknown }).note, undefined);
});
