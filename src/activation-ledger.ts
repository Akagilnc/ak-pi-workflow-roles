/**
 * Activation ledger surface: durable session principal + book/home topology.
 * #855: two-face waiting.jsonl reconciliation deleted — this module no longer
 * appends accepted-activation facts or own a waiting path.
 */
export {
  ActivationGitRepositoryRequiredError,
  resolveBookKeyFromGit,
} from "./activation-ledger-git.ts";
export {
  ActivationSessionFileMissingError,
  durableSessionPointer,
  type ActivationSessionManager,
  type ActivationSessionPointer,
} from "./activation-ledger-session.ts";
export {
  ActivationLedgerError,
  activationBookDirectory,
  resolveActivationLedgerHome,
} from "./activation-ledger-topology.ts";
