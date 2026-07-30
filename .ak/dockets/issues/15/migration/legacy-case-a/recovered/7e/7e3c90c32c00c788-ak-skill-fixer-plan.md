## Findings confirmed

- `src/canonical-skill-binding.ts` snapshots `realpath(configuredPath)` and then accepts only that spelling for `parsed.location` and its preamble. Pi 0.82.1 instead retains a configured symlink’s pathname in `Skill.filePath`/`baseDir` and serializes both into the native block.
- Pi’s `parseSkillBlock` returns `userMessage: undefined` for a bare expansion. The binding currently compares that directly with runtime’s empty-string request.
- A real-Pi probe reproduced both serialization details: bare `/skill:tdd` emitted the configured symlink location and configured directory preamble, with `userMessage === undefined`. Existing canonical and package lifecycle tests pass because they cover only a resolved regular path with a nonempty argument.
- The defect was introduced by `7bace16`; the prior reviewer-specific implementation used the same realpath-only comparison. No different failed repair family appears in relevant history. Worktree remains clean at `7bace1674eeadcfc582cea4ba28c3f6b3086791e`.

## Minimal repair plan

1. **`src/canonical-skill-binding.ts` only**
   - Keep the existing realpath snapshot and body snapshot unchanged.
   - Keep `configuredPath` private in the binding closure. During capture, accept `parsed.location` only when it exactly equals either `configuredPath` or `snapshot.path`; derive `References are relative to ...` with `dirname()` of that matched spelling.
   - Continue requiring the exact Skill name, complete stripped snapshot body, matching preamble, and exact request; reject all other pathname spellings.
   - Normalize only Pi’s omitted argument at this seam via `parsed.userMessage ?? ""`, compare that string to `originalRequest`, and build a new frozen evidence object whose `userMessage` is the normalized string. Do not alter public types or add provenance state.

2. **`test/canonical-skill-binding.test.ts` characterization**
   - Extend the existing symlink fixture to prove both native pathname forms independently: configured symlink path/configured baseDir and resolved target path/target baseDir.
   - Add direct argument-free capture coverage proving Pi’s omitted `userMessage` maps to evidence `userMessage: ""`.
   - Retain and apply the existing fail-closed cases for alternate location, wrong name, partial/wrong body or preamble, surrounding prose, and wrong request, including mismatched location/baseDir combinations.

3. **`test/package-entrypoint.integration.test.ts` real-Pi lifecycle**
   - Convert the existing packaged Coder apply test to install the configured `tdd` Skill as a symlink to an owned target while passing the configured path to Pi.
   - Prompt with exactly bare, pre-prefixed `/skill:tdd`. Assert the provider receives one native block—not a doubled command—with the configured symlink location/baseDir and `parseSkillBlock(...).userMessage === undefined`.
   - Keep the completion assertion, proving the immediately following argument-free expansion authorizes Coder `completed` through the existing runtime seam.

No Souls, `src/role-runtime.ts`, public contracts, orchestration, README, or wave-3 work will change.

## Apply-phase verification

1. Run the two focused test files for red/green evidence.
2. Run `npm run typecheck`.
3. Run the full suite with an initially empty temporary HOME: `HOME="$empty_home" npm test`, then remove it.
4. Run `npm pack --dry-run` and `git diff --check`.
5. Confirm only the three authorized files changed, create one new `fix:` forward commit, then verify a clean worktree, new HEAD differs from and descends from `7bace1674eeadcfc582cea4ba28c3f6b3086791e`, and exactly one commit was added.
