/**
 * Registry-driven public Receipt extractor / settlement matrix for the one shared
 * packaged-role terminal classifier. Hits real extract* entry points across all
 * seven roles/phases — not helper-only coverage.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  bindCurrentDurableTerminalToMarker,
  buildNavigatorInfrastructureFailureFact,
  classifyPackagedRoleTerminalResult,
  isNavigatorInfrastructureFailureFact,
  isReceiptSettlementBindingClear,
} from "../../src/navigator-invocation-identity.ts";
import { PACKAGED_ROLE_REGISTRY } from "../../src/packaged-role-registry.ts";
import { COLLECTOR_OUTPUT_TOOL } from "../../src/package-contracts/collector-output.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/reviewer-output.ts";
import {
  CODER_OUTPUT_TOOL_NAME,
  FIXER_OUTPUT_TOOL_NAME,
} from "../../src/package-contracts/worker-output.ts";
import { DOCTOR_OUTPUT_TOOL_NAME } from "../../src/doctor-contracts.ts";
import { MERGER_OUTPUT_TOOL_NAME } from "../../src/merger-contracts.ts";
import {
  extractCoderRoleOutcome,
  extractCollectorRoleOutcome,
  extractDoctorRoleOutcome,
  extractFixerRoleOutcome,
  extractJudgeRoleOutcome,
  extractMergerRoleOutcome,
  extractReviewerRoleOutcome,
} from "../../src/public-cli/settlement.ts";
import { publicNavigatorSettlement } from "../../src/role-runtime.ts";

type SessionEntry = {
  type: "message";
  message: {
    role: "toolResult";
    toolName: string;
    isError?: unknown;
    details: unknown;
  };
};

function entry(
  toolName: string,
  details: unknown,
  isError?: unknown,
): SessionEntry {
  const message: SessionEntry["message"] = {
    role: "toolResult",
    toolName,
    details,
  };
  if (isError !== undefined) message.isError = isError;
  return { type: "message", message };
}

function lawfulReviewerReceipt() {
  const skillText = "package code-review skill body\n";
  const axes = ["standards", "spec"] as const;
  const prompt = (axis: string) => ({ text: `${axis} prompt\n` });
  return {
    version: 2 as const,
    status: "completed" as const,
    acceptedBatch: {
      identity: "dispatch",
      legs: axes.map((axis) => ({ axis, prompt: prompt(axis) })),
    },
    reports: Object.fromEntries(
      axes.map((axis) => [axis, { text: `${axis} report` }]),
    ),
    outcomes: Object.fromEntries(
      axes.map((axis) => [
        axis,
        {
          status: "successful",
          prompt: prompt(axis),
          workspaceDisposition: "deleted",
        },
      ]),
    ),
    identities: {
      canonicalSkill: { text: skillText },
      construction: {
        recipe: "reviewer-common-bundle-v1",
      },
      target: {
        repositoryRoot: "/repo",
        objectFormat: "sha1",
        targetHead: "a".repeat(40),
        refs: {
          tag: { objectId: "b".repeat(40), peeledCommitId: null },
        },
      },
    },
  };
}

function lawfulCollectorReceipt() {
  return {
    host: "github.com",
    repository: "acme/widgets",
    prNumber: 3,
    manifestDigest: "a".repeat(64),
    activationTime: "2026-01-01T00:00:00.000Z",
    deadlineTime: "2026-01-01T00:15:00.000Z",
    finalObservationTime: "2026-01-01T00:01:00.000Z",
    finalSnapshotId: "snap-1",
    targetHead: "b".repeat(40),
    groups: [],
    requestAttempts: [],
    snapshots: [
      {
        snapshotId: "snap-1",
        observedAt: "2026-01-01T00:01:00.000Z",
        completedAt: "2026-01-01T00:01:00.000Z",
        completedMono: 1,
        host: "github.com",
        repository: "acme/widgets",
        prNumber: 3,
        prState: "OPEN",
        headOid: "b".repeat(40),
        complete: true,
        evidenceIds: [],
        pageDiagnostics: [],
        normalizedByteLength: 2,
      },
    ],
    evidenceRecords: [],
  };
}

function lawfulDoctorReceipt() {
  return {
    status: "completed" as const,
    case: {
      issueNumber: 40,
      runsPath: ".ak-roles/books/demo/issues/40/runs",
    },
    findings: [],
    cost: {
      invocations: { count: 1, sources: ["review-001"] },
      legs: { count: 1, sources: ["review-001/session/leg.jsonl"] },
      modelApiTurns: { count: 1, sources: ["review-001/session/leg.jsonl"] },
      outputTokens: { count: 7, sources: ["review-001/session/leg.jsonl"] },
      toolCalls: { count: 1, sources: ["review-001/session/leg.jsonl"] },
      retries: {
        count: 0,
        sources: [],
        evidence: "literal run-dir naming",
      },
      statuses: [
        { source: "review-001/session/leg.jsonl", status: "completed" },
      ],
      commits: [],
      sessions: [
        {
          source: "review-001/session/leg.jsonl",
          startedAt: "2026-08-01T05:01:18.580Z",
          endedAt: "2026-08-01T05:01:20.000Z",
          wallMilliseconds: 1420,
          completion: "accepted",
        },
      ],
      outputBytes: {
        count: 1,
        sources: ["review-001/session/leg.jsonl"],
        payload: "raw JSONL bytes",
        providerWireBytes: "unavailable",
      },
    },
  };
}

const ACCEPTED_DETAILS_BY_TOOL: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  [JUDGE_OUTPUT_TOOL_NAME, { judgeStatus: "converged" }],
  [CODER_OUTPUT_TOOL_NAME, { status: "completed", report: "done" }],
  [FIXER_OUTPUT_TOOL_NAME, { status: "planned", report: "plan ready" }],
  [REVIEWER_OUTPUT_TOOL_NAME, lawfulReviewerReceipt()],
  [COLLECTOR_OUTPUT_TOOL, lawfulCollectorReceipt()],
  [DOCTOR_OUTPUT_TOOL_NAME, lawfulDoctorReceipt()],
  [
    MERGER_OUTPUT_TOOL_NAME,
    {
      status: "completed",
      attemptId: "run-merger-classifier-001",
      report: "merged",
      mergeCommitId: "a".repeat(40),
    },
  ],
]);

function extractForTool(
  toolName: string,
  entries: readonly SessionEntry[],
): unknown {
  switch (toolName) {
    case JUDGE_OUTPUT_TOOL_NAME:
      return extractJudgeRoleOutcome(entries as never);
    case CODER_OUTPUT_TOOL_NAME:
      return extractCoderRoleOutcome(entries as never);
    case FIXER_OUTPUT_TOOL_NAME:
      return extractFixerRoleOutcome(entries as never);
    case REVIEWER_OUTPUT_TOOL_NAME:
      return extractReviewerRoleOutcome(entries as never);
    case COLLECTOR_OUTPUT_TOOL:
      return extractCollectorRoleOutcome(entries as never);
    case DOCTOR_OUTPUT_TOOL_NAME:
      return extractDoctorRoleOutcome(entries as never);
    case MERGER_OUTPUT_TOOL_NAME:
      return extractMergerRoleOutcome(entries as never);
    default:
      throw new Error(`unexpected tool ${toolName}`);
  }
}

function acceptedKind(extracted: unknown): string | undefined {
  if (extracted === undefined || extracted === null) return undefined;
  if (typeof extracted !== "object") return undefined;
  if ("kind" in extracted && typeof (extracted as { kind: unknown }).kind === "string") {
    return (extracted as { kind: string }).kind;
  }
  if (
    "outcome" in extracted &&
    typeof (extracted as { outcome?: { kind?: unknown } }).outcome?.kind === "string"
  ) {
    return (extracted as { outcome: { kind: string } }).outcome.kind;
  }
  return undefined;
}

test("registry public extractors and settlement share one closed terminal classifier", () => {
  const infraFact = buildNavigatorInfrastructureFailureFact();
  assert.equal(isNavigatorInfrastructureFailureFact(infraFact), true);
  assert.equal(
    isNavigatorInfrastructureFailureFact({ ...infraFact, extra: true }),
    false,
    "closed fact rejects extras",
  );

  const rolesSeen = new Set<string>();
  for (const registryEntry of PACKAGED_ROLE_REGISTRY) {
    rolesSeen.add(registryEntry.role);
    const acceptedDetails = ACCEPTED_DETAILS_BY_TOOL.get(registryEntry.outputTool);
    assert.ok(
      acceptedDetails !== undefined,
      `${registryEntry.role}: accepted fixture`,
    );

    for (const phase of registryEntry.phases) {
      const label = `${registryEntry.role}:${String(phase)}`;
      const tool = registryEntry.outputTool;

      // Valid accepted → Receipt + settlement.
      const acceptedEntries = [entry(tool, acceptedDetails, false)];
      const acceptedExtracted = extractForTool(tool, acceptedEntries);
      assert.equal(acceptedKind(acceptedExtracted), "accepted", `${label}:extractor-accepted`);
      assert.equal(
        classifyPackagedRoleTerminalResult({
          toolName: tool,
          isError: false,
          details: acceptedDetails,
        }).kind,
        "accepted",
        `${label}:classify-accepted`,
      );
      assert.notEqual(
        publicNavigatorSettlement(registryEntry.role, phase, {
          toolName: tool,
          isError: false,
          details: acceptedDetails,
        })?.kind,
        undefined,
        `${label}:settlement-accepted`,
      );

      // Valid infrastructure terminal → non-Receipt; settlement projects infra.
      const infraEntries = [entry(tool, infraFact, true)];
      assert.equal(
        extractForTool(tool, infraEntries),
        undefined,
        `${label}:extractor-infra-non-receipt`,
      );
      assert.deepEqual(
        publicNavigatorSettlement(registryEntry.role, phase, {
          toolName: tool,
          isError: true,
          details: infraFact,
        }),
        {
          kind: "role_infrastructure_failure",
          role: registryEntry.role,
          phase,
        },
        `${label}:settlement-infra`,
      );
      // Original closed fact remains the durable diagnosis (not laundered to success).
      assert.deepEqual(
        infraEntries[0]!.message.details,
        infraFact,
        `${label}:infra-diagnosis-retained`,
      );

      const negatives: ReadonlyArray<{
        name: string;
        isError?: unknown;
        details: unknown;
      }> = [
        { name: "missing", details: acceptedDetails },
        { name: "string-false", isError: "false", details: acceptedDetails },
        { name: "zero", isError: 0, details: acceptedDetails },
        {
          name: "retryable-true",
          isError: true,
          details: { message: "correctable schema wording" },
        },
        {
          name: "contradictory-false-infra",
          isError: false,
          details: infraFact,
        },
        {
          name: "extra-key-infra",
          isError: true,
          details: { ...infraFact, extra: "not-closed" },
        },
        {
          name: "malformed-infra",
          isError: true,
          details: {
            kind: "role_infrastructure_failure",
            source: "other",
            reasonCode: "host_failure",
          },
        },
      ];

      for (const negative of negatives) {
        const message = {
          toolName: tool,
          ...(negative.isError === undefined ? {} : { isError: negative.isError }),
          details: negative.details,
        };
        assert.equal(
          classifyPackagedRoleTerminalResult(message).kind,
          "nonterminal",
          `${label}:${negative.name}:classify`,
        );
        assert.equal(
          publicNavigatorSettlement(registryEntry.role, phase, message),
          undefined,
          `${label}:${negative.name}:settlement`,
        );
        assert.equal(
          extractForTool(tool, [
            entry(tool, negative.details, negative.isError),
          ]),
          undefined,
          `${label}:${negative.name}:extractor`,
        );
      }
    }
  }

  assert.equal(rolesSeen.size, 7, "all seven packaged roles covered");
  assert.deepEqual(
    [...rolesSeen].sort(),
    ["coder", "collector", "doctor", "fixer", "judge", "merger", "reviewer"],
  );

  // Singleton marker cardinality: two durable terminals after one marker fail closed.
  const invocationId = "019f8c2a-7b3e-7d11-8a4f-1c2d3e4f5a6b";
  for (const registryEntry of PACKAGED_ROLE_REGISTRY) {
    const acceptedDetails = ACCEPTED_DETAILS_BY_TOOL.get(registryEntry.outputTool)!;
    const phase = registryEntry.phases[0]!;
    const marker = {
      type: "custom" as const,
      customType: "ak-navigator-invocation",
      data: {
        invocationId,
        role: registryEntry.role,
        phase,
        subjectKey: "/repo/.ak/work",
      },
    };
    const twoDurable = [
      marker,
      entry(registryEntry.outputTool, acceptedDetails, false),
      entry(registryEntry.outputTool, acceptedDetails, false),
    ] as const;
    assert.equal(
      bindCurrentDurableTerminalToMarker(twoDurable).kind,
      "ambiguous",
      `${registryEntry.role}:two-durable-ambiguous`,
    );
    assert.equal(
      isReceiptSettlementBindingClear(twoDurable),
      false,
      `${registryEntry.role}:receipt-binding-unclear`,
    );
    assert.equal(
      extractForTool(registryEntry.outputTool, twoDurable as never),
      undefined,
      `${registryEntry.role}:extractor-ambiguous-fail-closed`,
    );

    const oneDurable = [
      marker,
      entry(registryEntry.outputTool, acceptedDetails, false),
    ] as const;
    assert.equal(
      bindCurrentDurableTerminalToMarker(oneDurable).kind,
      "bound",
      `${registryEntry.role}:one-durable-bound`,
    );
    assert.equal(
      acceptedKind(extractForTool(registryEntry.outputTool, oneDurable as never)),
      "accepted",
      `${registryEntry.role}:extractor-singleton-accepted`,
    );
  }
});
