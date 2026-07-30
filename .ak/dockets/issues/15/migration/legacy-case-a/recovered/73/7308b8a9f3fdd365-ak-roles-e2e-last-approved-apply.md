Approved apply packet for pinned clean HEAD `2357b36608dc70b397212c3a046149cf9d325895`.

1. In `src/role-runtime.ts`, change only the `--ak-fixer-phase` help description’s plan clause so the full description reads: `Fixer phase: plan (inspect and propose a repair plan; no edits or commits) or apply (execute the approved plan, verify, and commit when repaired)`.
2. In `test/package-entrypoint.integration.test.ts`, update the existing packaged-CLI help regex to require that exact plan wording. Preserve the real package-entrypoint execution path and the apply wording.
3. In `CONTEXT.md`, replace only the `绑定(Binding)` glossary entry with deferred/future wording consistent with ADR 0004. It must explicitly say that binding awaits a real caller and that the current package provides neither a `targetHead` binding input nor a corresponding fail-closed binding gate. Do not alter ADR 0004 or add any binding mechanism.
4. Run:
   - `node --import tsx --test --test-name-pattern="packaged CLI help exposes the complete fixer phase contract" test/package-entrypoint.integration.test.ts`
   - `npm test`
   - `npm run typecheck`
5. Confirm the final diff changes only `src/role-runtime.ts`, `test/package-entrypoint.integration.test.ts`, and `CONTEXT.md`. Create one new forward `fix:` commit without amend/rewrite, then verify `git merge-base --is-ancestor 2357b36608dc70b397212c3a046149cf9d325895 HEAD` succeeds and report the resulting commit SHA.

Judge verification at the pinned HEAD found the worktree clean and the focused test, full suite (44 tests), and typecheck passing before these edits; those baseline passes do not cure the two authority mismatches above.
