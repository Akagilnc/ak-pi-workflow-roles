## Repair plan

Pinned HEAD `2357b36608dc70b397212c3a046149cf9d325895` is confirmed, and the worktree is clean. History confirms the CLI wording/test came from `2357b36`, while ADR 0004 was later owner-ratified as deferred in `622094b`; `CONTEXT.md` retained the superseded present-tense glossary wording.

1. **Complete the owning CLI help contract**
   - In `src/role-runtime.ts`, change only the `ak-fixer-phase` description’s plan clause to the required `plan (inspect and propose a repair plan; no edits or commits)`.
   - Preserve the apply clause exactly: `apply (execute the approved plan, verify, and commit when repaired)`.

2. **Keep the packaged-CLI regression aligned**
   - In `test/package-entrypoint.integration.test.ts`, update the existing help-output regex to require the new plan wording while retaining its current package-entrypoint execution path and apply wording.

3. **Correct the glossary to match governing ADR 0004**
   - Replace only the `CONTEXT.md` Binding entry with wording that labels binding as a deferred/future concept, to be pulled by a real caller.
   - Explicitly state that the current package provides neither a `targetHead` binding input nor a fail-closed binding gate, so the glossary cannot be read as advertising current mechanical support.
   - Leave ADR 0004 itself unchanged; it already records the governing deferred decision.

4. **Verify and commit during apply**
   - Run the focused packaged help test: `node --import tsx --test --test-name-pattern="packaged CLI help exposes the complete fixer phase contract" test/package-entrypoint.integration.test.ts`.
   - Run the full required checks: `npm test` and `npm run typecheck`.
   - Inspect the final diff/status to ensure only the three authorized files changed, then create one new forward `fix:` commit without amending history and confirm the new HEAD strictly descends from the pinned HEAD.

No edits, tests, or commits were performed in this plan phase.
