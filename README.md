# @ak/pi-workflow-roles

Packaged workflow roles for [Pi](https://pi.dev). Supported roles: `judge`, `fixer`, `coder`, `reviewer`, `collector`, and `doctor`.

## Judge

The judge role:

1. loads the bundled [`souls/judge.md`](souls/judge.md) into the system prompt;
2. lets the active Pi model adjudicate with normal tools;
3. accepts a final verdict only through `ak_judge_output`;
4. runs a separate Soul-compliance model call before accepting the verdict;
5. returns a terminating structured tool result only after the audit passes.

The compliance call uses the active Pi model and credentials. It checks demonstrated procedural compliance with the Soul; it does not replace the judge's substantive finding decisions.

Judge infers its burden of proof from the supplied materials alone (authority completeness, plan construction-readiness, apply executable proof, or review finding adjudication).

On activation, Judge narrows active tools to the registered members of this exact whitelist: `read`, `grep`, `find`, `ls`, `bash`, and `ak_judge_output`. In particular, `write`, `edit`, and arbitrary sibling tools are inactive. This is role gating to prevent accidental role drift, not a security boundary; callers that need isolation must provide a sandbox or container.

## Install

Project-local installation:

```bash
pi install -l /absolute/path/to/ak-pi-workflow-roles
```

Temporary invocation without installation:

```bash
pi -e /absolute/path/to/ak-pi-workflow-roles \
  --ak-role judge \
  --mode json \
  -p "Judge the supplied review materials."
```

After installation:

```bash
pi --ak-role judge --mode json -p "Judge the supplied review materials."
```

The caller should treat the successful `ak_judge_output` tool result as the authoritative receipt. Plain assistant text is not a completed judge verdict.

## Fixer

The fixer role loads `souls/fixer.md` plus the caller-supplied Markdown repair packet, then repairs/tests or returns an evidence-bearing refusal:

The CLI advertises the complete phase vocabulary in `pi --ak-role fixer --help`:

| `--ak-fixer-phase` | Meaning | Legal success status |
| --- | --- | --- |
| `plan` | Inspect and propose a repair plan; do not edit or commit | `planned` |
| `apply` | Execute the approved plan, verify, and commit when repaired | `completed` |

There is no third phase. Either phase may return `refused` with evidence.

```bash
pi --ak-role fixer \
  --ak-fixer-phase plan \
  --ak-fix-packet /path/to/fix-packet.md \
  -p "Prepare the repair plan."

pi --ak-role fixer \
  --ak-fixer-phase apply \
  --ak-fix-packet /path/to/approved-fix.md \
  -p "Apply the approved repair plan."
```

Fixer terminates through `ak_fixer_output`. Its legal status-dependent shapes are:

```json
{"status":"planned","report":"Markdown report"}
{"status":"completed","report":"Markdown report","commitSha":"optional self-report","classesRepaired":[{"name":"ClassName","searchScope":"non-empty census scope","exceptions":[{"where":"explicit location","reason":"non-empty reason"}]}]}
{"status":"refused","report":"Markdown report","commitSha":"optional self-report"}
```

`classesRepaired` is optional and completed-only; when present it is non-empty, has unique comma-free nonblank names, nonblank search scopes, and explicit exception arrays (which may be empty). `planned` cannot carry `commitSha`. Otherwise `commitSha` is advisory evidence for the caller, not a hard gate. Fixer never emits `escalate`; requested owner decisions return as `refused` evidence for the caller to dispose. The caller owns the next step after the receipt (and may or may not involve Judge).

Fixer-only bash seatbelt (both `plan` and `apply`): before a `bash` tool executes, the package inspects only the string `command` and blocks when it case-sensitively contains any one of these exact ASCII literals — `rm -rf`, `git reset --hard`, `git clean`, `git checkout --`. The block is an ordinary nonterminating tool error that names the matched literal; bash does not run, the Fixer session stays alive, and the model may retry a different spelling/operation or submit `refused`. This is accidental-destruction drift prevention only — not hostile-code defense, shell sandboxing, filesystem isolation, or bypass resistance. Callers that need isolation must supply a container or sandbox.

## Coder

Coder handles first implementation in two explicit phases:

| `--ak-coder-phase` | Meaning | Legal success status |
| --- | --- | --- |
| `plan` | Inspect the task and propose an implementation plan; do not edit or commit | `planned` |
| `apply` | Execute the approved plan and verify the first implementation | `completed` |

Either phase may return `refused` with authority and current-code evidence. A refusal does not require a commit and returns to the caller for disposition; Coder never emits `escalate`.

```bash
pi --ak-role coder \
  --ak-coder-phase plan \
  --ak-coder-task /path/to/task.md \
  -p "Prepare the implementation plan."

pi --no-skills \
  --skill ~/.agents/skills/tdd/SKILL.md \
  --ak-role coder \
  --ak-coder-phase apply \
  --ak-coder-task /path/to/approved-plan.md \
  -p "Apply the approved implementation plan."
```

Coder terminates through `ak_coder_output` with the same thin worker envelope:

```json
{"status":"planned|completed|refused","report":"Markdown report","commitSha":"optional self-report"}
```

During `apply`, the runtime transforms the first input through Pi's native `/skill:tdd`. Use `--no-skills --skill ~/.agents/skills/tdd/SKILL.md` to bind the canonical Matt TDD skill without name collisions. A `completed` receipt is rejected unless the immediately following prompt proves Pi's exact native expansion of the complete canonical TDD Skill and original request; an evidence-bearing `refused` receipt does not require that proof or a commit.

The completed report must preserve TDD evidence plus the same-pattern, introduced-regression, and behavior-fact self-check results for the caller. These are report/audit requirements, not a second bundled Skill. `commitSha` remains advisory evidence rather than a hard package gate.

## Reviewer

Reviewer performs a fixed-target, two-axis code review through the canonical external Skill at `~/.agents/skills/code-review/SKILL.md`. The package does not bundle or reproduce that method. Bind it explicitly and provide both the existing non-empty opaque Markdown task and a mandatory narrow V1 capability file bound to the task's exact bytes:

```bash
pi --no-skills \
  --skill ~/.agents/skills/code-review/SKILL.md \
  --ak-role reviewer \
  --ak-review-task /path/to/review-task.md \
  --ak-review-capabilities /path/to/review-capabilities.json \
  -p "Review the requested fixed point."
```

The authoritative capability contract and validation live in the exported TypeScript API in [`src/reviewer-dispatch.ts`](src/reviewer-dispatch.ts). The authoritative `Agent` input contract is the exported runtime `reviewerProposalSchema` in [`src/reviewer-role.ts`](src/reviewer-role.ts), with its corresponding TypeScript proposal type in `reviewer-dispatch.ts`. Callers should derive validation and proposal construction from those exports rather than this invocation guide.

Reviewer terminates with this exact receipt:

```json
{"status":"completed|refused","report":"non-empty Markdown"}
```

`completed` means the requested review was completed; it says nothing about findings, approval, routing, mergeability, or the next role. `refused` is an evidenced inability to establish the review target, authority, or factual premise. Infrastructure failures instead abort the action and exit nonzero. Both statuses undergo a separate active-model, no-operational-tool method-compliance audit; `revise` permits corrected resubmission.

`reviewer-cmr` is reserved terminology for a possible future AK CMR cross-model-panel role. It is not implemented and Reviewer exposes no panel or model-selection machinery.

## Collector

Collector is a standalone external-GitHub PR evidence collection role. It observes explicitly configured reviewer legs, optionally requests them, classifies collection terminality (`valid` | `unavailable` | `missing`), preserves evidence across HEAD moves, and submits one self-contained receipt through `ak_collector_output`. It is not Reviewer or Judge and never reviews code, repairs, writes code, pushes, merges, approves, or routes.

v1 supports `github.com` only. There is no default leg/bot: callers must supply an explicit non-empty leg manifest. Owner/repo uses a conservative ASCII grammar (owner 1–39, repo 1–100). Enterprise hosts, interactive/RPC mode, resume/continue, and later prompts are unsupported.

**Collector forbids every Skill**, including command-only Skills (`disable-model-invocation: true` / prompt-excluded but command-present). Skills are not part of the supported Collector surface.

Supported one-shot launch profile (required shape):

```bash
pi --no-extensions -e <package-extension> --no-skills --no-prompt-templates \
  --no-context-files --no-session --mode json --ak-role collector \
  --ak-collector-repo <owner/repo> --ak-collector-pr <n> \
  --ak-collector-legs <manifest.json> -p "Start collection."
```

That profile means: `--no-skills`; `--no-extensions` with only the explicit Collector package extension; no prompt templates; no context files; exactly one print/JSON prompt. Do not load Skills, ambient extensions, prompt templates, or context files alongside Collector.

Machine-readable manifest schema: [`schemas/collector-legs-v1.schema.json`](schemas/collector-legs-v1.schema.json).

Runtime behavior highlights:

- only four tools are active: `ak_collector_observe`, `ak_collector_request`, `ak_collector_wait`, `ak_collector_output`;
- external GitHub text is data-only evidence and cannot change target, legs, policy, or tools;
- eligibility cutoff is 15 minutes from first model dispatch (request/wait gate; final observe/output may finish afterward);
- hard limits: 8 MiB UTF-8 normalized evidence per complete snapshot and 32 MiB per self-contained receipt/invocation materialization; overflow fails non-zero without truncation;
- successful receipts embed `snapshots[]` and `evidenceRecords[]` so every evidence ref resolves inside the tool-result details;
- request attempts are process-local at-most-once per `(repo, PR, HEAD, leg)` with a deterministic HTML correlation marker; concurrent independent Collector processes can still race and duplicate comments—serialize callers when that is unacceptable;
- requires ambient `gh` authentication for `github.com` and model credentials; role gating is drift prevention, not a security boundary;
- on Pi 0.82.1, a late hostile sibling-extension injection into `before_agent_start` `systemPromptOptions.skills` is unsupported and fail-closed when detected; that path is not a normally discovered Skill, is not a security boundary, and does not imply a provider-zero guarantee;
- current orchestrator wiring is unsupported and requires a separately authorized migration plus thin adapter.

Failure channels (non-zero, no receipt) include malformed/unsupported config or mode, loaded Skills (including command-only), ambient instruction surfaces, non-OPEN final snapshot, transport/API/pagination/size/model failures, unrecovered request response loss, and later-input/output-singleton violations. There is no Collector `refused` status.

## Doctor

Doctor reads one retained Pi-native case and exposes only the bounded evidence reader plus its terminating output tool:

```bash
pi --no-extensions -e /path/to/extensions/role-runtime.ts \
  --ak-role doctor --ak-doctor-case .ak/work/issues/40/runs \
  --mode json -p "Produce this case's process-cost diagnosis."
```

Case identity is the issue number plus the resolved retained-runs path. Do not delete or rewrite run directories before Doctor examines them. Each recursive `*.jsonl` is one model-session leg; each immediate run directory is one caller invocation, and `stderr.log` remains evidence for invocations that died before a session header. `ak_doctor_evidence` pages exact admitted session bytes in chunks of at most 4096 characters; filesystem, shell, network, write, and Agent tools remain inactive.

The completed output is one case's cost report plus findings; it never requires a trend. Wall time runs from the session-header outer timestamp to the final accepted, non-error terminating `toolResult`, or to the last row and is labeled incomplete. Assistant message rows with `responseId` count model/API turns and their `usage.output` tokens are summed. Assistant `content[]` `toolCall` items count calls, including the terminal call. Retries are reported only as literal run-directory naming evidence. Status comes only from typed details on a non-error terminating result, never prose or an attempted call. Commits are observed typed session-row transitions; abbreviated SHAs retain their stated precision. Output bytes explicitly mean raw JSONL bytes; provider-wire bytes are unavailable, so token counts are reported separately.

Every number must exactly match the runtime's derivation from cited session bytes. The sole final `ak_doctor_output` result undergoes a fresh same-active-model compliance audit; revise permits resubmission, while audit or transport failure aborts without manufacturing refusal. Trend reporting is a separate output type for future multi-case readers.

## Verdict contract

Judge's legal status-dependent shapes are:

```json
{"judgeStatus":"converged"}
{"judgeStatus":"continue","fix":{"summary":"non-empty repair summary"},"classes":[{"name":"ClassName","owner":"owning seam","boundary":"bounded scope","disposition":"adjudication"}]}
{"judgeStatus":"escalate","decisionGate":{"question":"non-empty owner question","options":["non-empty option"]}}
```

A `continue` receipt requires non-empty `classes` with unique comma-free nonblank names and nonblank owner, boundary, and disposition fields. `classes` is forbidden on `converged` and `escalate` receipts. The shapes retain these meanings:

- `converged` — relative to the material under judgment (for a plan: construction authorization only)
- `continue` — further repair is warranted
- `escalate` — an owner decision is required

Any verdict may additionally carry an optional non-empty `note` Markdown string. It is an advisory addendum for important information or requirements that should remain separate from the status-specific fields (including apply obligations attached to a construction-ready plan). It has no built-in routing or execution semantics, and callers may ignore it without changing the existing verdict flow.

Workflow ordering and routing are caller-owned. A separate orchestrator is optional infrastructure, not a package requirement.

## Composing class-repair contracts

Callers may use the typed contracts together without parsing Markdown: a `continue` Judge receipt identifies non-empty `classes[]`; a completed Fixer receipt may report `classesRepaired[]`; and `--ak-review-scope-keys <comma-separated keys>` limits Reviewer to exact class keys (omit it for a full review). Keys are comma-free, case-sensitive bytes and are not normalized. The caller, not this package, enforces contextual presence or absence and exact order-insensitive set equality between Judge and Fixer names. These contracts do not mandate any role ordering, repetition, routing, or workflow topology.

## Recorder (`ak-docket-record`)

Recorder v2 seals one fresh persisted Pi v3 package-role session; it is not a generic child wrapper.

```bash
ak-docket-record --config recorder-v2.json -- pi --ak-role coder -p "Do the task"
```

The closed config has `version: 2` and adds `session: { directory, id }`. `directory` is a repository-relative path strictly below `.ak/work/`; `id` is a lowercase UUIDv7. Recorder exclusively creates the 0700 leaf and injects its absolute `--session-dir` and `--session-id`. Session/history/JSON/RPC flags are rejected. Exactly one `-p|--print` is required. See [`schemas/recorder-config-v2.schema.json`](schemas/recorder-config-v2.schema.json).

Recorder forwards stdout and stderr byte-for-byte with backpressure and retains only a 4096-byte tail per stream for bounded failure diagnostics. Pass-through bytes and raw main/Reviewer-leg sessions are **not credential-scanned** and are never promoted, copied, or deleted. Callers own sink security and raw-session access, retention, and cleanup. Only admitted declarations and promoted derivatives are scanned.

A successful docket contains the non-null accepted package Receipt, optional Judge/Reviewer audit observation, and [`recorder-manifest-v2`](schemas/recorder-manifest-v2.schema.json). Failures use [`recorder-failure-v2`](schemas/recorder-failure-v2.schema.json), exit 125, preserve known child exit/signal truth, and publish no partial docket. Publication is an atomic same-filesystem create-if-absent rename.
