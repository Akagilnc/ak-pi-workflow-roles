/**
 * Single authoritative shape-unreadable marker (#675 / ADR 0055).
 * Settlement stamps it; consumers only read it — never re-derive from cause=output.
 */

export const SHAPE_UNREADABLE_KEY = "shapeUnreadable" as const;

export type ShapeUnreadableStamp = {
  readonly [SHAPE_UNREADABLE_KEY]: true;
  readonly candidate: unknown;
  readonly acceptedReceipt: false;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Settlement seat path: stamp retained candidate as shape-unreadable (not infrastructure). */
export function stampShapeUnreadableDetails(candidate: unknown): ShapeUnreadableStamp {
  return {
    [SHAPE_UNREADABLE_KEY]: true,
    candidate,
    acceptedReceipt: false,
  };
}

/**
 * Marker presence, decided independently of the candidate value: a stamped
 * `undefined` candidate is a shape-unreadable decision, not an absent marker.
 */
export type RetainedShapeUnreadable = { readonly candidate: unknown };

/**
 * Read the settlement-stamped shape candidate from a failure decisiveFacts payload.
 * Looks at root and secondaryEvidence only for the typed marker — no cause inference.
 */
export function retainedShapeUnreadable(decisiveFacts: unknown): RetainedShapeUnreadable | undefined {
  if (!isRecord(decisiveFacts)) return undefined;
  if (decisiveFacts[SHAPE_UNREADABLE_KEY] === true) {
    return { candidate: decisiveFacts.candidate };
  }
  const secondary = isRecord(decisiveFacts.secondaryEvidence)
    ? decisiveFacts.secondaryEvidence
    : undefined;
  if (secondary !== undefined && secondary[SHAPE_UNREADABLE_KEY] === true) {
    return { candidate: secondary.candidate };
  }
  return undefined;
}
