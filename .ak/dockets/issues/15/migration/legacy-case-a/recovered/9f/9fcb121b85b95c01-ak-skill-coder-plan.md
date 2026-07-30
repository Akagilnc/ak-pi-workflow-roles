## Current facts

- `HEAD` is exactly baseline `4509371219be8601c4f6e538b92885f946918515` on `feature/deepen-role-runtime`; worktree is clean and there are zero commits after baseline.
- Coder apply currently transforms only its first input to `/skill:tdd`, but completion trusts a transcript regex (`/<skill name="tdd"\s/`). It neither loads the canonical TDD snapshot nor binds evidence to the immediately following expanded prompt. Plan does not invoke TDD; apply refusal is accepted without expansion or commit.
- Reviewer already loads `~/.agents/skills/code-review/SKILL.md` through `realpath`, retains raw/path/baseDir/stripped body, transforms the first input, and validates the immediately following `before_agent_start.prompt` with Pi’s `parseSkillBlock`. It checks exact name, real location, `References are relative to <baseDir>.` preamble, full stripped body, and original request. Mismatch is fatal and is persisted in the Reviewer ledger; later prompts cannot repair it.
- Pi’s actual order is `input` → transform chaining → native skill expansion → `before_agent_start`; `event.prompt` is the post-expansion text. Pi’s expansion reads the selected Skill, strips frontmatter, emits the location/preamble/body block, and appends trimmed command arguments. `parseSkillBlock` is anchored to the complete prompt. Name collisions keep the first discovered Skill, so exact canonical-location proof is the fail-closed collision detector; callers continue using `--no-skills --skill <canonical path>`.
- Existing tests cover Reviewer provenance/fatal behavior and real packaged expansion well, but Coder’s unit gate explicitly accepts a copied transcript marker. Coder’s packaged test owns a temporary TDD Skill but does not currently set `HOME` to that fixture because production never reads the canonical path.
- ADRs require demand-driven seams, package-owned role contracts, no generic speculative framework, no package retry layer, and minimal package distribution. No ADR or Soul change is warranted. `package.json` already ships `src`; current dry-run tarball contains `src/reviewer-skill.ts` and no `SKILL.md`.
- Baseline verification passed: typecheck and the full suite under an initially empty `HOME` (88 tests) are green; current `npm pack --dry-run` contains no Skill file.

## Test-first implementation plan

1. **Add direct red tests for a single deep module**
   - Create `test/canonical-skill-binding.test.ts` before production code.
   - Use temporary test-owned homes containing exact `~/.agents/skills/{tdd,code-review}/SKILL.md` fixtures.
   - Characterize `realpath` resolution (including a symlink), raw/body/path/baseDir retention, exact `/skill:<name> <request>` construction, and role-neutral errors that name the Skill and configured/canonical path.
   - Prove missing, unreadable (for example, `SKILL.md` as a directory), and frontmatter-only/empty bodies fail closed.
   - Table-test structural proof: accept only exact name, real path, Pi reference preamble, complete stripped body, and original request; reject marker-only text, prose before/after the block, wrong name, wrong/alternate path, partial body, missing/changed preamble, and wrong request.
   - Assert returned snapshots/evidence are frozen and detached. Run this test first and retain the expected failure before adding the module.

2. **Replace, rather than wrap, `src/reviewer-skill.ts`**
   - Delete it and add `src/canonical-skill-binding.ts`.
   - Expose one small finite role-facing seam, conceptually `loadCanonicalSkillBinding(name)` for only `"tdd" | "code-review"`, returning an immutable binding with an immutable canonical snapshot, native invocation construction, and `captureExpansion(prompt, originalRequest)`.
   - Internally own `homedir` path construction, `realpath`, file reading, `stripFrontmatter`, non-empty-body validation, Pi preamble construction, `parseSkillBlock`, exact comparisons, and defensive copies/freezing.
   - Add no registry, discovery, fallback path, bundled content, event system, or package Skill declaration.

3. **Move Reviewer onto the shared seam without changing policy**
   - Change the production entrypoint to inject the shared loader.
   - In `src/role-runtime.ts`, keep Reviewer’s first-input/pending lifecycle, fatal mismatch handling, `ctx.abort`/exit behavior, task bytes, tools, audit, and receipt rules unchanged; only replace the Reviewer-specific loader/capture calls with the binding interface.
   - Make the minimal evidence-type import adjustment in `src/reviewer-execution-ledger.ts`; do not alter ledger lifecycle or completion logic. Its audit record remains `{name, location, content, userMessage}` and the auditor still receives the complete canonical raw Skill.
   - Expand Reviewer characterization tables to include wrong name/request and surrounding task/assistant prose while retaining copied, partial, alternate-path, and later-message fatal cases. Assert audit raw/evidence are byte-for-byte/structurally unchanged.

4. **Bind Coder apply at the same native expansion seam**
   - Load `tdd` only during Coder `apply`; Coder `plan` must neither require the loader nor invoke a Skill.
   - Preserve the first normal input transform and image forwarding. Preserve the existing pre-prefixed `/skill:tdd` no-double-prefix behavior, deriving the expected Pi argument text for structural comparison. Never reinvoke on later input.
   - Mark only the immediately following `before_agent_start` prompt as eligible and capture proof through the shared module. Ignore later blocks as completion evidence.
   - Replace the transcript regex with the captured evidence gate for `apply + completed` only. A malformed/missing expansion rejects completion, but does not make an evidence-bearing `refused` receipt illegal. Missing/unreadable/empty canonical TDD at activation remains infrastructure failure; add the same uninitialized-before-agent fail-closed guard needed because Pi reports `session_start` extension errors and otherwise continues.
   - Leave report/self-check guidance, singleton submission, status/phase validation, commit optionality, active tools, Souls, and Judge/Fixer behavior untouched.

5. **Add production-interface and real-Pi red/green coverage**
   - Rewrite the Coder role test so a transcript marker cannot pass. Feed the first exact expanded prompt to `before_agent_start` for acceptance, then use fresh harnesses to reject marker-only/copied transcript evidence, partial body, wrong path, same-name alternate path, wrong name/request, prose, and later-message blocks.
   - Explicitly retain tests for plan input returning `continue`, zero binding loads in plan, and apply refusal without evidence or commit after the existing first-input behavior.
   - Update the packaged Coder lifecycle test to set `HOME` to its temporary fixture, parse/assert the actual native expansion including request and preamble, and prove completed acceptance through real Pi.
   - Add print/JSON subprocess cases for missing, unreadable, and empty canonical TDD: nonzero/aborted infrastructure outcome, no accepted `ak_coder_output`, and no receipt status masquerading as failure.
   - Keep the installed Reviewer lifecycle test intact as the second real adapter. Ensure its independent consumer, complete raw audit input, structured evidence, tools, agent lifecycle, and fatal semantics remain green.

6. **Documentation and package truth**
   - Update only the stale Coder README sentence from “a transcript contains a block” to exact immediately-following canonical native expansion proof. Keep commands, flags, contracts, and external paths unchanged. Do not touch Souls, CONTEXT, ADRs, schemas, or orchestration.
   - Check dry-run tar contents include `src/canonical-skill-binding.ts`, exclude deleted `src/reviewer-skill.ts`, include all existing runtime/Souls, and contain neither any `SKILL.md` nor copied canonical phrases/content.

## Verification and commit discipline

- During TDD, run focused module/role/package/subprocess tests after the initial red, then green them with the minimal implementation.
- Run the required final gate exactly:
  `npm run typecheck`
  `EMPTY_HOME=$(mktemp -d); HOME="$EMPTY_HOME" npm test`
  `npm pack --dry-run`
  `git diff --check`
- Inspect the final diff for the same-pattern check (both adapters use the one seam), introduced regressions (full suite), and behavior facts (real Pi contexts, Reviewer audit payload, fatal CLI results, tar listing).
- Create exactly one ordinary forward Coder commit after all gates; do not amend, squash, or push. Then verify baseline is the merge-base, `git rev-list --count baseline..HEAD` is `1`, Souls are unchanged, and the worktree is clean.

No files were edited and no commit was created during planning.
