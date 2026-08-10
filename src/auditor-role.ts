/**
 * Auditor adapter over the shared in-process child helper.
 * Keeps role-facing exports only; lifecycle lives in evidence-child-executor.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";

import {
  AUDITOR_TURN_LIMIT,
  DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES,
  AuditorTurnLimitError,
  executeAuditorChild,
  type AuditorCompletion,
  type AuditorDecisionTool,
  type AuditorLastResponseFacts,
  type AuditorRoleOptions,
} from "./evidence-child-executor.ts";

export {
  AUDITOR_TURN_LIMIT,
  DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES,
  AuditorTurnLimitError,
};
export type {
  AuditorCompletion,
  AuditorDecisionTool,
  AuditorLastResponseFacts,
  AuditorRoleOptions,
};

export function runAuditorRole(
  options: AuditorRoleOptions,
): Promise<{ decision: unknown; response: AssistantMessage }> {
  return executeAuditorChild(options);
}
