/**
 * Names in a run directory (docs/dossier-topology.md). Constants only, so the
 * appender and the dossier readers can both import them.
 */
/** The one ledger the package writes in a leg: every record kind appends here (#1300). */
export const RUN_STATE_FILE = "state.jsonl" as const;

/** Record kind of a ticket progress row carried to settlement (#1201). */
export const PROGRESS_RECORD_KIND = "progress" as const;

/** Record kind of a booked officer pointer. */
export const OFFICER_POINTER_RECORD_KIND = "officer-pointer" as const;
