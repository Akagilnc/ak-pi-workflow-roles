import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  executeAuditorChild,
  type AuditorRoleOptions,
} from "./role-child-executor.ts";

export {
  AUDITOR_TURN_LIMIT,
  DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES,
  AuditorTurnLimitError,
} from "./role-child-executor.ts";
export type {
  AuditorCompletion,
  AuditorDecisionTool,
  AuditorLastResponseFacts,
  AuditorRoleOptions,
} from "./role-child-executor.ts";

export function runAuditorRole(options: AuditorRoleOptions): Promise<{ decision: unknown; response: AssistantMessage }> {
  return executeAuditorChild(options);
}
