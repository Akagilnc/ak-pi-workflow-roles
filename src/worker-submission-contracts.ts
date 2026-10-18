/** Every status a worker (coder / fixer) receipt may carry. */
export const WORKER_STATUS_WORDS = [
  "planned", "completed", "refused", "partially_completed", "unfinished",
] as const;
export type WorkerStatusWord = (typeof WORKER_STATUS_WORDS)[number];

/**
 * Statuses that enter the worker officer submission gate (ADR 0066):
 * completed/partially_completed enter gate ①; planned/refused/unfinished do not.
 */
export const WORKER_DONE_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "partially_completed",
]);
