/**
 * Caller-facing resume failure facts (#1058).
 * Host session facts come from the host adapter. This module only presents
 * confirmable facts and keeps an unclassified diagnostic unchanged.
 */
import { readFile, stat } from "node:fs/promises";

import { AK_ROLE_AUDITOR_SUBJECT_ENV } from "../auditor-soul.ts";
import type {
  DurablePrincipal,
  DurablePrincipalAuthority,
  HostSessionAvailability,
} from "../host-contracts.ts";
import {
  packagedAdmittedSubject,
  packagedSubjectChoices,
} from "../packaged-role-registry.ts";
import { CliUsageError } from "./cli-errors.ts";

export type ResumeFailureFact =
  | {
      readonly kind: "workspace-missing";
      readonly projectRoot: string;
      readonly runDirectory: string;
      readonly diagnostic: string;
    }
  | {
      readonly kind: "host-session-absent";
      readonly sessionFile: string;
      readonly runDirectory: string;
    }
  | {
      readonly kind: "host-session-unavailable";
      readonly sessionFile: string;
      readonly runDirectory: string;
      readonly hostDiagnostic?: string;
    }
  | {
      readonly kind: "auditor-subject-missing";
      readonly runDirectory: string;
      readonly resumeRunId: string;
      readonly subjectEnv: typeof AK_ROLE_AUDITOR_SUBJECT_ENV;
      readonly sourceRunPath?: string;
      readonly recordedSubject?: string;
      /** Same-run input. Not an `ak-role auditor` invocation. */
      readonly provide: string;
    };

export class ResumeFailureError extends CliUsageError {
  constructor(readonly fact: ResumeFailureFact) {
    super(formatResumeFailure(fact));
    this.name = "ResumeFailureError";
  }
}

export async function readHostSessionAvailability(
  authority: DurablePrincipalAuthority,
  principal: DurablePrincipal,
): Promise<HostSessionAvailability> {
  if (authority.readSessionAvailability !== undefined) {
    return authority.readSessionAvailability(principal);
  }
  const sessionFile = authority.decode(principal).sessionFile;
  if (await authority.isAvailable(principal)) {
    return { available: true, sessionFile };
  }
  return { available: false, sessionFile, absent: false };
}

export function unavailableHostSessionFact(input: {
  readonly runDirectory: string;
  readonly availability: HostSessionAvailability;
}): ResumeFailureFact {
  if (input.availability.available) {
    throw new Error("unavailableHostSessionFact requires an unavailable session");
  }
  if (input.availability.absent) {
    return {
      kind: "host-session-absent",
      sessionFile: input.availability.sessionFile,
      runDirectory: input.runDirectory,
    };
  }
  const cause = input.availability.cause;
  const hostDiagnostic = cause instanceof Error && cause.message.trim() !== ""
    ? cause.message
    : undefined;
  return {
    kind: "host-session-unavailable",
    sessionFile: input.availability.sessionFile,
    runDirectory: input.runDirectory,
    ...(hostDiagnostic === undefined ? {} : { hostDiagnostic }),
  };
}

/** Confirmable resume blockers after the run record has loaded. Does not guess. */
export async function confirmResumeBlocker(admitted: {
  readonly role: string;
  readonly runId: string;
  readonly runDirectory: string;
  readonly admittedRequestPath: string;
}): Promise<ResumeFailureFact | undefined> {
  return auditorSubjectFact(admitted);
}

/**
 * A spawn ENOENT is a missing directory only when that directory is confirmed
 * absent. A missing git binary with a live directory stays the original error.
 * Recorded project relocation is not a failure by itself (#1058).
 */
export async function missingWorkspaceOnEnoent(
  error: unknown,
  admitted: { readonly projectRoot: string; readonly runDirectory: string },
): Promise<ResumeFailureFact | undefined> {
  if (!isSpawnEnoent(error)) return undefined;
  const workspace = await workspaceFact(admitted.projectRoot, admitted.runDirectory);
  if (workspace?.kind !== "workspace-missing") return undefined;
  return { ...workspace, diagnostic: diagnosticLabel(error) };
}

export function formatResumeFailure(fact: ResumeFailureFact): string {
  switch (fact.kind) {
    case "workspace-missing":
      return `工作目录不存在：${fact.projectRoot}。可查卷宗：${fact.runDirectory}。原诊断：${fact.diagnostic}`;
    case "host-session-absent":
      return `这条 run 没有可续的宿主会话，会话文件不存在：${fact.sessionFile}。可查卷宗：${fact.runDirectory}`;
    case "host-session-unavailable":
      return `这条 run 现在不能续宿主会话。可查会话：${fact.sessionFile}。${
        fact.hostDiagnostic === undefined ? "" : `宿主诊断：${fact.hostDiagnostic}。`
      }可查卷宗：${fact.runDirectory}`;
    case "auditor-subject-missing": {
      const recorded = fact.recordedSubject === undefined
        ? "这条已受理腿的记录没有保存被审席位，本次 resume 也没有 --subject，所以还不能选择被审席位。"
        : `受理记录里有被审席位 ${fact.recordedSubject}，但本次 resume 没有把它交给宿主。`;
      const source = fact.sourceRunPath === undefined
        ? "受理记录里没有被审来源路径。"
        : `被审来源仍是：${fact.sourceRunPath}。`;
      return `审刑院续跑缺少被审席位。${recorded}ak-role resume 不收 --subject。不要改跑 ak-role auditor，那会另起一条腿。要续同一条 run，先设置 ${fact.subjectEnv}，再执行：${fact.provide}。可查卷宗：${fact.runDirectory}。${source}`;
    }
  }
}

function diagnosticLabel(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const label = error.name !== "" && error.name !== "Error"
    ? `${error.name}: ${error.message}`
    : error.message;
  if (error.cause === undefined) return label;
  const cause = error.cause instanceof Error ? error.cause.message : String(error.cause);
  return cause.trim() === "" ? label : `${label}; cause: ${cause}`;
}

function isSpawnEnoent(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if (typeof current === "object" && "code" in current && "syscall" in current) {
      const record = current as { code?: unknown; syscall?: unknown };
      if (record.code === "ENOENT" && typeof record.syscall === "string" && record.syscall.startsWith("spawn")) {
        return true;
      }
    }
    if (!(current instanceof Error)) return false;
    current = current.cause;
  }
  return false;
}

async function workspaceFact(
  projectRoot: string,
  runDirectory: string,
): Promise<Extract<ResumeFailureFact, { kind: "workspace-missing" }> | undefined> {
  try {
    await stat(projectRoot);
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    return {
      kind: "workspace-missing",
      projectRoot,
      runDirectory,
      diagnostic: "",
    };
  }
}

async function auditorSubjectFact(admitted: {
  readonly role: string;
  readonly runId: string;
  readonly runDirectory: string;
  readonly admittedRequestPath: string;
}): Promise<ResumeFailureFact | undefined> {
  const choices = packagedSubjectChoices(admitted.role);
  if (choices === undefined) return undefined;
  const raw = process.env[AK_ROLE_AUDITOR_SUBJECT_ENV];
  if (typeof raw === "string" && packagedAdmittedSubject(admitted.role, raw.trim()) !== undefined) {
    return undefined;
  }
  const stored = await readStoredAuditorContext(admitted.admittedRequestPath, admitted.role);
  const subjectToken = stored.recordedSubject ?? `<${choices.join("|")}>`;
  return {
    kind: "auditor-subject-missing",
    runDirectory: admitted.runDirectory,
    ...(stored.sourceRunPath === undefined ? {} : { sourceRunPath: stored.sourceRunPath }),
    ...(stored.recordedSubject === undefined ? {} : { recordedSubject: stored.recordedSubject }),
    resumeRunId: admitted.runId,
    subjectEnv: AK_ROLE_AUDITOR_SUBJECT_ENV,
    provide: `${AK_ROLE_AUDITOR_SUBJECT_ENV}=${subjectToken} ak-role resume ${admitted.runId}`,
  };
}

async function readStoredAuditorContext(
  admittedRequestPath: string,
  role: string,
): Promise<{ sourceRunPath?: string; recordedSubject?: string }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(admittedRequestPath, "utf8"));
  } catch {
    return {};
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const sourceRunPath = typeof record.sourceRunPath === "string" && record.sourceRunPath.trim() !== ""
    ? record.sourceRunPath
    : undefined;
  const recordedSubject = typeof record.subject === "string"
    ? packagedAdmittedSubject(role, record.subject.trim())
    : undefined;
  return {
    ...(sourceRunPath === undefined ? {} : { sourceRunPath }),
    ...(recordedSubject === undefined ? {} : { recordedSubject }),
  };
}
