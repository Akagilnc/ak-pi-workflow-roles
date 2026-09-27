/** Package-owned Collector receipt leaf — no role registration surface. */

export const COLLECTOR_OUTPUT_TOOL = "ak_collector_output";

/**
 * One identity group on the LLM-submitted receipt.
 * #1088: code no longer builds ledger projections; the model submits groups.
 */
export type CollectorIdentityGroup = {
  identity: Record<string, unknown> | null;
  displayLogin?: string;
  attendance?: true;
  materials?: Array<Record<string, unknown>>;
  findings?: Array<Record<string, unknown>>;
};

/**
 * Collector receipt as submitted. Presence of `groups` is the terminal
 * discriminator for settlement/analyst (#836: original object is the receipt).
 */
export type CollectorReceipt = {
  groups: CollectorIdentityGroup[] | ReadonlyArray<Record<string, unknown>>;
  unfinishedReasons?: unknown;
  host?: string;
  repository?: string;
  prNumber?: number;
  prState?: string;
  manifestDigest?: string;
};
