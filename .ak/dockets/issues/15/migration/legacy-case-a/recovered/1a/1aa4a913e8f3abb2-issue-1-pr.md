Closes #1.

## Summary

- complete the remaining Fixer-only literal bash seatbelt from ADR 0008
- block exactly `rm -rf`, `git reset --hard`, `git clean`, and `git checkout --` in both Fixer phases
- prove ordinary block/no execution/continued session and harmless controls through existing packaged real-Pi integration
- document the accidental-destruction seatbelt and non-security boundary
- accept ADRs 0001–0003 and 0005–0009 while retaining ADR 0004 as deferred
- align ADR 0001 historical roster and ADR 0003/0010 supersession wording

## Preserved

No targetHead binding, Soul/schema changes, generic command classifier, confirmation UI, routing/orchestration, paid model CI, or cross-role policy.

## Verification

- issue-only Authority Judge converged
- Sol-low Plan Judge converged first pass
- Coder Apply + forward Fixer closure
- final exact-head canonical Reviewer: Standards 0, Spec 0
- final Judge converged at `fa1fd3f`
- `npm test` — 259/259
- `npm run typecheck`
- `git diff --check`
