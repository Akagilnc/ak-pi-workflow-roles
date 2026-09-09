/**
 * Bound diagnostic text: rolling tail only, not a dossier/transcript face.
 * One authority for host stderr retention (headless + ACP).
 */

/** Fixed cap for retained diagnostic tails. */
export const DIAGNOSTIC_TAIL_CAP = 16 * 1024;

const CLIP_MARK = "…[stderr clipped]\n";

/**
 * Retain at most DIAGNOSTIC_TAIL_CAP characters, keeping the newest bytes
 * when over budget. Clip mark is included inside the fixed cap.
 */
export function retainDiagnosticTail(text: string): string {
  if (text.length <= DIAGNOSTIC_TAIL_CAP) return text;
  return CLIP_MARK + text.slice(text.length - (DIAGNOSTIC_TAIL_CAP - CLIP_MARK.length));
}
