/**
 * Typed admitted-principal fixtures for public-cli tests.
 * Keeps principal required without `as any` erasures.
 */
import { join } from "node:path";

import type { DurablePrincipal } from "../../src/host-contracts.ts";
import {
  piDurablePrincipalAuthority,
  rehydratePiDurablePrincipal,
} from "../../src/pi/durable-principal.ts";
import type {
  AdmittedDoctorInvocation,
  AdmittedJudgeInvocation,
  AdmittedReviewerInvocation,
} from "../../src/public-cli/invocation.ts";

export function fixturePrincipal(
  sessionDirectory: string,
  sessionFile: string = join(sessionDirectory, "session.jsonl"),
): DurablePrincipal {
  return rehydratePiDurablePrincipal(piDurablePrincipalAuthority, {
    sessionDirectory,
    sessionFile,
  });
}

export function fixtureJudgeAdmitted(
  input: {
    readonly runId: string;
    readonly bookKey: string;
    readonly projectRoot: string;
    readonly runDirectory: string;
    readonly instruction?: string;
    readonly instructionEmpty?: boolean;
    readonly attachments?: AdmittedJudgeInvocation["attachments"];
    readonly admittedRequestPath?: string;
    readonly principal?: DurablePrincipal;
    readonly sessionDirectory?: string;
    readonly sessionFile?: string;
    readonly correlationId?: string;
    readonly ticketNumber?: number;
  },
): AdmittedJudgeInvocation {
  const sessionDirectory = input.sessionDirectory ?? join(input.runDirectory, "session");
  const sessionFile = input.sessionFile ?? join(sessionDirectory, "session.jsonl");
  return {
    role: "judge",
    runId: input.runId,
    bookKey: input.bookKey,
    projectRoot: input.projectRoot,
    runDirectory: input.runDirectory,
    instruction: input.instruction ?? "x",
    instructionEmpty: input.instructionEmpty ?? false,
    attachments: input.attachments ?? [],
    principal: input.principal ?? fixturePrincipal(sessionDirectory, sessionFile),
    admittedRequestPath:
      input.admittedRequestPath ?? join(input.runDirectory, "admitted-request.json"),
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    ...(input.ticketNumber === undefined ? {} : { ticketNumber: input.ticketNumber }),
  } satisfies AdmittedJudgeInvocation;
}

export function fixtureDoctorAdmitted(
  input: {
    readonly runId: string;
    readonly bookKey: string;
    readonly projectRoot: string;
    readonly runDirectory: string;
    readonly issueNumber: number;
    readonly caseRunsPath: string;
    readonly caseIdentity: AdmittedDoctorInvocation["caseIdentity"];
    readonly instruction?: string;
    readonly instructionEmpty?: boolean;
    readonly attachments?: AdmittedDoctorInvocation["attachments"];
    readonly admittedRequestPath?: string;
    readonly principal?: DurablePrincipal;
    readonly sessionDirectory?: string;
    readonly sessionFile?: string;
  },
): AdmittedDoctorInvocation {
  const sessionDirectory = input.sessionDirectory ?? join(input.runDirectory, "session");
  const sessionFile = input.sessionFile ?? join(sessionDirectory, "session.jsonl");
  return {
    role: "doctor",
    runId: input.runId,
    bookKey: input.bookKey,
    projectRoot: input.projectRoot,
    runDirectory: input.runDirectory,
    instruction: input.instruction ?? "inspect",
    instructionEmpty: input.instructionEmpty ?? false,
    attachments: input.attachments ?? [],
    principal: input.principal ?? fixturePrincipal(sessionDirectory, sessionFile),
    admittedRequestPath:
      input.admittedRequestPath ?? join(input.runDirectory, "admitted-request.json"),
    issueNumber: input.issueNumber,
    caseRunsPath: input.caseRunsPath,
    caseIdentity: input.caseIdentity,
  } satisfies AdmittedDoctorInvocation;
}

export function fixtureReviewerAdmitted(
  input: {
    readonly runId: string;
    readonly bookKey: string;
    readonly projectRoot: string;
    readonly runDirectory: string;
    readonly baseRevision: string;
    readonly instruction?: string;
    readonly instructionEmpty?: boolean;
    readonly attachments?: AdmittedReviewerInvocation["attachments"];
    readonly admittedRequestPath?: string;
    readonly authorityRefs?: readonly string[];
    readonly principal?: DurablePrincipal;
    readonly sessionDirectory?: string;
    readonly sessionFile?: string;
  },
): AdmittedReviewerInvocation {
  const sessionDirectory = input.sessionDirectory ?? join(input.runDirectory, "session");
  const sessionFile = input.sessionFile ?? join(sessionDirectory, "session.jsonl");
  return {
    role: "reviewer",
    runId: input.runId,
    bookKey: input.bookKey,
    projectRoot: input.projectRoot,
    runDirectory: input.runDirectory,
    instruction: input.instruction ?? "",
    instructionEmpty: input.instructionEmpty ?? true,
    attachments: input.attachments ?? [],
    principal: input.principal ?? fixturePrincipal(sessionDirectory, sessionFile),
    admittedRequestPath:
      input.admittedRequestPath ?? join(input.runDirectory, "admitted-request.json"),
    baseRevision: input.baseRevision,
    authorityRefs: input.authorityRefs ?? [],
  } satisfies AdmittedReviewerInvocation;
}
