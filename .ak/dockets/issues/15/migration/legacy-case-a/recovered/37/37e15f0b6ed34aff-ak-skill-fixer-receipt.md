# Fixer receipt

```json
{
  "status": "completed",
  "report": "## Repair completed\n\n- Updated `src/canonical-skill-binding.ts` to accept only the configured Skill pathname or its snapshotted realpath, with the preamble derived from the matched spelling.\n- Normalized Pi's omitted bare-command argument to `\"\"` at capture and returned frozen detached evidence with that normalized value.\n- Added direct symlink/configured-path, resolved-target, bare-command, mixed path/baseDir rejection, and existing fail-closed coverage in `test/canonical-skill-binding.test.ts`.\n- Updated `test/package-entrypoint.integration.test.ts` to exercise real Pi with a configured symlink and exact `/skill:tdd`, proving one undoubled native block with `userMessage === undefined` authorizes Coder `completed`.\n- No Souls, runtime policy, public contracts, orchestration, README, or wave-3 files changed.\n\n## Verification\n\n- Focused red: new regressions failed against the old binding (2 failures: configured symlink and bare lifecycle).\n- Focused green: 8/8 passed.\n- `npm run typecheck`: passed.\n- Initially-empty-HOME full suite: 92/92 passed; temporary HOME removed.\n- `npm pack --dry-run`: passed.\n- `git diff --check`: passed.\n- Commit scope: exactly the three authorized files.\n- Worktree: clean.\n- Ancestry: new HEAD is one strict forward commit after `7bace1674eeadcfc582cea4ba28c3f6b3086791e`.\n\n## Commit\n\n`05413b2e14b956e079eeb0bc20a1595fb562b3f6` — `fix: accept native canonical skill spellings`",
  "commitSha": "05413b2e14b956e079eeb0bc20a1595fb562b3f6"
}
```
