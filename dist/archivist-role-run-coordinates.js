import { join } from "node:path";
import { resolveBookKeyFromGit } from "./activation-ledger-git.js";
import {
  activationBookDirectory,
  resolveActivationLedgerHome
} from "./activation-ledger-topology.js";
function roleRunSessionCoordinates(options) {
  const ledgerHome = resolveActivationLedgerHome(
    options.home === void 0 ? void 0 : () => options.home
  );
  const bookKey = resolveBookKeyFromGit(options.cwd);
  const runDirectory = join(
    activationBookDirectory(ledgerHome, bookKey),
    "runs",
    `${options.runId}@${options.role}`
  );
  const sessionDirectory = join(runDirectory, "session");
  return {
    ledgerHome,
    bookKey,
    runDirectory,
    sessionDirectory,
    sessionFile: join(sessionDirectory, "session.jsonl")
  };
}
export {
  roleRunSessionCoordinates
};
