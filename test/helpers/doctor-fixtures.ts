/**
 * Shared Doctor test fixtures — the retained-case seed (#78 issue runs) and a
 * lawful completed DoctorOutput. One authority for doctor behavior tests.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { DoctorOutput } from "../../src/doctor-contracts.ts";

export const doctorSessionRows = [
  {
    type: "session",
    version: 3,
    id: "real-shape",
    timestamp: "2026-08-01T05:01:18.580Z",
    cwd: "/repo",
  },
  {
    type: "message",
    timestamp: "2026-08-01T05:01:19.000Z",
    message: {
      role: "assistant",
      responseId: "r1",
      usage: { output: 7 },
      content: [
        {
          type: "toolCall",
          id: "c1",
          name: "ak_coder_output",
          arguments: {},
        },
      ],
    },
  },
  {
    type: "message",
    timestamp: "2026-08-01T05:01:20.000Z",
    message: {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "ak_coder_output",
      isError: false,
      details: { status: "completed", report: "done" },
    },
  },
];

export async function seedDoctorIssueRuns(
  home: string,
  bookKey: string,
  issueNumber: number,
): Promise<string> {
  const runs = join(
    home,
    ".ak-roles",
    "books",
    bookKey,
    "issues",
    String(issueNumber),
    "runs",
  );
  await mkdir(join(runs, "review-001", "session"), { recursive: true });
  await writeFile(
    join(runs, "review-001", "session", "leg.jsonl"),
    `${doctorSessionRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
  return runs;
}

export function sampleCompletedDoctorOutput(
  identity: { issueNumber: number; runsPath: string },
  findingObservation?: string,
): DoctorOutput {
  return {
    status: "completed",
    case: identity,
    findings:
      findingObservation === undefined
        ? []
        : [{ targetKey: "law/unique-s2", observation: findingObservation, evidenceIds: ["ev-1"] }],
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
