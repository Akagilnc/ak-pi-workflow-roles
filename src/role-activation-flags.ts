/**
 * Middle-layer role activation → host flag map (#819 / ADR 0082).
 * Sole envelope-assembly definition for activation flags across host families.
 * Host adapters only deliver these flags (ACP/headless getFlag map; pi argv pairs).
 */
import type { RoleTurnRequest } from "./host-contracts.ts";
import { packagedRoleInputFlag, packagedRolePhaseFlag } from "./packaged-role-registry.ts";

/** Project closed RoleTurnActivation onto the shared host flag map. */
export function projectActivationFlags(request: RoleTurnRequest): Map<string, boolean | string> {
  const activation = request.activation;
  const flags = new Map<string, boolean | string>([["ak-role", activation.role]]);
  if (request.stationChild === true) {
    flags.set("ak-station-child", true);
    flags.set("ak-omit-navigator", true);
  }
  const inputFlag = packagedRoleInputFlag(activation.role);
  const phaseFlag = packagedRolePhaseFlag(activation.role);
  if ("phase" in activation && phaseFlag !== undefined) flags.set(phaseFlag, activation.phase);
  if (inputFlag !== undefined) {
    const path = "taskPath" in activation ? activation.taskPath
      : "packetPath" in activation ? activation.packetPath
        : "casePath" in activation ? activation.casePath
          : "inputPath" in activation ? activation.inputPath
            : "sourceRun" in activation ? activation.sourceRun
              : undefined;
    if (path !== undefined) flags.set(inputFlag, path);
  }
  if (activation.role === "fixer" && activation.prerequisitesPath !== undefined) {
    flags.set("ak-fixer-prerequisites", activation.prerequisitesPath);
  }
  if (activation.role === "reviewer") {
    flags.set("ak-review-base", activation.baseRevision);
    flags.set("ak-review-authority-refs", JSON.stringify(activation.authorityRefs));
    if (activation.ticketNumber !== undefined) {
      flags.set("ak-review-ticket-number", String(activation.ticketNumber));
    }
  }
  // countersign ticketNumber stays on activation/admission/invocation only —
  // no private transport flag (inner-gate material path deleted in #632).
  if (activation.role === "notary" && activation.ticketNumber !== undefined) {
    flags.set("ak-notary-ticket-number", String(activation.ticketNumber));
  }
  if (activation.role === "gleaner-left") {
    flags.set("ak-gleaner-left-base", activation.baseRevision);
  }
  if (activation.role === "collector") {
    flags.set("ak-collector-repo", activation.repo);
    // #676 D1: pr optional at admission; omit flag when role binds from materials.
    if (activation.pr !== undefined) flags.set("ak-collector-pr", activation.pr);
    if (activation.requestManifestPath !== undefined) {
      flags.set("ak-collector-request-manifest", activation.requestManifestPath);
    }
    if (activation.waitMs !== undefined) flags.set("ak-collector-wait-ms", activation.waitMs);
  }
  return flags;
}
