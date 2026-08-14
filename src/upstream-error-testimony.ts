/**
 * Single authority for upstream-error testimony (#307).
 * Non-2xx HTTP or non-empty SDK diagnostics = upstream testimony.
 * body/code/errno project only from a confirmed-remote node.
 * Seams keep their own shape/cause-chain reading and wrap via these primitives.
 */

/** True when value is a numeric HTTP status outside 2xx. */
export function isNonSuccessHttpStatus(status: unknown): status is number {
  return typeof status === "number" && (status < 200 || status >= 300);
}

/**
 * Upstream testimony is a directly observed HTTP response or SDK-structured
 * remote error. Pi stopReason, selected provider/model names, silent stream
 * death, errorMessage prose (e.g. "500: …"), and locally synthesized errors
 * are not testimony.
 */
export function hasUpstreamErrorTestimony(input: {
  readonly httpStatus?: number;
  readonly diagnostics?: unknown;
}): boolean {
  if (isNonSuccessHttpStatus(input.httpStatus)) return true;
  return Array.isArray(input.diagnostics) && input.diagnostics.length > 0;
}

/**
 * Project body/code/errno only when the caller already confirmed remote testimony
 * on the same node. Plain local Error.code is never provider testimony.
 */
export function projectConfirmedRemotePayload(input: {
  readonly body?: unknown;
  readonly code?: unknown;
  readonly errno?: unknown;
}): {
  readonly body?: unknown;
  readonly code?: unknown;
  readonly errno?: unknown;
} {
  return {
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.code === undefined ? {} : { code: input.code }),
    ...(input.errno === undefined ? {} : { errno: input.errno }),
  };
}
