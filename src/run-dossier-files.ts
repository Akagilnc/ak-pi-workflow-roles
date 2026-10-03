/**
 * Names in a run directory (docs/dossier-topology.md, #1161). Constants only, so
 * the appender and the `current.json` renderer can both import them.
 */
export const RUN_CURRENT_FILE = "current.json" as const;
export const RUN_HISTORY_FILE = "history.jsonl" as const;
export const RUN_LOG_FILE = "log.jsonl" as const;
export const RUN_STATE_FILE = "state.jsonl" as const;

/**
 * Record kinds that make a leg's history: they land in `history.jsonl`. The
 * original submission ledger and attempt history, the prompt/schema each turn was
 * started with, and officer pointers.
 */
export const RUN_HISTORY_KINDS: ReadonlySet<string> = new Set([
  "candidate", "roundContext", "outcome", "sealed", "post-seal-anomaly",
  "attempt-history", "turn-delivery", "officer-pointer",
]);

/**
 * The facts a run cannot go on without land in `state.jsonl`: the four whole pages only the
 * public call knows, and the native session id a host binds (a resume needs it). A
 * different volume than the submission ledger and than the auxiliary stream, as the
 * files they replaced were (a page write failure throws; a ledger volume that cannot
 * be written does not stop a resume; a stream line that cannot be written is noted).
 * Every other kind lands in `log.jsonl`.
 */
export const RUN_STATE_KINDS: ReadonlySet<string> = new Set([
  "invocation", "admitted-request", "run-state", "terminal", "host-session-id",
]);
