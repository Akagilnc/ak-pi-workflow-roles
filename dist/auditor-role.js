import { AUDITOR_TURN_LIMIT, DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES, AuditorTurnLimitError, executeAuditorChild, } from "./evidence-child-executor.js";
export { AUDITOR_TURN_LIMIT, DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES, AuditorTurnLimitError, };
export function runAuditorRole(options) {
    return executeAuditorChild(options);
}
