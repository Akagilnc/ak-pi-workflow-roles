# Case-A CI portability disposition

PR #18 CI runs `30528768639` and `30528804129` failed because GitHub Actions checked out only the synthetic tip and the migration verifier attempted historical Git reads against unavailable ancestors. Eleven tests failed before or at fixed-target resolution. The CI host also cannot possess the sealed volatile 597/277 source universe used by the live-source proof.

Forward correction:

1. CI checkout uses `fetch-depth: 0`, so committed fixed-target/history checks remain executable.
2. Only the five tests that require the volatile live source universe are registered with an explicit skip when `AK_LEGACY_CASE_A_LIVE_SOURCE=0`; CI sets that value. The remaining fifteen committed-artifact/history tests still execute.
3. The ordinary local gate does not set the variable and continues to run all twenty tests when the sealed source universe is present.

Focused proof after correction:

- ordinary local mode: 20 passed, 0 skipped;
- CI-portable mode: 15 passed, 5 explicitly skipped;
- typecheck and `git diff --check` passed.

This does not weaken the already preserved live-source execution evidence or final construction judgment. It separates a one-time host-bound migration proof from portable committed-artifact CI checks; no migration/evidence bytes are changed.
