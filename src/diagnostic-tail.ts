/**
 * Bound diagnostic text: rolling tail only, not a dossier/transcript face.
 * One authority for host stderr retention (headless + ACP).
 */

/** Default cap for retained diagnostic tails (bytes/chars). */
export const DIAGNOSTIC_TAIL_CAP = 16 * 1024;

const CLIP_MARK = "…[stderr clipped]\n";

/**
 * Retain at most `cap` characters, keeping the newest bytes when over budget.
 * Clip mark is included inside the cap so the result never exceeds `cap`.
 */
export function retainDiagnosticTail(
  text: string,
  cap: number = DIAGNOSTIC_TAIL_CAP,
): string {
  if (text.length <= cap) return text;
  const keep = Math.max(0, cap - CLIP_MARK.length);
  return CLIP_MARK + text.slice(text.length - keep);
}
