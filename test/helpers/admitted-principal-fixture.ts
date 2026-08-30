/**
 * Minimal typed principal fixture — avoids `as any` on required Admitted.principal.
 */
import { join } from "node:path";

import type { DurablePrincipal } from "../../src/host-contracts.ts";
import type {
  AdmittedDoctorInvocation,
  AdmittedJudgeInvocation,
  AdmittedReviewerInvocation,
} from "../../src/public-cli/invocation.ts";

/** Test-owned opaque principal fixture — two-field wire shape, no production codec. */
export function fixturePrincipal(
  sessionDirectory: string,
  sessionFile: string = join(sessionDirectory, "session.jsonl"),
): DurablePrincipal {
  return { sessionDirectory, sessionFile } as DurablePrincipal;
}

function sessionCoords(runDirectory: string, sessionDirectory?: string, sessionFile?: string) {
  const dir = sessionDirectory ?? join(runDirectory, "session");
  return { sessionDirectory: dir, sessionFile: sessionFile ?? join(dir, "session.jsonl") };
}

export function fixtureJudgeAdmitted(
  input: Omit<AdmittedJudgeInvocation, "role" | "principal" | "attachments" | "instruction" | "instructionEmpty" | "admittedRequestPath"> &
    Partial<Pick<AdmittedJudgeInvocation, "attachments" | "instruction" | "instructionEmpty" | "admittedRequestPath" | "principal">> & {
      sessionDirectory?: string;
      sessionFile?: string;
    },
): AdmittedJudgeInvocation {
  const coords = sessionCoords(input.runDirectory, input.sessionDirectory, input.sessionFile);
  const { sessionDirectory: _sd, sessionFile: _sf, ...rest } = input;
  return {
    role: "judge",
    instruction: "x",
    instructionEmpty: false,
    attachments: [],
    admittedRequestPath: join(input.runDirectory, "admitted-request.json"),
    ...rest,
    principal: input.principal ?? fixturePrincipal(coords.sessionDirectory, coords.sessionFile),
  } satisfies AdmittedJudgeInvocation;
}

export function fixtureDoctorAdmitted(
  input: Omit<AdmittedDoctorInvocation, "role" | "principal" | "attachments" | "instruction" | "instructionEmpty" | "admittedRequestPath"> &
    Partial<Pick<AdmittedDoctorInvocation, "attachments" | "instruction" | "instructionEmpty" | "admittedRequestPath" | "principal">> & {
      sessionDirectory?: string;
      sessionFile?: string;
    },
): AdmittedDoctorInvocation {
  const coords = sessionCoords(input.runDirectory, input.sessionDirectory, input.sessionFile);
  const { sessionDirectory: _sd, sessionFile: _sf, ...rest } = input;
  return {
    role: "doctor",
    instruction: "inspect",
    instructionEmpty: false,
    attachments: [],
    admittedRequestPath: join(input.runDirectory, "admitted-request.json"),
    ...rest,
    principal: input.principal ?? fixturePrincipal(coords.sessionDirectory, coords.sessionFile),
  } satisfies AdmittedDoctorInvocation;
}

export function fixtureReviewerAdmitted(
  input: Omit<AdmittedReviewerInvocation, "role" | "principal" | "attachments" | "instruction" | "instructionEmpty" | "admittedRequestPath" | "authorityRefs"> &
    Partial<Pick<AdmittedReviewerInvocation, "attachments" | "instruction" | "instructionEmpty" | "admittedRequestPath" | "authorityRefs" | "principal">> & {
      sessionDirectory?: string;
      sessionFile?: string;
    },
): AdmittedReviewerInvocation {
  const coords = sessionCoords(input.runDirectory, input.sessionDirectory, input.sessionFile);
  const { sessionDirectory: _sd, sessionFile: _sf, ...rest } = input;
  return {
    role: "reviewer",
    instruction: "",
    instructionEmpty: true,
    attachments: [],
    admittedRequestPath: join(input.runDirectory, "admitted-request.json"),
    authorityRefs: [],
    ...rest,
    principal: input.principal ?? fixturePrincipal(coords.sessionDirectory, coords.sessionFile),
  } satisfies AdmittedReviewerInvocation;
}
