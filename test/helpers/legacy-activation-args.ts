/**
 * Test-only materialization of turn requests into Pi extra-args.
 * Production builders were deleted (#526); tests use these to keep argv-shape assertions.
 */
import type { DurablePrincipalAuthority } from "../../src/host-contracts.ts";
import { engineSessionMaterialFromOptions } from "../../src/package-resources/engine-material.ts";
import { buildPiTurnExtraArgs } from "../../src/pi/role-turn-host.ts";
import type { SeatModelConfig } from "../../src/public-cli/config.ts";
import { buildCoderTurnRequest } from "../../src/public-cli/coder-run.ts";
import { buildFixerTurnRequest } from "../../src/public-cli/fixer-run.ts";
import { buildJudgeTurnRequest } from "../../src/public-cli/judge-run.ts";
import { buildReviewerTurnRequest } from "../../src/public-cli/reviewer-run.ts";
import { buildMergerTurnRequest } from "../../src/public-cli/merger-run.ts";
import { buildCollectorTurnRequest } from "../../src/public-cli/collector-run.ts";
import { buildDoctorTurnRequest } from "../../src/public-cli/doctor-run.ts";
import { buildNotaryTurnRequest } from "../../src/public-cli/notary-run.ts";
import {
  buildCoderTransportPrompt,
  buildFixerTransportPrompt,
  buildJudgeTransportPrompt,
  buildReviewerTransportPrompt,
  buildMergerTransportPrompt,
  buildCollectorTransportPrompt,
  buildDoctorTransportPrompt,
  buildNotaryTransportPrompt,
  type AdmittedCoderInvocation,
  type AdmittedFixerInvocation,
  type AdmittedJudgeInvocation,
  type AdmittedReviewerInvocation,
  type AdmittedMergerInvocation,
  type AdmittedCollectorInvocation,
  type AdmittedDoctorInvocation,
  type AdmittedNotaryInvocation,
} from "../../src/public-cli/invocation.ts";
import { selectResumeContinuationPrompt } from "../../src/public-cli/run-lifecycle.ts";

type Common = {
  principalAuthority: DurablePrincipalAuthority;
  packageRoot: string;
  model?: SeatModelConfig;
  engine?: string;
  extraPiArgs?: readonly string[];
  message?: string;
};

function homeAgent(admitted: { projectRoot?: string }) {
  return {
    home: admitted.projectRoot ?? "/tmp",
    agentDir: "/tmp/agent",
  };
}

export function buildCoderActivationExtraArgs(admitted: AdmittedCoderInvocation, options: Common): string[] {
  const ha = homeAgent(admitted);
  return buildPiTurnExtraArgs(
    buildCoderTurnRequest(admitted, {
      packageRoot: options.packageRoot,
      ...ha,
      ...(options.model ? { model: options.model } : {}),
      ...(options.engine ? { engine: options.engine } : {}),
      continuation: {
        kind: "initial",
        prompt: buildCoderTransportPrompt(admitted, engineSessionMaterialFromOptions(options)),
      },
    }),
    options.principalAuthority,
    options.extraPiArgs ?? [],
  );
}

export function buildCoderResumeActivationExtraArgs(admitted: AdmittedCoderInvocation, options: Common): string[] {
  const ha = homeAgent(admitted);
  return buildPiTurnExtraArgs(
    buildCoderTurnRequest(admitted, {
      packageRoot: options.packageRoot,
      ...ha,
      ...(options.model ? { model: options.model } : {}),
      continuation: {
        kind: "resume",
        prompt: selectResumeContinuationPrompt(options.message),
      },
    }),
    options.principalAuthority,
    options.extraPiArgs ?? [],
  );
}

export function buildFixerActivationExtraArgs(admitted: AdmittedFixerInvocation, options: Common): string[] {
  const ha = homeAgent(admitted);
  return buildPiTurnExtraArgs(
    buildFixerTurnRequest(admitted, {
      packageRoot: options.packageRoot,
      ...ha,
      ...(options.model ? { model: options.model } : {}),
      ...(options.engine ? { engine: options.engine } : {}),
      continuation: {
        kind: "initial",
        prompt: buildFixerTransportPrompt(admitted, engineSessionMaterialFromOptions(options)),
      },
    }),
    options.principalAuthority,
    options.extraPiArgs ?? [],
  );
}

export function buildFixerResumeActivationExtraArgs(admitted: AdmittedFixerInvocation, options: Common): string[] {
  const ha = homeAgent(admitted);
  return buildPiTurnExtraArgs(
    buildFixerTurnRequest(admitted, {
      packageRoot: options.packageRoot,
      ...ha,
      ...(options.model ? { model: options.model } : {}),
      continuation: {
        kind: "resume",
        prompt: selectResumeContinuationPrompt(options.message),
      },
    }),
    options.principalAuthority,
    options.extraPiArgs ?? [],
  );
}

export function buildJudgeActivationExtraArgs(admitted: AdmittedJudgeInvocation, options: Common): string[] {
  const ha = homeAgent(admitted);
  return buildPiTurnExtraArgs(
    buildJudgeTurnRequest(admitted, {
      packageRoot: options.packageRoot,
      ...ha,
      ...(options.model ? { model: options.model } : {}),
      ...(options.engine ? { engine: options.engine } : {}),
      continuation: {
        kind: "initial",
        prompt: buildJudgeTransportPrompt(admitted, engineSessionMaterialFromOptions(options)),
      },
    }),
    options.principalAuthority,
    options.extraPiArgs ?? [],
  );
}

export function buildReviewerActivationExtraArgs(admitted: AdmittedReviewerInvocation, options: Common): string[] {
  const ha = homeAgent(admitted);
  return buildPiTurnExtraArgs(
    buildReviewerTurnRequest(admitted, {
      packageRoot: options.packageRoot,
      ...ha,
      ...(options.model ? { model: options.model } : {}),
      ...(options.engine ? { engine: options.engine } : {}),
      continuation: {
        kind: "initial",
        prompt: buildReviewerTransportPrompt(admitted, engineSessionMaterialFromOptions(options)),
      },
    }),
    options.principalAuthority,
    options.extraPiArgs ?? [],
  );
}

export function buildMergerActivationExtraArgs(admitted: AdmittedMergerInvocation, options: Common): string[] {
  const ha = homeAgent(admitted);
  return buildPiTurnExtraArgs(
    buildMergerTurnRequest(admitted, {
      packageRoot: options.packageRoot,
      ...ha,
      ...(options.model ? { model: options.model } : {}),
      ...(options.engine ? { engine: options.engine } : {}),
      continuation: {
        kind: "initial",
        prompt: buildMergerTransportPrompt(admitted, engineSessionMaterialFromOptions(options)),
      },
    }),
    options.principalAuthority,
    options.extraPiArgs ?? [],
  );
}

export function buildCollectorActivationExtraArgs(admitted: AdmittedCollectorInvocation, options: Common): string[] {
  const ha = homeAgent(admitted);
  return buildPiTurnExtraArgs(
    buildCollectorTurnRequest(admitted, {
      packageRoot: options.packageRoot,
      ...ha,
      ...(options.model ? { model: options.model } : {}),
      ...(options.engine ? { engine: options.engine } : {}),
      continuation: {
        kind: "initial",
        prompt: buildCollectorTransportPrompt(admitted, engineSessionMaterialFromOptions(options)),
      },
    }),
    options.principalAuthority,
    options.extraPiArgs ?? [],
  );
}

export function buildDoctorActivationExtraArgs(admitted: AdmittedDoctorInvocation, options: Common): string[] {
  const ha = homeAgent(admitted);
  return buildPiTurnExtraArgs(
    buildDoctorTurnRequest(admitted, {
      packageRoot: options.packageRoot,
      ...ha,
      ...(options.model ? { model: options.model } : {}),
      ...(options.engine ? { engine: options.engine } : {}),
      continuation: {
        kind: "initial",
        prompt: buildDoctorTransportPrompt(admitted, engineSessionMaterialFromOptions(options)),
      },
    }),
    options.principalAuthority,
    options.extraPiArgs ?? [],
  );
}

export function buildNotaryActivationExtraArgs(admitted: AdmittedNotaryInvocation, options: Common): string[] {
  const ha = homeAgent(admitted);
  return buildPiTurnExtraArgs(
    buildNotaryTurnRequest(admitted, {
      packageRoot: options.packageRoot,
      ...ha,
      ...(options.model ? { model: options.model } : {}),
      ...(options.engine ? { engine: options.engine } : {}),
      continuation: {
        kind: "initial",
        prompt: buildNotaryTransportPrompt(admitted, engineSessionMaterialFromOptions(options)),
      },
    }),
    options.principalAuthority,
    options.extraPiArgs ?? [],
  );
}


export function buildMergerResumeActivationExtraArgs(admitted: AdmittedMergerInvocation, options: Common): string[] {
  const ha = homeAgent(admitted);
  return buildPiTurnExtraArgs(
    buildMergerTurnRequest(admitted, {
      packageRoot: options.packageRoot,
      ...ha,
      ...(options.model ? { model: options.model } : {}),
      continuation: {
        kind: "resume",
        prompt: selectResumeContinuationPrompt(options.message),
      },
    }),
    options.principalAuthority,
    options.extraPiArgs ?? [],
  );
}

export function buildReviewerResumeActivationExtraArgs(admitted: AdmittedReviewerInvocation, options: Common): string[] {
  const ha = homeAgent(admitted);
  return buildPiTurnExtraArgs(
    buildReviewerTurnRequest(admitted, {
      packageRoot: options.packageRoot,
      ...ha,
      ...(options.model ? { model: options.model } : {}),
      continuation: {
        kind: "resume",
        prompt: selectResumeContinuationPrompt(options.message),
      },
    }),
    options.principalAuthority,
    options.extraPiArgs ?? [],
  );
}

export function buildJudgeResumeActivationExtraArgs(admitted: AdmittedJudgeInvocation, options: Common): string[] {
  const ha = homeAgent(admitted);
  return buildPiTurnExtraArgs(
    buildJudgeTurnRequest(admitted, {
      packageRoot: options.packageRoot,
      ...ha,
      ...(options.model ? { model: options.model } : {}),
      continuation: {
        kind: "resume",
        prompt: selectResumeContinuationPrompt(options.message),
      },
    }),
    options.principalAuthority,
    options.extraPiArgs ?? [],
  );
}
