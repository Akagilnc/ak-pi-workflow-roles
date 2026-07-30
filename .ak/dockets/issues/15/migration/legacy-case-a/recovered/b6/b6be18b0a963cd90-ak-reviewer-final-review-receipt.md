# Reviewer receipt

## Standards

1. **Hard violation — tests depend on unprovisioned host state**  
   - `test/reviewer-package-lifecycle.test.ts:59-62`:
     > `realpath(resolve(homedir(), ".agents/skills/code-review/SKILL.md"))`
   - `test/audit-failure-subprocess.test.ts:81-82`:
     > `"--skill", resolve(homedir(), ".agents/skills/code-review/SKILL.md")`

   These new tests require a user-global Skill absent from a clean checkout. This violates README.md’s unconditional Development contract (`npm test`) and ADR 0009’s rule that CI consists of `npm test` plus typecheck. `.github/workflows/ci.yml` provisions no such Skill, so clean GitHub runners cannot pass the documented suite.

   **Scratch-only probe:** after installing dependencies into ignored `node_modules/`, running each focused test with a temporary empty `HOME` failed on the missing Skill; the ordinary suite passed only because this review host already has that external file. No tracked files were changed.

2. **Judgement call — Duplicated Code**  
   `src/reviewer-auditor.ts` substantially repeats the changed `src/soul-auditor.ts` structure: an almost identical decision-tool schema (`status`, `violations`, constrained sampling), active-provider lookup/stream closure, dispatch options, and decision parsing call. For example:
   > `const reviewerDecisionTool = { ... status: StringEnum(["pass", "revise"]) ... }`

   mirrors `auditDecisionTool` in `src/soul-auditor.ts`. `compliance-transport.ts` extracts authentication and parsing but leaves the repeated audit-call scaffold in both files; a shared compliance-auditor constructor could own that shape while accepting role-specific names and prompts.

## Spec

- **[P2] Opaque review tasks are mutated before use.** Controlling spec: “`--ak-review-task <path-to-opaque-Markdown>`” and “runtime must not impose a serialized upstream finding schema.” In `src/role-runtime.ts:696`, the loaded task is passed through `.trim()` and the modified value is injected into the system prompt and compliance audit. This is not opaque preservation: Markdown beginning with four spaces can represent quoted/code material, but trimming converts the first line into ordinary Markdown, potentially changing whether text is instruction or example. Validate non-blankness with `trim()` while retaining the original content.

No independently substantiated scope creep or other Spec-axis defects found. Full tests (70), typecheck, and pack dry-run passed after a scratch-only dependency install; the pinned target was not modified.

Summary: Standards — 2 findings; worst: clean-checkout/CI tests depend on an unprovisioned user-global Skill. Spec — 1 finding; worst: the opaque Markdown task is altered by trimming.
