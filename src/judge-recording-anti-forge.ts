import { sha256Hex } from "./sha256.ts";

/**
 * On-demand anti-forge for judge recordings.
 *
 * Standing CI must not byte-pin soul free text. Call these only when a
 * concrete recording is being consumed as evidence and must be checked
 * against the soul body supplied at that moment (current or packaged).
 */

export function soulTextDigest(soulText: string): string {
  return sha256Hex(soulText);
}

export function assertRecordingSoulDigest(options: {
  claimedDigest: unknown;
  soulText: string;
  label: string;
}): void {
  if (typeof options.claimedDigest !== "string") {
    throw new Error(`${options.label} metadata soulDigest must be a string`);
  }
  const actual = soulTextDigest(options.soulText);
  if (actual !== options.claimedDigest) {
    throw new Error(
      `${options.label} metadata soulDigest must match the soul supplied at consumption`,
    );
  }
}

/**
 * Construct-at-consumption check: resolve the packaged soul via the injected
 * reader, then verify meta.soulDigest. Reader is injected so callers control
 * git/fs access and tests stay synthetic.
 */
export function assertPackagedSoulMatchesMeta(
  meta: Record<string, unknown>,
  label: string,
  readPackagedSoul: (packageSha: string, label: string) => string,
): void {
  if (typeof meta.packageSha !== "string") {
    throw new Error(`${label} metadata packageSha must be a string`);
  }
  if (typeof meta.soulDigest !== "string") {
    throw new Error(`${label} metadata soulDigest must be a string`);
  }
  const packagedSoul = readPackagedSoul(meta.packageSha, label);
  assertRecordingSoulDigest({
    claimedDigest: meta.soulDigest,
    soulText: packagedSoul,
    label,
  });
}
