## Revised construction packet

The original plan is approved in structure, but construction must incorporate the following three blocking corrections. All unmentioned steps remain unchanged.

### 1. Clone preparation must preserve fixed-point resolution

- **Reproducible failure:** I ran the proposed `git clone --no-checkout --no-hardlinks` → detached checkout → `git remote remove origin` sequence. Removal deleted `refs/remotes/origin/*`; branch names not checked out locally were unavailable. Thus a fixed point that resolves in the reviewed repository can fail inside both review legs.
- **Owning seam/invariant:** `src/reviewer-agent.ts` clone preparation owns the invariant that every leg is detached at one session-pinned target and can execute the canonical Skill’s captured fixed-point diff command against the same ref snapshot.
- **Why a simpler deletion is insufficient:** Merely retaining the local `origin` leaves a usable push target back to the original repository and still does not copy arbitrary source remote-tracking refs. Passing a new fixed-point field through `Agent` would violate the mandated conventional three-field interface and reimplement Skill parsing. The smallest compatible fix is a concurrency-safe session snapshot of target SHA plus source heads/tags/remote refs, recreation of those refs in each clone, removal/neutralization of usable remotes, detached checkout, and verification of target/ref resolution before child startup.
- **Required tests:** local branch, tag, and remote-tracking fixed points remain resolvable after remote removal; two sibling calls share one target/ref snapshot while using distinct clones.

### 2. Completed receipts need native Skill-expansion provenance

- **Reproducible failure:** Current Coder precedent in `src/role-runtime.ts` gates on a regex, and `test/judge-role.test.ts` accepts only an opening `<skill ...>` marker. That mechanism can be satisfied by copied task/assistant text and does not prove Pi expanded the canonical file. The proposed phrase “complete canonical expansion” is not precise enough to prevent repeating this defect.
- **Owning seam/invariant:** Reviewer first-input handling and the completed-receipt gate own the invariant that Pi natively expanded the one canonical `~/.agents/skills/code-review/SKILL.md` snapshot for this review.
- **Why a simpler regex is insufficient:** Text search cannot establish message provenance, canonical path, or complete body equality. Pi 0.82.1 exports `parseSkillBlock`, and `before_agent_start` runs after native Skill expansion, so exact structured capture there is the smaller root fix rather than adding a second Skill implementation.
- **Required implementation/tests:** transform the first normal input to `/skill:code-review`; capture the immediately following expanded prompt; parse it structurally; require exact name, resolved canonical location, Pi reference preamble plus complete frontmatter-stripped canonical body, and appended original request. Store that evidence for the audit. Reject copied markers in the opaque task, assistant prose, later messages, alternate-path same-name Skills, and partial bodies. Never bundle/paraphrase the Skill.

### 3. Agent infrastructure failure must use the fatal channel, not `refused`

- **Reproducible failure in the proposed plan:** Step 3 classifies child `error`/`aborted`/no-report endings as ordinary failed attempts, while only audit failures are routed fatal. Because `completed` is then permanently barred, the runtime can only emit/attempt `refused`, contrary to the explicit rule that infrastructure failures are not refusals.
- **Owning seam/invariant:** Reviewer Agent execution and submission lifecycle own the distinction between (a) a successful child report that substantively cannot establish target/spec/authority and may support audited refusal, and (b) Skill loading, Git/temp preparation, auth/provider/session, cancellation, or malformed child/audit transport failure, which must abort the action and exit nonzero in print/JSON.
- **Why audit-only handling is insufficient:** `revise` is deliberately an ordinary resubmittable tool error and cannot create the required nonzero infrastructure channel. This distinction must be mechanical before receipt acceptance.
- **Required implementation/tests:** record every attempt before awaiting it; preserve useful failed-workspace diagnostics; propagate cancellation to clone commands and `session.abort()`; route the infrastructure classes above through the existing abort/process-exit pattern; retain the independent completed gate requiring at least one success and no failed/running attempts. A child that returns a nonblank substantive report is successful even when it says an axis cannot be performed. Add print/JSON subprocess tests for child and audit infrastructure failures and prove neither produces an accepted refusal.

### Required clarifications to the retained plan

- Build children with Pi’s documented `DefaultResourceLoader` using `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, and `noContextFiles`, in-memory session/settings, and exactly `read`, `grep`, `find`, `ls`, `bash`, `write`, `edit`. This is necessary because default discovery can load global/project extensions and can override even an allowlisted built-in name. Test the provider-visible tool list and absence of `Agent`/`ak_*_output`.
- Keep `Agent` exact (`subagent_type: "general-purpose"`, `description`, `prompt`, no extras) and explicitly parallel-capable. Resolve the parent’s current effective provider/model/auth/base URL/headers/env and thinking level into the small in-process child runtime; test the real dispatch seam, cancellation, final nonblank report, disposal, and single usage aggregation.
- Build the compliance input from structured events/records, not transcript regexes: Skill evidence, target/ref snapshot, demonstrated parent fixed-point command/result pairs, every Agent prompt/result/status/usage/workspace disposition, and candidate receipt. The distinct Reviewer policy receives the Soul, complete canonical Skill snapshot, opaque task, and record; it has only its exact decision tool and cannot redo/rerank review or decide mergeability.
- Make `ak_reviewer_output` an independent exact schema, not the worker schema. Update `--ak-role` help to list all four roles and assert `--ak-review-task`; Reviewer has no phase, commit, routing, approval, or next-role semantics.
- The real packed lifecycle test must create/install the tarball, activate Reviewer with `--no-skills --skill ~/.agents/skills/code-review/SKILL.md`, and cross expansion → two overlapping real Agent calls → audit revise/resubmit → terminating receipt. Inspect the tarball for Reviewer runtime/Soul and absence of all `SKILL.md`/copied code-review content.

## Repair-surface audit

- **Original task-required surface:** Reviewer CLI/runtime/output, canonical Skill binding, internal Agent, isolated writable clones, method audit, short Soul, docs, mandatory behavior tests, package lifecycle, and one forward commit.
- **Necessary adaptation surface:** narrow shared extraction of existing audit auth/dispatch/exact-decision parsing; clone ref snapshot required by remote removal; Reviewer-specific execution record/policy; fatal propagation for Reviewer-owned infrastructure. Keep Judge behavior unchanged.
- **No-evidence/new-mechanism surface—exclude it:** generic agent discovery, chains/panels/model selection, role routing, generic clone engine, security sandbox, copied review prompts/method/smell lists, Reviewer phase, CMR implementation, broad audit framework, or workspaces purportedly owned by the no-tool compliance audit. Do not add these.

Final verification remains: focused red/green tests, full `npm test`, typecheck, dry-run pack, CLI help, installed-tarball lifecycle, Judge/Fixer/Coder regressions, final diff/Soul-layer audit, then exactly one new forward commit without amend or push.
