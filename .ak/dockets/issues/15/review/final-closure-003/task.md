# Issue 15 Case-A final immutable-input closure review

Review fixed diff `c71b947dff2c8103f5a48411b4e82ef54ad9b2cf..eb6bb68903bced53d49d06dfce086cccb8ccde17` and resulting target. Later Fixer Receipt archival is closure evidence only.

Recheck the full fixed-target Case-A claim only where repair-006 can affect it, with special focus on the two sustained prior findings:

1. execution must capture one commit, load dispositions immutably, require/verify every admitted reference/report/recovered derivative tuple before use, reject worktree drift before it affects selection/scanning, and compare generated scan output against immutable derivative/report bytes;
2. required-tuple derivation in child and sole verifier must fail closed on every unresolved required path, never catch-and-omit/shrink denominator, and same-seam counterexamples must prove dirty bytes and unresolved path rejection.

Also verify final evidence remains 597/0/0, 277 scans/external seals, 2 redactions, 7 references, complete tuple/count equality, historical/repair-002 seals, no association/migration output churn, no generic/session payload, no raw-source duplication, and forward-only history.

Standards: `CLAUDE.md`; durable Recorder evidence is not disposed scratch. No Soul change expected.

Allowed: PI_* metadata, Git/tree/stat/JSON/SHA, current `/tmp` names/lstat, admitted non-generic source bytes required for proof, target non-generic bytes, typecheck, focused migration verifier. No full npm test. Do not inspect `.ak/work` or excluded/generic payloads. Case B/#16/#17 out.

Exactly one sibling-parallel Standards/Spec batch; preserve distinct findings; submit only through `ak_reviewer_output`.
