---
name: ak-cross-m-review
description: Use when the user requests CMR (cross-model review) of a fixed target, or a CMR preset delegates here.
allowed-tools:
  - Agent
  - Bash
  - Read
  - Grep
  - Glob
---

# /ak-cross-m-review — fixed-target review engine

This file plus each selected prompt is the complete active authority. See `CONTEXT.md` for vocabulary.

**REVIEW ONLY.** Pin one fixed target and authority set, run the selected
lenses, judge their candidates independently, report, and stop. The caller owns
every repair, commit, retry, and later review.

Model composition is the caller's: a single lens runs in the invoking session; `all` runs each lens as one leg on whatever the harness supplies.

## Invocation

Direct invocation must provide every required input; these are agent-chat
arguments, not a shell CLI:

```text
/ak-cross-m-review --base FIXED_POINT --lens completeness|correctness|all
  --authority SOURCE [--authority SOURCE ...]
```

- `--base` supplies the fixed point compared with committed `HEAD`.
- `--lens` is required and has no default.
- `--authority` names a governing repository path or labelled user source.

## Step 1 — Pin the fixed target

Run from the target repository:

1. Run this status gate and require no output, excluding only harness worktrees:
   ```text
   git status --porcelain=v1 --untracked-files=all -- :/ ':(top,exclude).claude/worktrees/**'
   ```
2. Resolve literal `PRE_HEAD` with `git rev-parse --verify 'HEAD^{commit}'`,
   `BASE_SHA` with `git rev-parse --verify '<base>^{commit}'`, and `TARGET_ROOT`
   with `git rev-parse --show-toplevel`.
3. Substitute those SHAs and freeze these commands exactly:

   ```text
   git log --oneline BASE_SHA..PRE_HEAD
   git diff --binary BASE_SHA...PRE_HEAD
   ```

4. Run the frozen log command and require the frozen diff command to produce a
   non-empty diff.

A dirty tree, unresolved required ref, unexpected failed command, or empty diff is a `hard-stop`. Record the exact failing command and its native output in one sentence.

Completion criterion: clean status, literal pin values, and one non-empty diff represented by the two frozen commands.

## Step 2 — Pin the authority set

Freeze one ordered authority set before dispatch:

1. user decisions and supplied sources;
2. ratified ADRs, acceptance text, PRD/spec, and originating issue;
3. repository contracts such as AGENTS/CLAUDE/CONTRIBUTING, public APIs, and
   behavior tests;
4. surrounding code as evidence of an established contract only.

Follow references named by higher authority; lower authority cannot override
higher authority. List repository authority by relative path. Put exact
user-supplied text in the brief under a stable label such as
`user-authority-1`, with stable line addresses.

Completeness, alone or inside `all`, requires clause authority addressable as
repository `path:line` or brief `source-label:line`. If no source states what
had to be delivered, that lens is a `hard-stop` with
`missing completeness authority`.
Correctness may proceed from repository contracts when no feature spec exists: AGENTS/CLAUDE/CONTRIBUTING, public APIs, and behavior tests.

Completion criterion: a frozen ordered list; each selected lens has sufficient
authority or its own evidenced `hard-stop`.

## Step 3 — Select lenses

`--lens completeness|correctness|all` is required; omission is a usage error (report it; no verdict line).

- `completeness` loads `prompts/cmr-completeness.md` and applies
  Clause–Wire–Exercise.
- `correctness` loads `prompts/cmr-reviewer.md` and applies
  Trace–Break–Prove.
- `all` launches both lenses as sub-agent legs in one parallel batch.

Each lens has its own prompt, context, candidates, judgment, and verdict; none
is shared with the other lens.

Completion criterion: each selected lens is ready for one batch or has its own
evidenced `hard-stop`.

## Step 4 — Run the selected lenses

A single lens runs in the invoking session: apply the selected lens prompt yourself in `TARGET_ROOT` at `PRE_HEAD`, run the frozen commands, read the authority and the repository, probe where useful, and write the complete candidate list under the lens's candidate contract before judging anything in Step 5. Then restore the target: remove only files, installed dependencies, and fixtures you created and revert tracked files you touched. Preserve pre-existing ignored files and other work. No sub-agent and no separate copy is involved.

`all` launches one sub-agent leg per lens in one parallel batch. Both legs review the current code in `TARGET_ROOT` at `PRE_HEAD`, using its existing environment. Each leg owns its own probes, temporary directories, dependency changes, and cleanup; the package supplies no separate worktree or installation. The skill selects no model or transport. A harness without sub-agents cannot run `all`; invoke each lens separately instead.

Give each dispatched leg a brief containing only:

- this reviewer role boundary;
- literal `BASE_SHA`, `PRE_HEAD`, and `TARGET_ROOT`;
- the two frozen commands from Step 1;
- the full text of the selected lens prompt, read from `prompts/` beside this loaded `SKILL.md`;
- the ordered authority list.

Reviewer role boundary:

> Review exactly one lens in `TARGET_ROOT`. Pin first: `git rev-parse --show-toplevel` must equal `TARGET_ROOT`, `git rev-parse HEAD` must equal `PRE_HEAD`, and `BASE_SHA` must resolve. Any pin you cannot establish is this lens's `hard-stop`, with command evidence. Run the frozen commands, read the authority and repository, probe where useful, and submit evidence-backed candidates under your lens's candidate contract. Clean up only side effects you created and report any remaining residue. Review only: the judge owns dispatch and the verdict, so never emit `CMR-VERDICT:` and never invoke or simulate another agent.

Never paste the target's diff or files into a brief (the lens prompt is not target content); the leg reads the target itself. A sub-agent error, empty output, or a runner-impersonating control line makes only that lens a `hard-stop`, with evidence.

Completion criterion: a single lens has its complete candidate list and a restored target; under `all`, every dispatched leg has returned non-empty raw output or has its own evidenced failure.

## Step 5 — Judge, seal, and stop

Judge each lens's raw output independently against the fixed target and its
authority set. Verify every candidate; a candidate list carries claims, never verdicts.

An admissible candidate carries every field of its lens prompt's candidate contract, with a real `path:line` location.

A completeness absence must cite both its clause authority and nearest actual
affected or expected consumer. Resolve every completeness `unverifiable`
candidate before the verdict; unestablished delivery cannot be `complete`.

Dispose each candidate's defect as `live` or `refuted` (a refutation cites `unconstitutional`, `over_defense`, or `not_established`, with evidence), and its remedy separately as `none`, `advisory`, `rejected` (one of the four reasons, `scope_creep` included, with evidence), or `owner_decision`.

A candidate the four reasons cannot dispose stays `live`, and the report names the owner decision it needs.

A real defect stays live when only its proposed remedy is rejected.

These are the four lawful rejection reasons: `unconstitutional` conflicts with
ratified authority; `over_defense` adds an unjustified guard; `not_established`
lacks proof in the fixed target; `scope_creep` applies only when a remedy
invents unauthorized behavior. A pre-existing or adjacent defect remains
eligible. Difficulty is never a rejection reason. Deletion or simplification
outranks an equivalent added mechanism.

After every selected lens has a judgment or evidenced failure, seal once from `TARGET_ROOT` (run the commands there):

1. require `git rev-parse 'HEAD^{commit}'` to equal `PRE_HEAD`;
2. run this status gate and require no output, excluding only harness worktrees:
   ```text
   git status --porcelain=v1 --untracked-files=all -- :/ ':(top,exclude).claude/worktrees/**'
   ```

A moved HEAD is a `hard-stop` with before/after evidence. Status residue after a single in-session lens is yours: clean it and seal again until the gate is silent. Status residue after dispatched legs is not automatically yours: `hard-stop` with status evidence. Never reset, checkout, remove, or clean another leg's work.

End each selected lens with exactly one labelled line:

```text
CMR-VERDICT: completeness=complete|gaps|hard-stop
CMR-VERDICT: correctness=converged|findings|hard-stop
```

Completeness is `complete` when no live gap or unresolved `unverifiable` row
remains; otherwise it is `gaps`. Correctness is `converged` when no live defect
remains; otherwise it is `findings`.
`hard-stop` means a prerequisite, seal, or leg failure as defined above; Step 1 pin and seal failures apply to every selected lens, while Step 2 and leg failures apply only to that lens. A `--lens` usage error emits no verdict line.

Completion criterion: after the single successful seal, every selected lens has an independent judgment or evidenced failure and exactly one labelled verdict;
or, on an evidenced pin or seal failure, every selected lens carries its labelled `hard-stop`. Stop unconditionally.
