# Approved apply packet

Revise and apply the plan at pinned HEAD `a7ec90af3c65a30bca4bab652a734b45b2fdb8d9` as follows:

1. Assert HEAD is still exactly the pinned SHA and the worktree is clean before editing.
2. In the owning `pi.registerFlag("ak-fixer-phase", ...)` registration in `src/role-runtime.ts`, expand the description so `plan` remains plan-only/no-edit/no-commit and `apply` explicitly means: execute the approved plan, verify, and commit when repaired. Do not add another description source, targetHead gate, runtime guard, or phase.
3. Add a focused regression test for the actual caller-facing contract. It must load the package entrypoint through Pi’s CLI/help path and assert the rendered `--ak-fixer-phase` help exposes both values and the apply duties to execute, verify, and commit when repaired. The current suite does not test help text, and it passes with the reproduced defect, so leaving tests unchanged is not approved.
4. Leave README and ADRs unchanged. `README.md:53` already states the required contract, and ADR 0004 defers targetHead binding.
5. Run `npm test` and `npm run typecheck`. Also verify checkout-local real help with an explicit package entrypoint, for example `./node_modules/.bin/pi --no-extensions -e ./extensions/role-runtime.ts --ak-role fixer --help`; require exit 0 and confirm the rendered flag entry contains the complete plan/apply meanings. The plan’s bare `pi --ak-role fixer --help` is not a reliable checkout verification here: at the pinned clean HEAD it exits 0 without loading this package or showing any `ak-*` flags.
6. Confirm the diff contains only the description root fix and its focused regression test. Create one forward commit without amend or history rewrite, then report the new commit SHA and verification results.


# Fixer receipt

```json
{
  "status": "completed",
  "report": "## Repair completed\n\n- Expanded the owning `ak-fixer-phase` flag description in `src/role-runtime.ts`: `plan` remains plan-only with no edits or commits; `apply` now explicitly requires executing the approved plan, verifying, and committing when repaired.\n- Added a focused package-entrypoint regression in `test/package-entrypoint.integration.test.ts` that invokes Pi’s CLI/help path with the explicit extension and asserts the rendered caller-facing contract.\n- Left README, ADRs, runtime behavior, phases, and targetHead handling unchanged.\n\n## Verification\n\n- Initial HEAD exactly matched `a7ec90af3c65a30bca4bab652a734b45b2fdb8d9`; worktree was clean.\n- `npm test`: passed (44 tests).\n- `npm run typecheck`: passed.\n- Checkout-local help command exited 0 and rendered the complete plan/apply meanings, including execute, verify, and commit when repaired.\n- Final commit contains only `src/role-runtime.ts` and `test/package-entrypoint.integration.test.ts`; worktree is clean.\n- New HEAD is a strict forward descendant of the pinned HEAD.",
  "commitSha": "2357b36608dc70b397212c3a046149cf9d325895"
}
```

# Mechanical Git evidence

HEAD: 2357b36608dc70b397212c3a046149cf9d325895
Parent: a7ec90af3c65a30bca4bab652a734b45b2fdb8d9
Subject: fix: expose complete fixer phase duties in CLI help


Status:
```
## feature/judge-role...origin/feature/judge-role [ahead 2]
```
