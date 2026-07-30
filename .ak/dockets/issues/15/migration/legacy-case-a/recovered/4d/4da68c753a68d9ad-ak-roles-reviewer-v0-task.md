# Reviewer v0 construction task

Implement a fourth independently selectable role, `reviewer`, in `@ak/pi-workflow-roles`.

## Role capability

Reviewer performs Matt Pocock's fixed-point two-axis code review as its own capability. It is not a workflow router and must contain no assumptions about who calls it or consumes its receipt.

Reserve `reviewer-cmr` as a distinct future role concept only in documentation/terminology if useful; do not implement it. `reviewer` uses the active model and does not promise cross-model diversity. Future `reviewer-cmr` will own AK CMR's cross-model panel semantics.

## Canonical method

The only review-method truth source is:

`~/.agents/skills/code-review/SKILL.md`

Do not copy, bundle, paraphrase, or reimplement that Skill. Reviewer must invoke it through Pi's native `/skill:code-review`, using the same explicit canonical binding pattern as Coder's Matt TDD integration. A completed receipt requires observable transcript evidence that Pi expanded the canonical Skill.

The Matt Skill's core requirement for parallel general-purpose `Agent` calls must actually work in Pi. Provide the smallest Reviewer-owned compatibility interface named `Agent`; do not depend on a globally installed generic subagent extension.

## Internal Agent capability

`Agent` is an internal Reviewer implementation seam, not role-to-role orchestration. Each invocation runs an isolated, tool-using agent context with the parent Reviewer's active model/provider/auth and an independent message history. Sibling Agent calls must be able to execute concurrently through Pi's normal parallel tool execution.

Prefer an in-process low-level Pi Agent runner over CLI subprocesses if a tested implementation can preserve the effective active provider/auth, cancellation, usage, and tool-loop behavior. Hide the implementation behind a narrow injectable dependency so tests cross the same interface. Do not expose generic chain/agent-discovery workflow features.

Each Standards/Spec leg receives an independent writable temporary clone pinned to the reviewed target. It may install dependencies, run tests, and create fixtures/probes/local artifacts for review evidence. It must not repair the product, commit, push, mutate remote state, or treat scratch changes as reviewed-target facts. The original repository must not be modified. Workspace isolation is operational governance, not a hostile-code sandbox; document that callers needing security isolation must supply a sandbox/container.

The child tool surface may include `read`, `grep`, `find`, `ls`, `bash`, `write`, and `edit`. It must not include `Agent` or role submission tools, preventing recursion. Clean up successful temporary workspaces; preserve and report diagnostically useful state on failed preparation/audit where appropriate. Keep implementation proportional to Reviewer v0 rather than copying the full generic Pi subagent example or AK CMR clone engine.

## Reviewer role interface

CLI input:

`--ak-review-task <path-to-opaque-Markdown>`

There is no phase. The Markdown should normally identify a fixed point and spec source (or explicitly state that no spec exists), but runtime must not impose a serialized upstream finding schema.

Inject a short bundled `souls/reviewer.md` containing only irreducible professional judgment and role boundaries. Review steps, Standards/Spec mechanics, smell baseline, subagent prompts, and aggregation format remain owned by the canonical Skill.

On activation, narrow the parent tool surface to the registered members of:

`read`, `grep`, `find`, `ls`, `bash`, `Agent`, `ak_reviewer_output`

This prevents accidental drift but is not a security boundary.

Submission tool:

`ak_reviewer_output`

Exact thin envelope:

```json
{"status":"completed|refused","report":"non-empty Markdown"}
```

`completed` means the requested review completed; it does not encode clean/findings, approval, routing, or a next role. `refused` means an honest review cannot be formed because the review target, authority, or factual premise cannot be established. Infrastructure failures are not refusals. The submission must be the sole final tool call. Refusal may occur before Skill/Agent execution; completed must demonstrate canonical Skill expansion and at least one successful Agent call, with every attempted Agent call successful.

## Mandatory internal audit

Before accepting either status, run a separate, no-tool, active-model Reviewer method-compliance audit inside the role runtime. It is a distinct model context in the same process, not a subagent, Pi child process, container, or second substantive review.

The audit receives the Reviewer Soul, complete canonical Skill, review task, a compact execution record (including Skill evidence, fixed-point evidence where demonstrated, Agent prompts/results/statuses), and candidate receipt. It checks demonstrated compliance, traceability, honest refusal, axis isolation/skip handling, faithful aggregation, scratch-vs-target distinction, and role boundaries. It must not discover new findings, rerank axes, decide mergeability, or redo the review.

Use exact `pass|revise` structured decisions. `revise` is an ordinary errored submission result allowing resubmission. Authentication/provider/malformed-audit failures are fatal and must use the package's non-zero infrastructure failure channel. Reuse/deepen the existing audit transport/auth/decision machinery rather than duplicating it, while keeping Judge and Reviewer audit policies distinct.

## Evidence and tests

Build test-first. At minimum prove:

1. CLI/help and package lifecycle support `reviewer` and `--ak-review-task`.
2. Reviewer loads its Soul and opaque task and keeps only its exact parent tool surface.
3. First input invokes `/skill:code-review`; packaged Pi expands the complete canonical Skill.
4. Completed is rejected without expansion evidence.
5. Completed is rejected without at least one successful Agent call and after any failed Agent call.
6. Refused may submit before Skill/Agent execution but still undergoes compliance audit.
7. Two sibling Agent calls use isolated contexts/workspaces and can overlap in time.
8. Child contexts have the intended tools and cannot recursively call Agent/role outputs.
9. Writable fixture/probe behavior occurs only in temporary review workspaces and does not change the original repository.
10. Compliance pass accepts; revise permits correction; audit infrastructure/malformed output fails fatally and non-zero in print/JSON package actions.
11. `ak_reviewer_output` is singleton/terminating and contains no routing semantics.
12. Existing Judge, Fixer, and Coder behavior remains green.
13. The npm tarball contains the Reviewer Soul/runtime but no copied `code-review` Skill.

Run tests, typecheck, pack dry-run, CLI help, and a real packaged lifecycle test. Create one forward commit; do not amend existing history.
