/**
 * Names in a run directory (docs/dossier-topology.md, #1161). Constants only, so
 * the appender and the `current.json` renderer can both import them.
 */
export const RUN_CURRENT_FILE = "current.json" as const;
export const RUN_HISTORY_FILE = "history.jsonl" as const;
export const RUN_LOG_FILE = "log.jsonl" as const;

/**
 * Record kinds that make a leg's history: they land in `history.jsonl`, every
 * other kind of a run lands in `log.jsonl`. The original submission ledger and
 * attempt history, the prompt/schema each turn was started with, officer
 * pointers, and the four whole-page facts only the public call knows (each
 * rewrite appends one row whose payload is that whole page).
 */
export const RUN_HISTORY_KINDS: ReadonlySet<string> = new Set([
  "candidate", "roundContext", "outcome", "sealed", "post-seal-anomaly",
  "attempt-history", "turn-delivery", "officer-pointer",
  "invocation", "admitted-request", "run-state", "terminal",
]);
