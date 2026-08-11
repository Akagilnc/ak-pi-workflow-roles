import { executeAuditorChild, } from "./role-child-executor.js";
export { AUDITOR_TURN_LIMIT, DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES, AuditorTurnLimitError, } from "./role-child-executor.js";
export function runAuditorRole(options) {
    return executeAuditorChild(options);
}
