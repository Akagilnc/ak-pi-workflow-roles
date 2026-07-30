## Minimal deletion plan

1. In `src/worker-role.ts`, delete only the third `createFixerRoleRuntime` parameter, `_hostActions: WorkerRoleHostActions`, leaving the two-argument factory and all Fixer behavior unchanged.
2. In `src/role-runtime.ts`, delete only the trailing `hostActions` argument from the Fixer factory composition call. Keep the shared `hostActions` object and its Judge, Coder, and Reviewer arguments intact.
3. In `test/judge-role.test.ts`, delete only the trailing `{ failInfrastructure(error) { throw error; } }` fixture argument from the direct Fixer factory call. Do not add or alter tests.
4. Confirm the diff contains only those three deletions and that `WorkerRoleHostActions` remains defined and used by Coder. Run `npm run typecheck`, `npm test`, and `git diff --check`.
5. In apply phase only, create one new forward commit after successful verification; do not amend existing history.

## Evidence

- The worktree is clean at `d8bfe1f` on `feature/deepen-role-runtime`.
- `d8bfe1f` introduced the extracted Fixer factory with the unused underscore-prefixed parameter and both corresponding arguments.
- Repository-wide search found exactly two Fixer call sites: the composition call and the direct test call named above.
- `WorkerRoleHostActions` is live in `createCoderRoleRuntime`; host actions are also independently live in Judge and Reviewer runtimes, so none of those definitions or uses should be removed.
- No repository issue/authority pointer files were present; the supplied fix packet defines the authorized scope.

No files or Git history were modified during planning.
