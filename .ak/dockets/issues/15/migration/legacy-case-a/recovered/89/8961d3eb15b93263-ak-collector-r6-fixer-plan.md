# Plan-Gate: R6 residual — literal-null tombstone only

**HEAD:** `d38dc1d` (clean). No edits in this phase.

## Behavior
Surface normalizers (`normalizeReview` / `normalizeIssueComment` / `normalizeReviewComment`) may tombstone `userLogin` **only** when the payload field is the literal JSON null `user: null`. Every other `user` shape must fail closed with `GitHub payload missing user.login` (same as pre-`c86c2a2` `userLoginOf` / `9cc03df`).

## Owner
`optionalUserLogin` in `src/collector-github.ts` (~188–193) — sole seam used by the three surface normalizers. No evidence/receipt/Soul/schema/R10 changes.

## Defect (confirmed on HEAD)
Current body:
```ts
if (raw === null || raw === undefined) return null;
if (!isRecord(raw) || typeof raw["login"] !== "string") return null;
```
Probe: `{user: absent}`, `{user: {id: 7}}`, `{user: {login: 5}}`, non-object `user` all normalize to `userLogin: null` on all three surfaces. Authorized R6 case is only literal `null`.

## Red
Add regressions in `test/collector-github.test.ts` (extend or sibling the existing R6 test) for **review, issue-comment, and review-comment**:
1. **Green keep:** `user: null` → `userLogin === null`; existing non-qualify / receipt rejection path stays.
2. **Reject:** user absent; `user: {id: 7}`; `user: {login: 5}` (and optionally non-object) → throw `/GitHub payload missing user\.login/`.

## Green
Tighten owner only:
```ts
function optionalUserLogin(raw: unknown): string | null {
  if (raw === null) return null;
  if (!isRecord(raw) || typeof raw["login"] !== "string") {
    throw new Error("GitHub payload missing user.login");
  }
  return raw["login"];
}
```
Reuse `requireUserLogin` throw message; do not widen types or add parallel helpers.

## Scope
- **In:** `src/collector-github.ts` (`optionalUserLogin` body + comment if needed); `test/collector-github.test.ts` R6 regressions only.
- **Out:** R10 budget, Soul, schema, evidence qualification logic, receipt, ledger, unrelated tests.
- **History note:** `c86c2a2` introduced the over-broad map-to-null; do not re-ship that family. Restore fail-closed for non-null while keeping the authorized literal-null tombstone.
- **Verify (apply):** targeted `collector-github` tests + typecheck; one forward commit, no amend.
