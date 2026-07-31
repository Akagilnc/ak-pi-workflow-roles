# @ak/pi-workflow-roles

Packaged workflow roles for [Pi](https://pi.dev). Supported roles: `judge`, `fixer`, `coder`, `reviewer`, and `collector`.

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

Fixer terminates through `ak_fixer_output`:

```json
{"status":"planned|completed|refused","report":"Markdown report","commitSha":"optional self-report"}
```

`planned` cannot carry `commitSha`. Otherwise `commitSha` is advisory evidence for the caller, not a hard gate. Fixer never emits `escalate`; requested owner decisions return as `refused` evidence for the caller to dispose. The caller owns the next step after the receipt (and may or may not involve Judge).

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

Reviewer performs a fixed-target, two-axis code review through the canonical external Skill at `~/.agents/skills/code-review/SKILL.md`. The package does not bundle or reproduce that method. Bind it explicitly and provide one non-empty opaque Markdown task:

```bash
pi --no-skills \
  --skill ~/.agents/skills/code-review/SKILL.md \
  --ak-role reviewer \
  --ak-review-task /path/to/review-task.md \
  -p "Review the requested fixed point."
```

The runtime transforms the first input through native `/skill:code-review` and verifies the complete expanded content against the canonical activation snapshot. Reviewer uses the active model/provider/auth and does not promise cross-model diversity.

The parent tool surface is narrowed to registered `read`, `grep`, `find`, `ls`, `bash`, `Agent`, and `ak_reviewer_output`. Each `Agent` call runs in-process with an independent history and writable temporary clone detached at one session-pinned target. Source heads, tags, and remote-tracking refs are preserved in every clone, while usable remotes are removed. Children may create probes and fixtures but must distinguish them from reviewed-target facts; successful workspaces are deleted and useful failure state is retained diagnostically. This is operational isolation, not hostile-code security. Supply a sandbox or container when security isolation is required.

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

## Verdict contract

- `converged` — relative to the material under judgment (for a plan: construction authorization only)
- `continue` with non-empty `fix.summary`
- `escalate` with `decisionGate.question` and non-empty `decisionGate.options`

Any verdict may additionally carry an optional non-empty `note` Markdown string. It is an advisory addendum for important information or requirements that should remain separate from the status-specific fields (including apply obligations attached to a construction-ready plan). It has no built-in routing or execution semantics, and callers may ignore it without changing the existing verdict flow.

Workflow ordering and routing are caller-owned. A separate orchestrator is optional infrastructure, not a package requirement.

## Composing class-repair contracts

Callers may use the typed contracts together without parsing Markdown: a `continue` Judge receipt identifies non-empty `classes[]`; a completed Fixer receipt may report `classesRepaired[]`; and `--ak-review-scope-keys <comma-separated keys>` limits Reviewer to exact class keys (omit it for a full review). Keys are comma-free, case-sensitive bytes and are not normalized. The caller, not this package, enforces contextual presence or absence and exact order-insensitive set equality between Judge and Fixer names. These contracts do not mandate any role ordering, repetition, routing, or workflow topology.

## Recorder (`ak-docket-record`)

Opt-in mechanical wrapper that runs one exact caller-supplied command once and, on success, atomically promotes a small core docket under a caller-selected archive Git worktree. It is not a role, orchestrator, model router, or Git mutator.

**Runtime:** Node.js **>= 20** on **darwin/linux** **x64/arm64** only (`package.json` `os`/`cpu`; other combinations are refused at package admission). The package ships a plain-ESM Recorder under `dist/`. `bin/ak-docket-record` launches `dist/recorder/cli.js` with no `tsx` dependency and no type-stripping under `node_modules`. Child signal death is re-raised as a real signal (not `128+n`).

**Native binding:** Docket publication uses a small N-API addon (`rename_no_replace.node`) built from packaged C source (`scripts/rename_no_replace.c`) via `scripts/build-rename-no-replace.mjs`. A working C compiler (`cc` on `PATH`) and Node.js N-API headers (`node_api.h`, normally next to the Node install under `include/node`) are required. Lifecycle:

- `npm run build:native` / package `install` — compile only the native binding for the installing host (no TypeScript toolchain);
- `npm run build:recorder` / `prepack` — compile Recorder TypeScript, then the native binding.

The publisher always compiles to a temporary artifact outside `dist` on the same filesystem as the destination and atomically renames it over `dist/recorder/rename_no_replace.node`, so concurrent readers never observe a truncated binding. A checked-in or prepacked foreign/stale `.node` must not be trusted: install rebuilds for the actual host.

### Grammar

```bash
ak-docket-record --config <json-path> -- <command> [args...]
```

There are no other Recorder flags. The first `--` ends Recorder syntax; every following argv element is the child argv, passed unchanged, without shell parsing. Empty child argv, missing/extra `--config`, unknown Recorder options, unreadable or non-closed JSON, invalid archive/declaration values, and path traversal/symlink escape fail before spawn.

### Config (version 1, closed object)

Mandatory keys: `version`, `archive`, `execution`, `declarations`, `provenance`.

- `archive.repositoryRoot` — absolute path to an existing archive Git worktree (may differ from child `cwd` and from referenced repositories).
- `archive.root` / `archive.docketId` — repository-relative slash paths with ordinary non-empty segments (no absolute paths, `.`/`..`, empty segments, or escape outside the worktree). Final identity is `repositoryRoot + root + docketId` and is create-if-absent only.
- `execution.cwd` — absolute existing directory used as the child cwd.
- `execution.environment` — `{ inherit, overrides, unset }`. Environment is exactly inherited-or-empty, then `unset`, then `overrides`. Duplicate unset names and unset/override overlap are invalid.
- `execution.stdin` — must be `"inherit"`.
- `declarations.gitReferences[]` — already-committed bytes identified only by repository root, full commit SHA, path, blob OID, and SHA-256. Dirty/untracked bytes cannot satisfy a reference. Cross-repository references require an explicit `repositoryRoot` and exact match in that repository.
- `declarations.externalInputs[]` / `exhibits[]` — absolute source paths with expected SHA-256; stored once after scan.
- At least one `authority` and one `task` kind must be declared (via git reference or external input).
- `provenance.package|model|target` — caller-supplied strings or `null`, recorded as **unverified**.

### Streams and outcomes

- Child stdout and stderr are teed byte-for-byte to the Recorder’s corresponding streams and private scratch; streams are not merged or re-encoded.
- The child is spawned exactly once, directly, without a shell, retry, command selection, routing, model, role, or Pi composition.
- **Success** means scan, admission, raw-scratch cleanup, and atomic promotion all completed. The promoted `manifest.json` records `recorder.status: "completed"` and the child outcome. Recorder emits no success diagnostic. If the child exited, Recorder exits with that exact status. If the child died from signal `S`, Recorder completes promotion then terminates itself with `S`.
- **Recorder failure** emits exactly one sanitized single-line JSON object on Recorder stderr after any already-teed child output, then exits **125**. Recorder failure has precedence over child nonzero/signal. Config/grammar failure reports `child.status: "not-spawned"`.

```json
{"recorder":{"status":"failed","code":"invalid-config","message":"invalid Recorder config","location":["declarations","gitReferences",1,"kind"],"diagnostic":null},"child":{"status":"not-spawned","exitCode":null,"signal":null,"diagnostic":null}}
```

The exact closed wire contract is [`schemas/recorder-failure-v1.schema.json`](schemas/recorder-failure-v1.schema.json). `recorder.location` is a typed string/index schema path for config defects (otherwise `null`). `recorder.diagnostic` is a bounded, allow-listed stage and category when an underlying cause exists (otherwise `null`); it never includes the exception message, stack, config, argv, or environment. Unknown exceptions use `internal-error`, never `invalid-config`. Consumers must use these fields rather than parse prose.

Final truth on success is the promoted manifest; on failure it is the stderr object plus 125. No final or partial manifest is written on Recorder failure. Ordinary failures attempt scratch/stage cleanup. Abrupt OS/process crash may leave ignored private scratch or a non-final staging directory — that is host cleanup/credential risk, never an apparently complete docket.

### Receipt extraction, scanning, and trust limits

Recorder extracts a Receipt only from a package terminating submission tool’s successfully accepted tool-result (`role: "toolResult"`, matching package tool name and call id, `isError: false`, details that pass that tool’s production validator). Supported tools: `ak_coder_output`, `ak_fixer_output`, `ak_reviewer_output`, `ak_judge_output`, `ak_collector_output`. Persisted-session and machine/JSON envelopes share one decoder. Absence of such a result is lawful and records no Receipt. Package-observed audit acceptance (Judge/Reviewer) is an observation attached to that accepted result, not a second Receipt.

Every promotable byte/metadata value crosses one bounded pattern scanner (authorization headers, Bearer/Basic, provider/package tokens, AWS keys, PEM/private keys, cookies/session credentials, credential-bearing URLs, conventional token/secret/password/API-key assignments). Unsupported opaque content is wholly replaced by one typed opaque-redaction record or fails closed. If scanning changes an accepted Receipt, the stored artifact is `sanitizedDerivativeOfAcceptedReceipt` and never claims byte equality to the accepted details. Redaction reports contain only rule id, structural location (without secret path/context values), and count.

This is **bounded pattern scanning, not semantic DLP**. Callers own input minimization and credential rotation. Accepted output/audit proves only package acceptance. Recording, declarations, Git coordinates, and digests do not prove truth, freshness, authenticity, authority, mergeability, future availability, or closure; a hostile host can fabricate archive bytes.

### Manifest facts

Versioned manifest records archive/docket and invocation identity; sanitized argv and execution-context identity; unverified provenance; every declared authority/task/input/exhibit with exactly one of verified reference identity or once-stored identity; accepted Receipt/sanitized derivative and audit observation when present; separate child outcome and successful Recorder completion; and redaction hits.

Already-committed bytes remain references and are not copied. Recorder never runs `git add`, commit, checkout, branch, merge, push, or permission/retention operations. Callers own declaration completeness, commit/push, permissions, retention, and downstream full-HEAD binding.

### Exclusions

No cold root, generic raw session/tool-event retention, second storage temperature, Git LFS, archive service, summarizer, model admission role, database, catalog, daemon, automatic Git mutation, or npm publication. Distribution is via this package’s `npm pack` contents and ADR 0009 git/local install paths.

Machine-readable promoted manifest schema: [`schemas/recorder-manifest-v1.schema.json`](schemas/recorder-manifest-v1.schema.json).

## Development

```bash
npm install          # rebuilds host native binding (needs cc + node_api.h)
npm run build:recorder
npm run typecheck
npm test
```
