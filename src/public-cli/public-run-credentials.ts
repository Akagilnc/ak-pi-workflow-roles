/**
 * Shared public-run credential seam: one owner for missing selected-provider
 * detection, typed failure construction, and post-run credential annotation.
 * Role runners supply model/credential facts only. #987 deleted the pre-dispatch
 * local auth checker; host attempt + this settlement annotate remain.
 */
import {
  missingPublicProviderCredential,
  type CredentialProviders,
  type SeatModelConfig,
} from "./config.ts";
import type { RoleTurnKnownFailure } from "../host-contracts.ts";

/**
 * Production-owned provider failure when the selected public seat provider has
 * no configured credential. Cause/identity come from CredentialProviders, not
 * stderr wording. Runner-supplied knownFailure still wins over this annotation.
 */
export function knownFailureForMissingProviderCredential(
  model: SeatModelConfig | undefined,
  credentials: CredentialProviders | undefined,
): RoleTurnKnownFailure | undefined {
  if (model === undefined || credentials === undefined) return undefined;
  // Only the public credential catalog is annotated here; offline/test providers
  // are not represented in auth.json shape and must not be washed into MissingProviderCredential.
  if (model.provider !== "openai-codex" && model.provider !== "xai") return undefined;
  if (!missingPublicProviderCredential(model.provider, credentials)) {
    return undefined;
  }
  return {
    cause: "provider",
    identity: {
      name: "MissingProviderCredential",
      code: model.provider,
    },
  };
}

/**
 * Post-run credential annotation for the shared evidence-priority chain.
 * Only annotates nonzero/timeout exits; never invents a credential failure on success.
 */
export function postRunMissingCredentialFailure(
  result: Readonly<{ timedOut: boolean; code: number | null }>,
  model: SeatModelConfig | undefined,
  credentials: CredentialProviders | undefined,
): RoleTurnKnownFailure | undefined {
  if (!(result.timedOut || result.code !== 0)) return undefined;
  return knownFailureForMissingProviderCredential(model, credentials);
}
