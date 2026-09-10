/**
 * Diagnostic text retention — full process output, no clip (#836).
 * One authority for host stderr retention (headless + ACP + pi).
 * stderr is also written whole to stderr.log by post-admission.
 */

/** @deprecated #836: no clip; kept as Infinity so callers comparing length stay open. */
export const DIAGNOSTIC_TAIL_CAP = Number.POSITIVE_INFINITY;

/**
 * Retain the full diagnostic text. Clip/tail was deleted under #836
 * (陛下「stderr这种不是错误信息应该完整保存错误文件吗。不准乱裁」).
 */
export function retainDiagnosticTail(text: string): string {
  return text;
}
