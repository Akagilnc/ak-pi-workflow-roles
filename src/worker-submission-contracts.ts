/**
 * Statuses that enter the worker officer submission gate (ADR 0066):
 * completed/partially_completed enter gate ①; planned/refused/unfinished do not.
 */
export const WORKER_DONE_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "partially_completed",
]);
