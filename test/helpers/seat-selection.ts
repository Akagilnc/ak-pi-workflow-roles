/**
 * Test seat selection literals (data only). Not an institutional path (#675).
 */
export type SeatSelection = {
  readonly provider: string;
  readonly model: string;
  readonly thinking?: string;
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

export type ParentModel = {
  provider: string;
  model?: string;
  id?: string;
  thinking?: string;
};

export function parentInheritedSeats(parentModel: ParentModel): Record<string, SeatSelection | undefined> {
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
