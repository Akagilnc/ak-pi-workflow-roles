## Repair plan

1. In `src/role-runtime.ts`, update only the owning `pi.registerFlag("ak-fixer-phase", ...)` description so the apply phase reads that it executes the approved plan, verifies, and commits when repaired. Do not add a second description source, guard, or runtime mechanism.
2. Leave the existing README, ADRs, phase behavior, and tests unchanged: `README.md` already states the required contract, and the defect is limited to caller-facing CLI wording.
3. Verify the repaired tree with:
   - `npm test`
   - `npm run typecheck`
   - `pi --ak-role fixer --help`, confirming the rendered `--ak-fixer-phase` entry includes execute, verify, and commit-when-repaired duties.
4. Confirm the worktree contains only this authorized wording change, then create one new forward commit (no amend/history rewrite), e.g. `fix: disclose fixer apply obligations in CLI help`.

## Investigation evidence

- HEAD is the pinned `a7ec90af3c65a30bca4bab652a734b45b2fdb8d9`; the worktree is clean.
- `622094b` is an ancestor of HEAD, and `docs/adr/0004-targethead-binding-check.md` defers the targetHead gate, so no targetHead work is planned.
- `src/role-runtime.ts:240-243` owns the flag registration and currently ends apply help at `execute the approved plan`.
- `README.md:53` already gives the intended wording: `Execute the approved plan, verify, and commit when repaired`.
- File history shows this incomplete description originated in `18c57b0`; later changes did not introduce an alternate help seam. Loading the package extension renders that exact incomplete source text, confirming the minimal root fix.
