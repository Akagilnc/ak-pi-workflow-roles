/**
 * #178 test support: package startup candidates are gone, so dispatch fixtures
 * must supply a caller seat table the same way production does (persistent seats).
 * Temp-home only — never writes the real machine seat file.
 */
import {
  PUBLIC_CONFIGURABLE_SEATS,
  type PublicConfigurableSeat,
} from "../../src/public-cli/registry.ts";
import {
  savePublicCliConfig,
  type PersistentSeatConfig,
  type PublicCliConfig,
} from "../../src/public-cli/config.ts";

/**
 * Default caller model used by public-cli dispatch fixtures after #178.
 * Not openai-codex/xai — those two hit the credential fail-closed seam when a
 * temp home has empty auth.json; unknown providers pass through.
 */
export const TEST_CALLER_SEAT_MODEL = {
  provider: "test",
  model: "caller-seat",
  thinking: "high",
} as const satisfies PersistentSeatConfig;

export function callerSeatTable(
  model: PersistentSeatConfig = TEST_CALLER_SEAT_MODEL,
): PublicCliConfig {
  const seats = {} as Record<PublicConfigurableSeat, PersistentSeatConfig>;
  for (const seat of PUBLIC_CONFIGURABLE_SEATS) {
    seats[seat] = { ...model };
  }
  return { seats };
}

export async function seedCallerSeatTable(
  home: string,
  model: PersistentSeatConfig = TEST_CALLER_SEAT_MODEL,
): Promise<void> {
  await savePublicCliConfig(callerSeatTable(model), home);
}
