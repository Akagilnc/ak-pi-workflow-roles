/**
 * Project native session assistant stops onto the host-contract knownFailure shape.
 */
import type { RoleTurnKnownFailure } from "../host-contracts.ts";
import {
  hasUpstreamErrorTestimony,
  projectConfirmedRemotePayload,
} from "../upstream-error-testimony.ts";

export { hasUpstreamErrorTestimony } from "../upstream-error-testimony.ts";

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function sessionStopDetails(input: {
  readonly errorMessage?: string | null;
  readonly provider?: string;
  readonly model?: string;
  readonly api?: string;
  readonly rawStopReason?: string;
  readonly httpStatus?: number;
  readonly diagnostics?: unknown;
  readonly body?: unknown;
  readonly code?: unknown;
  readonly errno?: unknown;
}): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  const errorMessage = nonEmptyString(input.errorMessage);
  if (errorMessage !== undefined) details.errorMessage = errorMessage;
  const api = nonEmptyString(input.api);
  if (api !== undefined) details.api = api;
  const rawStopReason = nonEmptyString(input.rawStopReason);
  if (rawStopReason !== undefined) details.rawStopReason = rawStopReason;
  const testimony = hasUpstreamErrorTestimony(input);
  if (testimony) {
    const provider = nonEmptyString(input.provider);
    if (provider !== undefined) details.provider = provider;
    const model = nonEmptyString(input.model);
    if (model !== undefined) details.model = model;
  }
  if (typeof input.httpStatus === "number") details.httpStatus = input.httpStatus;
  if (input.diagnostics !== undefined) details.diagnostics = input.diagnostics;
  // SDK structured payload fields: project only when held on a confirmed-remote node.
  if (testimony) Object.assign(details, projectConfirmedRemotePayload(input));
  return details;
}

/**
 * Project a native session assistant stop onto the existing knownFailure chain.
 * Classification follows two-way testimony: typed HTTP status or SDK structure
 * keeps provider; stopReason, configured provider/model, or errorMessage prose
 * alone is the existing unrecognized value. Present upstream payload is preserved
 * in details without rewriting; missing fields are omitted.
 */
export function knownFailureFromProviderStop(input: {
  readonly stopReason?: string;
  readonly errorMessage?: string | null;
  readonly provider?: string;
  readonly model?: string;
  readonly api?: string;
  readonly rawStopReason?: string;
  readonly httpStatus?: number;
  readonly diagnostics?: unknown;
  readonly body?: unknown;
  readonly code?: unknown;
  readonly errno?: unknown;
}): RoleTurnKnownFailure | undefined {
  if (input.stopReason !== "error" && input.stopReason !== "aborted") return undefined;
  const diagnostic = nonEmptyString(input.errorMessage);
  const details = sessionStopDetails(input);
  return {
    cause: hasUpstreamErrorTestimony(input) ? "provider" : "unrecognized",
    ...(diagnostic === undefined ? {} : { diagnostic }),
    ...(Object.keys(details).length === 0 ? {} : { details }),
  };
}
