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
 * Read the settlement-stamped shape candidate from a failure decisiveFacts payload.
 * Looks at root and secondaryEvidence only for the typed marker — no cause inference.
 */
export function retainedShapeUnreadableCandidate(decisiveFacts: unknown): unknown | undefined {
  if (!isRecord(decisiveFacts)) return undefined;
  if (decisiveFacts[SHAPE_UNREADABLE_KEY] === true && Object.hasOwn(decisiveFacts, "candidate")) {
    return decisiveFacts.candidate;
  }
  const secondary = isRecord(decisiveFacts.secondaryEvidence)
    ? decisiveFacts.secondaryEvidence
    : undefined;
  if (
    secondary !== undefined
    && secondary[SHAPE_UNREADABLE_KEY] === true
    && Object.hasOwn(secondary, "candidate")
  ) {
    return secondary.candidate;
  }
  return undefined;
}
