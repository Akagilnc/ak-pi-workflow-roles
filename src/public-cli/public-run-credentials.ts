/**
 * Shared public-run credential seam: one owner for missing selected-provider
 * detection, typed failure construction, pre-dispatch fail-closed payload, and
 * post-run credential annotation. Role runners supply model/credential facts only.
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
  // Only the public credential catalog is fail-closed here; offline/test providers
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

/** Pre-dispatch fail-closed payload when selected public provider lacks credentials. */
export type MissingCredentialPreDispatchFailure = Readonly<{
  timedOut: false;
  code: 1;
  stderr: string;
  knownFailure: RoleTurnKnownFailure;
}>;

export function missingCredentialPreDispatchFailure(
  model: SeatModelConfig | undefined,
  credentials: CredentialProviders | undefined,
): MissingCredentialPreDispatchFailure | undefined {
  const knownFailure = knownFailureForMissingProviderCredential(model, credentials);
  if (knownFailure === undefined) return undefined;
  return {
    timedOut: false,
    code: 1,
    stderr: `Missing credential for provider ${String(knownFailure.identity?.code ?? "unknown")}`,
    knownFailure,
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
