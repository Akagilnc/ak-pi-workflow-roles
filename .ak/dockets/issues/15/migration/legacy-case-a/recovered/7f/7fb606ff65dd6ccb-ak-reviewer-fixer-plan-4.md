## Repair plan

Current HEAD is clean at `3e789579181e07785e4eebea4eb11de689f0bcf2`. History shows `98f36c0` extracted only auth/decision parsing into `src/compliance-transport.ts` while introducing the two near-identical auditor flows, so the repair will deepen that existing seam rather than add another abstraction.

1. **Make the three Skill-dependent tests hermetic.** Add one small test helper that writes a valid, non-empty frontmatter Skill at `<temporary-home>/.agents/skills/{code-review|tdd}/SKILL.md`. Use it from:
   - `test/reviewer-package-lifecycle.test.ts`: create `code-review` under the test’s temporary home, temporarily point `process.env.HOME` there (restoring it in `finally`), and pass that same real path to `DefaultResourceLoader`. This makes production `homedir()` lookup and native Skill loading agree.
   - `test/audit-failure-subprocess.test.ts`: create `code-review` under each subprocess-owned temporary home, pass its path through `--skill`, and set the child’s `HOME` to that home.
   - `test/package-entrypoint.integration.test.ts`: create `tdd` under the test-owned temporary home and pass it through `additionalSkillPaths`.
   Remove the three `homedir()` reads; do not alter production Skill lookup, bundle either method, or change CI.

2. **Preserve Reviewer task bytes.** In `src/role-runtime.ts`, read the task into a raw local, reject it only when `raw.trim()` is empty, and assign the untouched raw string to `activeReviewerTask`. Add a focused `test/reviewer-role.test.ts` regression using four leading spaces and a terminal newline; assert the complete generated system prompt contains the exact wrapped raw bytes and that the captured `ReviewerAuditInput.task` is exactly the same string.

3. **Complete the existing compliance transport extraction.** In `src/compliance-transport.ts`, centralize the common pass/revise decision-tool schema plus the active-model/auth/provider completion dispatch, fixed request options, single user-message construction, and decision parsing. Parameterize only the tool, system prompt, serialized role input, role/error labels, optional injected completion, context, and signal. Reduce `src/soul-auditor.ts` and `src/reviewer-auditor.ts` to their exported tool names/factories and role-specific descriptions, prompts, input serialization, and labels. Preserve the current exact auth/provider error strings, resolved model/auth behavior, `2048` token/no-cache/session/signal options, and strict one-call pass/revise validation. Keep `prepareComplianceDispatch` in the same module for `reviewer-agent.ts`; introduce no parallel transport.

4. **Verify and deliver as one forward fix commit.** Confirm the remaining `.agents/skills` references are production/documentation or inert test data, inspect the diff for only the authorized files, then run exactly:
   - `npm run typecheck`
   - `HOME=$(mktemp -d) npm test`
   - `npm pack --dry-run`

All existing auditor authentication/provider/decision tests and subprocess fatal-path tests must remain green. In apply phase, create one new `fix:` commit without amending history.
