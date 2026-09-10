/** #836 删 8/A7.14: plain scope keys only — no hex encoding + decode instruction sentence. */
export function reviewerScopePrompt(
  scopeKeys: readonly string[] | undefined,
): string {
  if (scopeKeys === undefined) return "<review_scope>full</review_scope>";
  return `<review_scope_keys>${JSON.stringify(scopeKeys)}</review_scope_keys>`;
}
