## Repository/API findings

- Worktree is clean on `feature/judge-role` (ahead of its remote by 8 existing commits); no files were edited and no commit was created.
- The extension is wired through `extensions/role-runtime.ts`; role activation, input transforms, singleton terminating outputs, and Judge audit gating live in `src/role-runtime.ts`.
- `src/soul-auditor.ts` already has the correct active-model/provider/auth transport and fatal-vs-revise behavior, but its policy and types are Judge-specific.
- Pi 0.82.1’s `createAgentSession()` is an in-process wrapper over the low-level `Agent`. It supports explicit cwd/tool allowlists, in-memory histories, active thinking level, usage, abort, and parallel sibling tool execution. Pi’s agent loop preflights sibling calls sequentially and executes them concurrently by default.
- The canonical Skill is only `~/.agents/skills/code-review/SKILL.md`. Pi expands `/skill:code-review` into an observable `<skill name="code-review" location="…">` user-message block. The Skill expects a conventional `Agent` call with `subagent_type: "general-purpose"`, `description`, and `prompt`.

## Test-first implementation plan

1. **Add failing Reviewer role/runtime tests**
   - Extend the extension harness in `test/judge-role.test.ts` or add `test/reviewer-role.test.ts` for role selection, `--ak-review-task`, opaque Markdown loading, no phase, Soul/task injection, exact parent tools, first-input `/skill:code-review` transform, and strict output envelope.
   - Prove `completed` requires the complete canonical expansion at its canonical path, at least one successful `Agent`, no running attempts, and no failed attempts; prove `refused` can reach audit with neither Skill nor Agent evidence.
   - Prove output singleton/termination, no routing fields, revise/resubmit, and fatal audit handling.

2. **Introduce the minimal Reviewer surface in `src/role-runtime.ts`**
   - Add `reviewer` to the role union and register only `--ak-review-task` (no Reviewer phase flag).
   - Add exact schema `{status: "completed"|"refused", report: nonblank Markdown}` with no optional or routing fields.
   - Register `Agent` and `ak_reviewer_output` only when Reviewer is active; mark `Agent` parallel-capable and accept only `general-purpose`, `description`, and `prompt`—no chaining, discovery, model selection, cwd, or role routing.
   - Track every Agent attempt before awaiting it, including prompt, status, target SHA, result/failure, usage, and workspace disposition. Gate completion on full canonical expansion plus one-or-more attempts with every attempt successful.
   - Apply the exact registered-tool intersection `read`, `grep`, `find`, `ls`, `bash`, `Agent`, `ak_reviewer_output`.

3. **Build an injectable in-process Agent runner in a focused `src/reviewer-agent.ts`**
   - Expose one narrow dependency such as `runReviewerAgent(request, {context, signal})`; role tests inject a fake while runner tests exercise the same interface.
   - Memoize the reviewed repository root and `HEAD` SHA per Reviewer session so concurrent sibling calls pin the same target.
   - For each call, create a distinct temp directory, `git clone --no-checkout --no-hardlinks`, detach at the memoized SHA, verify it, and remove the clone’s origin before the child runs.
   - Create a fresh in-memory Pi session rooted at that clone with only `read`, `grep`, `find`, `ls`, `bash`, `write`, and `edit`. Disable extension/Skill/context discovery so children cannot call `Agent` or any role output.
   - Reuse the parent’s active model, thinking level, provider implementation, and freshly resolved effective auth/base URL/headers/env through a small child `ModelRuntime`; bridge the parent tool signal to clone commands and `session.abort()`.
   - Return the child’s final report and aggregate nested usage. Treat error/aborted/no-report child endings as failed attempts. Dispose every child session; delete successful workspaces, but retain failed preparation/audit workspaces and include their paths in diagnostics.
   - Keep the child system prompt operational only: work inside the writable clone, do not repair/commit/push or mutate remotes, and distinguish probes/scratch changes from reviewed-target facts. Do not duplicate Standards/Spec prompts or any review method from the Skill.

4. **Prove isolation and real parallelism in `test/reviewer-agent.test.ts`**
   - Use temporary Git repositories and faux providers to show two Agent calls receive distinct histories, session IDs, and writable clones pinned to one SHA.
   - Drive two `Agent` calls from one actual Pi assistant message and use a barrier/timestamps to prove overlap through Pi’s normal parallel tool loop.
   - Inspect child provider contexts to prove the exact seven child tools and absence of `Agent`/role outputs.
   - Have a child write/edit probes in its clone, then assert the original repository bytes and Git state are unchanged; assert successful cleanup and failed-run preservation/diagnostics.
   - Verify provider/auth/base URL/headers/env, cancellation, final output, and nested usage cross the real runner seam.

5. **Generalize, then specialize, compliance audit transport**
   - Extract the existing auth dispatch and exact one-call `pass|revise` parser into a shared internal compliance-audit transport while preserving `createPiSoulAuditor()` as the Judge policy wrapper.
   - Add a distinct Reviewer policy wrapper (likely `src/reviewer-auditor.ts`) and decision tool name. Its no-operational-tool, fresh active-model context receives Reviewer Soul, the complete external canonical Skill, opaque task, compact execution record, and candidate receipt.
   - Build the compact record from canonical expansion evidence, relevant fixed-point Git commands/results where demonstrated, and every Agent prompt/result/status/workspace disposition.
   - The Reviewer policy checks only method compliance, traceability, honest refusal, axis isolation/skip handling, faithful aggregation, scratch-vs-target distinction, and role boundaries; explicitly forbid discovering/reranking findings, deciding mergeability, or redoing review.
   - Keep `revise` as an ordinary tool error. Route auth/provider/malformed audit failures through the existing abort plus print/JSON non-zero infrastructure channel for both Judge and Reviewer.

6. **Add the bundled Soul without method duplication**
   - Create short `souls/reviewer.md` containing only irreducible judgment: evidence against a fixed reviewed target and authority, traceability, target-vs-scratch distinction, and boundaries against repair, publication, routing, or final adjudication.
   - Add `test/reviewer-soul.test.ts` to require those principles and reject copied Skill mechanics, smell lists, schemas, caller assumptions, and `reviewer-cmr` panel semantics.
   - Wire external loading of the canonical Skill only for evidence/audit; never copy or paraphrase it into package files.

7. **Package/docs/lifecycle coverage**
   - Update `extensions/role-runtime.ts` loaders and `README.md`/`CONTEXT.md` for Reviewer invocation, exact receipt semantics, canonical binding (`--no-skills --skill ~/.agents/skills/code-review/SKILL.md`), writable-clone governance, and the need for caller-supplied sandbox/container for security isolation.
   - Document `reviewer-cmr` only as an unimplemented future cross-model concept; state that `reviewer` uses the active model and promises no model diversity.
   - Extend `test/package-entrypoint.integration.test.ts` to prove packaged Pi expands the entire canonical Skill, executes parallel Agent children, audits, revises/resubmits, and terminates on acceptance.
   - Extend subprocess fixtures/tests so Reviewer malformed/provider/auth audit failures exit non-zero in print and JSON modes.
   - Add a tarball lifecycle test that packs the project, installs/extracts the produced package into a temporary location, activates it through Pi offline, and checks the receipt. Assert tar contents include Reviewer Soul/runtime and contain no `code-review` Skill or `SKILL.md`.

8. **Final apply verification and commit**
   - Run focused red/green tests throughout, then `npm test`, `npm run typecheck`, `npm pack --dry-run --json`, CLI help checks for `reviewer`/`--ak-review-task`, and the real packaged lifecycle test.
   - Run same-pattern checks across Judge/Fixer/Coder singleton, fatal-audit, tool-gating, and Skill-binding paths; inspect the final diff for introduced regressions and verify behavior facts against actual Pi contexts/workspaces rather than mocks alone.
   - Create exactly one forward commit after all checks pass; do not amend, rewrite, or push.

## Baseline evidence

Current baseline is green: `npm test` passed 49 tests, `npm run typecheck` passed, `npm pack --dry-run --json` passed with 8 current package entries, and packaged CLI help loaded successfully.
