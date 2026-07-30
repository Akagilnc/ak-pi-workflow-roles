# Architecture wave 4 — deepen the packaged Pi test harness

Baseline: `802d28af17efa588aa12d9f8dc689e4a740ebc1d`
Branch: `feature/deepen-role-runtime`

Perform a behavior-preserving test-architecture refactor that concentrates repeated Pi/package bootstrap mechanics behind one deep test module while leaving all production files and public behavior unchanged.

## Frozen production surface

Do not modify `src/`, `extensions/`, `souls/`, README, CONTEXT, ADRs, package manifest/lockfile, CI, role contracts, diagnostics, Skills, or runtime behavior. No production fallback or test-only production hook.

Do not weaken, delete, merge away, or rewrite behavioral assertions to fit the harness. Do not begin new production architecture work, CMR, routing, target binding, retries, or orchestration.

## Deep test module responsibility

Create the smallest coherent test harness justified by repeated real consumers. It should own substantial repeated mechanics such as:

- temporary HOME/agent directories and deterministic cleanup;
- hermetic canonical test Skill creation;
- temporary consumer Git repository/package installation where required;
- faux provider/model runtime/auth setup;
- `DefaultResourceLoader`, settings, in-memory/persisted session setup;
- extension flag binding and role prompt execution;
- print/JSON subprocess invocation where appropriate;
- capture of provider contexts, tool results, receipts, usage, and fatal diagnostics;
- package manifest/entrypoint resolution and tarball inspection where shared.

Use separate in-process and subprocess adapters only if their execution semantics genuinely differ. Keep real Pi messages, tool calls/results, session entries, stdout/stderr, exit codes, and provider contexts directly inspectable by tests. Do not build an assertion DSL, scenario language, generic mock framework, broad fixture registry, or helpers that return only booleans/summaries and hide failure evidence.

The harness should be deep: tests describe role behavior and special provider responses while Pi bootstrap/install/cleanup stays behind a small interface. The deletion test must show that removing it would redistribute substantial setup across multiple test modules.

## Scope selection

Start by inventorying exact duplicate setup across:

- `test/package-entrypoint.integration.test.ts`
- `test/reviewer-package-lifecycle.test.ts`
- `test/audit-failure-subprocess.test.ts`
- `test/judge-role.test.ts`
- `test/reviewer-role.test.ts`
- existing `test/helpers/*`

Extract only clusters with at least two real consumers. Leave one-off complex scenarios local. Do not combine fast extension-controller tests with full package/process tests merely because both use Pi types.

## Test-preservation requirements

After refactor, retain mechanically equivalent coverage for:

- all four role flags/help, prompt bytes, tools, schemas, singleton termination, receipts;
- Judge and Reviewer audit pass/revise/fatal behavior and exact provider/auth evidence;
- Coder canonical TDD expansion, plan/refusal/completion, and Skill infrastructure failures;
- Reviewer canonical code-review expansion, parallel child overlap, writable clone isolation, ledger provenance, package installation, and audit correction;
- Fixer phase/status behavior;
- print and JSON exit code, tool-specific `isError`, stage markers, provider call counts, no later turn, and no accepted receipt;
- empty-HOME hermeticity;
- tarball exact expected production files and no `SKILL.md`/copied canonical content;
- every existing counterexample fixed during Reviewer construction and waves 1–3.

Preserve test readability: scenario-specific setup and assertions remain next to the scenario; only repeated infrastructure moves. Add tests for the harness itself only when they prove cleanup, evidence preservation, or adapter semantics not already exercised through role tests.

Require a post-change audit:

- production tree byte-identical to baseline;
- no assertions removed or loosened;
- test names/behavior inventory retained;
- fewer duplicated Pi bootstrap/install blocks;
- failures still report raw context/tool/process evidence;
- no new host-state dependency;
- package dry-run remains exactly the baseline production contents.

## Unified verification gate

Run:

```bash
npm run typecheck
EMPTY_HOME=$(mktemp -d)
HOME="$EMPTY_HOME" npm test
npm pack --dry-run
git diff --check
```

Confirm `git diff <baseline>...HEAD -- src extensions souls README.md CONTEXT.md package.json package-lock.json docs .github` is empty, strict ancestry, one Coder forward commit before review, and a clean worktree. Do not amend, squash, or push. Refuse if the proposed abstraction would hide behavioral evidence or become a shallow fixture utility.
