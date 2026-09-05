/**
 * #675 deleted the institutional-resolution.json seat page.
 * This helper is retained as a no-op so older fixtures that still call it compile
 * while their callers migrate off the deleted path.
 */
export const INSTITUTIONAL_RESOLUTION_FILE = "institutional-resolution.json" as const;

export type SeatSelection = {
  readonly provider: string;
  readonly model: string;
  readonly thinking?: string;
};

export type InstitutionalResolutionPage = {
  readonly version: 1;
  readonly seats: Record<string, SeatSelection | undefined>;
};

export function seatSelection(
  provider: string,
  model: string,
  thinking?: string,
): SeatSelection {
  return {
    provider,
    model,
    ...(thinking === undefined ? {} : { thinking }),
  };
}

/** Parent model shape accepted by the seat-table fixtures. */
export type ParentModel = {
  provider: string;
  model?: string;
  id?: string;
  thinking?: string;
};

export function parentInheritedSeats(parentModel: ParentModel): InstitutionalResolutionPage["seats"] {
  const selection = seatSelection(
    parentModel.provider,
    (parentModel.model ?? parentModel.id ?? "") as string,
    parentModel.thinking,
  );
  return {
    gatekeeper: selection,
    inspector: selection,
    notary: selection,
    auditor: selection,
    evidenceChild: selection,
  };
}

/** No-op: institutional seat page deleted (#675). */
export async function writeInstitutionalSeatTable(
  _runDirectory: string,
  _seats: InstitutionalResolutionPage["seats"],
): Promise<void> {
  // intentionally empty
}
