# Issue 15 Case-A final child-seam closure review

Review fixed diff `eb6bb68903bced53d49d06dfce086cccb8ccde17..a9ef5e8a65229a8fe709b480109b88728c20d5bf` and resulting target. Later Receipt archival is closure evidence only.

Recheck the three prior findings only, plus regressions from the test-only change:

- dirty disposition, admitted report, and recovered derivative cases must derive real paths from committed dispositions, dirty isolated live bytes at fixed HEAD, execute the existing repair-003 child, and assert its exact nonzero drift gate/path;
- unresolved required path must be disposition-derived, committed deleted while reference remains, execute the child, and assert exact `required-tuple-unresolvable` path/commit rather than verifier-local Git failure;
- duplicated ineffective assertions must be gone; fixture must be isolated, reset between cases, cleaned in finally, and retain no probe/helper/production hook.

Confirm no child/result/manifest/migration/evidence bytes changed, forward-only history, typecheck and focused verifier green. Standards: `CLAUDE.md`. Case B/#16/#17 and generic/excluded payloads out.

Allowed: Git/tree/stat/JSON/SHA, test-owned isolated clone/worktree behavior, typecheck, focused verifier. No full npm test; do not inspect `.ak/work` or generic payloads.

Exactly one sibling-parallel Standards/Spec batch; preserve distinct findings; submit only through `ak_reviewer_output`.
