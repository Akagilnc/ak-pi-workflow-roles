import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HostContext } from "./host-contracts.ts";
import { Type } from "typebox";

export const AUDITOR_DOSSIER_TOOL_NAME = "ak_get_run_dossier" as const;

/** Run-relative leaf written before gate officer summons (#632 Grok header-only session). */
export const GATE_SUBMISSION_CANDIDATE_FILE = "gate-submission-candidate.json" as const;

export type AuditorDossierLocation = {
  readonly runDirectory: string;
  readonly admittedRequest: string;
  readonly parentSessionCandidate: string;
  readonly attachments: string;
  readonly artifacts: string;
  /** Set when gate summons persisted the in-flight tool-call leaf (#632). */
  readonly submissionCandidate?: string;
};

export type GateSubmissionSessionContext = {
  readonly sessionManager?: {
    getEntries?(): Iterable<unknown>;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve the exact run binding already carried by the parent record session. */
export function auditorRunDirectory(context: ExtensionContext | HostContext): string | undefined {
  const sessionFile = context.sessionManager?.getSessionFile?.();
  if (sessionFile === undefined) return undefined;
  // Sole layout: <run>/session/session.jsonl → climb two levels to the run directory.
  return resolve(dirname(dirname(sessionFile)));
}

/**
 * Latest assistant toolCall leaf on parent session books (memory or disk-backed).
 * Grok books the candidate in memory only (#617 DK-4); Pi books the same shape on JSONL.
 */
export function readLatestToolCallLeaf(context: GateSubmissionSessionContext): unknown | undefined {
  const entries = [...(context.sessionManager?.getEntries?.() ?? [])];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (isRecord(part) && part.type === "toolCall") {
        return entry;
      }
    }
  }
  return undefined;
}

export function gateSubmissionCandidatePath(runDirectory: string): string {
  return join(runDirectory, "artifacts", GATE_SUBMISSION_CANDIDATE_FILE);
}

/**
 * Persist the in-flight tool-call leaf as a run-directory artifact so pointer-only
 * officer summons resolve on hosts whose session.jsonl is header-only (#632 / DK-4).
 * Returns the written path, or undefined when no toolCall leaf is on the books.
 */
export function persistGateSubmissionCandidate(
  runDirectory: string,
  context: GateSubmissionSessionContext,
): string | undefined {
  const leaf = readLatestToolCallLeaf(context);
  if (leaf === undefined) return undefined;
  const path = gateSubmissionCandidatePath(runDirectory);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(leaf)}\n`, "utf8");
  return path;
}

export type CreateAuditorDossierToolOptions = {
  /** Absolute path of the gate-persisted submission leaf, when written. */
  readonly submissionCandidate?: string;
};

/** The one shared, run-bound dossier locator exposed to every auditor seat. */
export function createAuditorDossierTool(
  runDirectory: string | undefined,
  options?: CreateAuditorDossierToolOptions,
) {
  return {
    name: AUDITOR_DOSSIER_TOOL_NAME,
    description: "定位本审计席绑定的 run 卷宗及其证据入口。",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id: string, _params: unknown): Promise<AgentToolResult<AuditorDossierLocation | undefined>> {
      if (runDirectory === undefined) {
        return {
          content: [{ type: "text", text: "本审计席无绑定 run 卷宗记录。" }],
          details: undefined,
        };
      }
      const sessionPath = join(runDirectory, "session", "session.jsonl");
      const submissionCandidate = options?.submissionCandidate;
      // Prefer the persisted gate leaf when present: Grok session.jsonl is header-only
      // (#617 DK-4) and is not a candidate source after material deletion (#632).
      const details: AuditorDossierLocation = {
        runDirectory,
        admittedRequest: join(runDirectory, "admitted-request.json"),
        parentSessionCandidate: submissionCandidate ?? sessionPath,
        attachments: join(runDirectory, "attachments"),
        artifacts: join(runDirectory, "artifacts"),
        ...(submissionCandidate === undefined ? {} : { submissionCandidate }),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
      };
    },
  };
}
