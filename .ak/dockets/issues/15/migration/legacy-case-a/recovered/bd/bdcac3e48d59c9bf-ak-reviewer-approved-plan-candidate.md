# Consolidated Reviewer v0 implementation plan

## Current facts and construction boundaries

- The worktree is clean on `feature/judge-role`, eight commits ahead of its upstream. No files were changed during planning.
- The role extension is assembled in `extensions/role-runtime.ts`; role state, input transforms, tool registration/gating, singleton termination, and Judge audit acceptance live in `src/role-runtime.ts`.
- `src/soul-auditor.ts` already supplies the active-provider/model/auth transport and the print/JSON fatal pattern, but its policy, tool name, and input types are Judge-specific.
- Installed Pi is 0.82.1. It exports `parseSkillBlock` and `stripFrontmatter`; native skill expansion happens between `input` and `before_agent_start`, with the exact content preamble `References are relative to <baseDir>.` Pi also supports `executionMode: "parallel"` and `DefaultResourceLoader` discovery-disable options.
- Baseline remains green: 49 tests, typecheck, and dry-run pack all pass; the current tarball has eight files. Construction will not alter Judge, Fixer, or Coder contracts except for a narrow shared audit-transport extraction.

## Test-first construction sequence

1. **Specify the fourth role and its exact public contract first**
   - Add `test/reviewer-role.test.ts` and extend packaged help assertions before production changes.
   - Prove `--ak-role` accepts and documents all four roles and registers `--ak-review-task`; Reviewer requires one non-empty opaque Markdown file and has no phase, commit, approval, routing, or next-role field.
   - Define `ak_reviewer_output` with its own exact TypeBox/runtime schema, not `workerOutputSchema`: only `{status: "completed"|"refused", report: nonblank Markdown}` with `additionalProperties: false`.
   - Prove Reviewer Soul/task injection and the exact registered parent intersection, in order: `read`, `grep`, `find`, `ls`, `bash`, `Agent`, `ak_reviewer_output`. Assert `write`, `edit`, arbitrary extensions, and other role outputs are inactive.
   - Prove the output is the sole tool call in its assistant batch, terminates only on acceptance, supports revise then resubmission, and carries no orchestration semantics.

2. **Implement native canonical-Skill provenance rather than transcript matching**
   - Add a Reviewer-specific canonical binding helper, wired through `src/role-runtime.ts` dependencies, that resolves and reads exactly `~/.agents/skills/code-review/SKILL.md` at activation and retains the raw snapshot, real path, base directory, and `stripFrontmatter(snapshot).trim()` body. Do not package any copy of it.
   - Transform the first normal Reviewer input to `/skill:code-review <original request>` and retain that exact original request. In the immediately following `before_agent_start`, inspect `event.prompt`—the post-expansion prompt—not the serialized transcript.
   - Parse it with Pi’s exported `parseSkillBlock` and accept evidence only when all fields match the activation snapshot exactly: name `code-review`; location equal to the resolved canonical real path; content equal to Pi’s reference preamble plus the complete frontmatter-stripped body; and `userMessage` equal to the appended original request. Store the structured evidence for audit.
   - Make missing/unreadable canonical Skill or a failed/mismatched first native expansion an infrastructure failure. Copied markers in the opaque task, assistant prose, later messages, alternate-path same-name Skills, and partial bodies can never populate the evidence record. Unit and real-Pi tests will cover each spoof case.
   - Keep refusal mechanically available before Skill/Agent execution for direct runtime use; completed always requires valid native expansion evidence.

3. **Add the narrow, parallel `Agent` seam and attempt ledger**
   - Create `src/reviewer-agent.ts` with one injectable interface used unchanged by production and fakes, for example `runReviewerAgent({description, prompt}, {context, signal})`.
   - Register `Agent` only for Reviewer with the conventional exact schema: `subagent_type: "general-purpose"`, `description`, and `prompt`, with no extra fields. Set `executionMode: "parallel"`; expose no model choice, cwd, chain, discovery, role, or recursion controls.
   - Record every attempt before awaiting it: id, description, prompt, status (`running|successful|failed`), target/ref snapshot when available, final nonblank report, usage, diagnostics, and workspace disposition. A substantive nonblank child report is successful even if it reports that an axis cannot be performed.
   - Gate completed on valid Skill evidence, at least one successful Agent call, no running attempts, and every attempted call successful. Refused does not require Skill/Agent evidence but still undergoes audit.

4. **Prepare one immutable fixed-point snapshot and isolated writable leg clones**
   - Lazily initialize one concurrency-safe session promise on the first Agent call, allowing honest pre-Agent refusal. Resolve the original repository root and pin its current `HEAD` SHA once.
   - Build a temporary bare mirror/object snapshot without changing the source repository. Capture the pinned target plus exact source `refs/heads/*`, `refs/tags/*`, and `refs/remotes/*`; add any synthetic target ref only inside the temporary mirror so detached/unadvertised `HEAD` remains reachable. Verify the mirror contains the pinned target and exact ref/object map, then remove its usable source remote configuration.
   - Create each leg from that immutable mirror into a distinct temporary workspace. Preserve/recreate the captured refs exactly, remove remote configuration directly rather than using `git remote remove` (which would delete matching refs), convert to a normal worktree as needed, detach at the one target SHA, and verify target plus every captured ref before starting the child.
   - This lets the Skill’s captured three-dot diff/log commands resolve local branches, tags, and remote-tracking names against the same snapshot in every leg while leaving no usable push/fetch target. Tests will cover each ref class and prove siblings share one target/ref map but have different clones.
   - Successful legs are disposed and deleted. Preparation/child failures retain diagnostically useful temporary state and report its path; session shutdown cleans the shared successful snapshot. No workspace is attributed to the no-tool compliance audit.

5. **Run children in-process with exact isolation and inherited dispatch**
   - Use Pi’s documented `DefaultResourceLoader` with `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, and `noContextFiles`, plus in-memory session/settings. Supply exactly `read`, `grep`, `find`, `ls`, `bash`, `write`, and `edit`; verify the provider-visible list and absence of `Agent` and every `ak_*_output`.
   - Create a fresh `createAgentSession()` history for every call, rooted at its writable clone. The child prompt is operational governance only: inspect/probe in that clone, do not repair the product, commit, push, or mutate remotes, and distinguish scratch artifacts from reviewed-target facts. Standards/Spec prompts and review mechanics remain solely in the expanded Skill.
   - Resolve the parent’s current effective provider implementation, model, auth, base URL, headers, provider env, and thinking level into a small child `ModelRuntime`. Bridge the parent signal to clone commands and `session.abort()`, always dispose the session, return one nonblank final report, and aggregate the child usage exactly once on the Agent tool result.
   - Classify Git/temp preparation, canonical-Skill loading, auth/provider/session transport, cancellation, malformed/blank child output, and cleanup failures as infrastructure—not substantive review outcomes. Mark the attempt failed, preserve diagnostics, call `ctx.abort()`, set exit code 1 in print/JSON, and rethrow. Neither this path nor an audit infrastructure failure may be converted into or accept `refused`.

6. **Prove the Agent behavior through the real seam**
   - Add `test/reviewer-agent.test.ts` using temporary Git repositories and routed faux providers.
   - Drive two sibling Agent calls from one actual Pi assistant message and use a barrier/timestamps to prove overlap through Pi’s normal parallel execution.
   - Assert independent session ids/histories/workspaces, one shared target/ref snapshot, exact inherited provider/auth/base URL/headers/env/thinking level, exact child tools, final reports, cancellation, disposal, and one usage aggregation per child.
   - Have children write/edit fixtures and probes only in their clones; compare original bytes, refs, status, and HEAD before/after. Assert successful cleanup and failed-workspace preservation.

7. **Share audit transport narrowly, then add a distinct Reviewer policy**
   - Extract only active-model dispatch/auth resolution, provider invocation, cancellation, usage, and exact one-call `pass|revise` parsing from `src/soul-auditor.ts` into a small internal compliance transport. Preserve `createPiSoulAuditor()` and all Judge messages/behavior unchanged.
   - Add `src/reviewer-auditor.ts` with a separate decision tool and policy. It opens a fresh same-process, active-model context with no operational tools—only its exact decision tool—and receives the complete Reviewer Soul, complete raw canonical Skill snapshot, opaque review task, structured execution record, and candidate receipt.
   - Build the compact record from typed events, never transcript regexes: canonical Skill evidence; target/ref snapshot; relevant parent bash command/result pairs captured from `tool_call`/`tool_result` events (including demonstrated fixed-point resolution/diff/log evidence); every Agent prompt/result/status/usage/workspace disposition; and the candidate receipt.
   - The Reviewer policy checks only demonstrated method compliance, traceability, honest refusal, Standards/Spec isolation and skip handling, faithful aggregation, scratch-vs-target distinction, and role boundaries. It explicitly cannot discover findings, rerank axes, redo review, decide mergeability, route work, or act as a second substantive reviewer.
   - Run this audit before accepting either status. `revise` throws an ordinary resubmittable tool error; auth/provider/cancellation/malformed audit output uses the shared fatal abort/nonzero channel.

8. **Add the minimal Soul and documentation without copying method truth**
   - Add short `souls/reviewer.md` containing only irreducible professional judgment: establish authority and a fixed reviewed target, make claims traceable to target evidence, distinguish scratch probes from target facts, and remain independent of repair/publication/routing/final adjudication. Keep schemas, Skill steps, axis prompts, smell lists, runtime mechanics, and caller assumptions out.
   - Add Soul-layer tests for both required principles and forbidden copied mechanics, following `CLAUDE.md`.
   - Update `extensions/role-runtime.ts` loaders, `README.md`, and terminology-only `CONTEXT.md`: invocation with `--no-skills --skill ~/.agents/skills/code-review/SKILL.md`; exact receipt semantics; active-model/no-diversity statement; writable-clone governance; and the warning that this is operational isolation, not hostile-code security, so callers needing that must supply a sandbox/container.
   - Mention `reviewer-cmr` only as an unimplemented future AK CMR cross-model-panel concept. Add no role, schema, tools, model selection, or panel machinery for it.

9. **Exercise fatal paths and the installed tarball lifecycle**
   - Extend subprocess fixtures/tests for both print and JSON modes: child preparation/provider/session/malformed-output failures and Reviewer audit auth/provider/malformed decisions must exit nonzero, abort later turns, and never emit an accepted refusal or receipt. Keep Judge fatal tests green.
   - Build a real lifecycle test that creates `npm pack`, installs the resulting tarball in a temporary fixture, and activates its installed extension with `--no-skills --skill ~/.agents/skills/code-review/SKILL.md`.
   - Route a faux active provider through: exact native expansion provenance → one parent message containing two overlapping real Agent calls → child reports → first candidate audited as `revise` → corrected resubmission audited as `pass` → sole terminating `ak_reviewer_output` receipt.
   - Inspect the tarball/extracted install for Reviewer runtime and Soul, absence of every `SKILL.md`, and absence of copied code-review body/smell/prompt content.

10. **Final regression and delivery checks during apply**
   - Work red/green in the order above, then run focused tests, full `npm test`, `npm run typecheck`, `npm pack --dry-run --json`, CLI help checks for all four roles and `--ak-review-task`, subprocess fatal suites, and the installed-tarball lifecycle.
   - Perform same-pattern checks across all four singleton/terminating outputs, Judge/Reviewer audit fatal handling, Coder/Reviewer canonical-Skill binding, and role-specific tool gating. Inspect the final diff for introduced regressions and repeat the Soul-layer audit.
   - Create exactly one new forward commit after all behavior facts pass. Do not amend, rewrite, or push.
