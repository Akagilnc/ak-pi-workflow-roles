# @akagilnc/pi-workflow-roles

Packaged workflow roles for [Pi](https://pi.dev): `judge`, `fixer`, `coder`, `reviewer`, `collector`, `doctor`, `merger`, `notary`, `analyst`. 中文说明见 [README.zh-CN.md](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/README.zh-CN.md)。

## Install

Install through Pi so the CLI and runtime come from the same package copy, and add Pi’s private npm bin to `PATH` once:

```bash
pi install npm:@akagilnc/pi-workflow-roles
export PATH="$HOME/.pi/agent/npm/node_modules/.bin:$PATH"
```

Update with `pi update npm:@akagilnc/pi-workflow-roles`—never a second global `npm install -g`. Inspect with `ak-role roles` and `ak-role help <role>`; set per-seat model defaults with `ak-role config set <seat> <provider/model[:thinking]>` (callable seats plus automatic `gatekeeper` / `inspector` / `navigator`); clear a Menxia officer override with `ak-role config unset <gatekeeper|inspector|notary>`; set or clear a persistent labor engine (callable roles) with `ak-role config set-engine <seat> <name>` / `ak-role config unset-engine <seat>`.

## Reading results

`ak-role` is the only supported way to call the package. Every run writes its complete Terminal result to stdout—read or redirect it there, never scrape Pi session files:

```bash
ak-role judge --attach ./plan.md "Review this plan." > result.txt
```

Exit status reports lifecycle honesty, not business success: every lawful typed result (including `audit_escalation`) exits zero; a failure without a lawful result exits nonzero, and its Terminal carries the Error Artifact ref and original cause instead of a fabricated receipt.

`ak-role resume <runId>` reopens that run's exact Pi session. Whether to resume is the caller's decision: the command does not require a typed HTTP 429 or a `resumable` state. Unknown run IDs and missing session principals are rejected. Collector, Doctor, and Notary remain one-shot. The package never auto-switches providers; override the model for one run with the global flags.

Judge, coder, fixer, reviewer, and merger also retry a non-lawful LLM call in place (same `runId` and session) up to `autoResumeLimit` times. Unset defaults to 2; `ak-role config set-auto-resume-limit <N>` writes the ceiling (`0` disables). Lawful typed terminals (`accepted`, `audit_escalation`, `no_receipt`) stop immediately. Manual `ak-role resume` stays available.

Global overrides work before or after the role: `ak-role --model <provider/model[:thinking]> resume <runId>`.

Every run also prepares Navigator advice in the same Terminal. Configure seats like this:

```bash
ak-role config set judge <provider/model[:thinking]>
ak-role config set navigator <provider/model[:thinking]>
# Menxia officers (automatic on submission; not caller commands except direct notary)
ak-role config set gatekeeper <provider/model[:thinking]>
ak-role config set inspector <provider/model[:thinking]>
ak-role config set notary <provider/model[:thinking]>
ak-role config unset gatekeeper
# persistent labor engine (callable roles; not navigator); one-shot override remains --engine
ak-role config set-engine judge opus
ak-role config unset-engine judge
ak-role config set-auto-resume-limit 3
```

`config set` stores the seat model default. For Menxia officers (`gatekeeper` / `inspector` / `notary`) resolution is officer pin → province (`gatekeeper`) pin → inherit parent session; an explicit selection that fails is loud and does not fall back. `config unset` clears only those officer overrides. `config set-engine` / `unset-engine` store or clear the persistent labor-engine name on callable roles (same seats as `--engine`; navigator refused — no independent activation). `config set-auto-resume-limit` stores the single-call auto-resume ceiling. Usage and refusal text are owned by `ak-role config` / `ak-role help config`.

Receipts are typed, so callers compose roles without parsing prose; ordering and stopping stay caller-owned. Programmatic consumers derive contracts from the exported schemas in `src/package-contracts/`, not from this guide.

### Menxia submission gate

On completing-side submissions the package may spawn the Menxia province before the run settles: `gatekeeper` reads the subject and dispatches an officer (`inspector` or `notary`); existing auditor hooks stay where already wired. The gate runs inside the submission session; bounce means rewrite-and-resubmit in that same session — not role failure; the final receipt is the post-gate product. `planned` / `refused` / `unfinished` skip the province. Pointers only: [ADR 0067](docs/adr/0067-menxia-province-founding-jishizhong-fubaolang.md), [ADR 0072](docs/adr/0072-menxia-pre-pr-submission-hooks.md). Do not scrape session prose for gate status.

When a labor-engine detour fails and the seat continues the labor on the main road, the typed receipt may carry a mechanical `engineLaborFallback` field: `{ engine, failure, laborBy: "seat" }`. It appears only after a real detour failure that fell back to seat labor—not on detour success or caller cancel. First failure wins for the activation; model-forged `engineLaborFallback` keys are stripped unless the package latch recorded one. Sole producer: `src/engine-labor-fallback.ts`; decision record: [ADR 0071](docs/adr/0071-engine-detour-failure-seat-fallback-declaration.md). This README only projects that contract.

## Call the roles

Public option identity, aliases, requiredness, and mode faces live in the generated [Public CLI options](#public-cli-options-generated) table and in `ak-role help <command>` — both project the same typed source. The examples below are usage sketches, not a second flag contract. An instruction is optional for judge, collector, and doctor; notary admits no caller prompt or attachment; analyst is deterministic (see help). Required nonblank for coder, fixer, reviewer, and merger.

```bash
# judge — adjudicate the supplied materials; infers its burden, no burden flag
ak-role judge --attach ./findings.md --attach ./adr.md "Adjudicate every finding."

# coder — first implementation; phase defaults to apply, or pass plan
ak-role coder plan "Propose the first implementation plan."
ak-role coder apply --attach ./plan.md "Implement the approved slice."
# apply binds the package-owned TDD method; do not bind a home Skill as a substitute

# reviewer — fixed-target two-axis review (Standards + Spec)
ak-role reviewer --base main "Review the branch against the governing issue and repository authority."
# --base is required and pins the fixed point; Reviewer does not accept --attach
# completed ≠ approved — read the findings in the Terminal

# collector — GitHub PR review evidence; github.com only, needs gh auth; one-shot
ak-role collector --pr 42 --repo owner/repository
# repo defaults from origin; --repo owner/repo overrides

# fixer — repair the assigned findings; phase defaults to apply, or pass plan
ak-role fixer --attach ./findings.md --prerequisites ./prereqs.json "Repair the findings."
# --prerequisites is a JSON array of {id, requirement}; malformed grammar exits 2
# apply/resume mount the package-owned diagnosis and TDD methods from the install; neither is forced into the prompt

# doctor — diagnose one retained case; one-shot
ak-role doctor --issue 115 "Diagnose this retained case."
# --runs must stay project-relative: .ak-roles/books/<book>/issues/<n>/runs matching --issue

# merger — resolve one merge already in conflict (start it first with Git’s ort)
ak-role merger --project /path/to/worktree "Reconcile the active merge."
# hands new intent/authority questions back instead of inventing authority

# notary — document-fidelity check on one retained source run; zero prompt/attachment; one-shot
ak-role notary --source-run <runId@role|path>

# analyst — deterministic metrics over the book (cwd git common-dir); bare = whole book
ak-role analyst
ak-role analyst --ticket <N>
ak-role analyst sweep --attach ./payload.md
ak-role analyst --cohort \
  --group-a-label A --group-a-issues 1,2 \
  --group-b-label B --group-b-issues 3,4
```

## Names

Roles are named after Tang/Song offices; the full roster and naming rule live in [README.zh-CN.md](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/README.zh-CN.md).

## Codex fast tier

Enable fast tier with `echo "fast_mode = on" > ~/.pi-codex-fast`; disable it with `echo "fast_mode = off" > ~/.pi-codex-fast` (or delete the file). The change takes effect on the next request without a restart. Fast tier costs more than the default tier.

<!-- BEGIN GENERATED: public-cli-options -->
## Public CLI options (generated)

Generated from `src/public-cli/option-definitions.ts`. Prefer `ak-role help <command>`. Do not hand-edit this section.

### `global`

| Spelling | Aliases | Value | Required | Repeatable | Form | Modes/Phases | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--model` | — | `provider/model` | no | no | option | — | Override the effective seat model for this invocation (before or after the command). |
| `--thinking` | — | `level` | no | no | option | — | Override thinking level: off\|minimal\|low\|medium\|high\|xhigh\|max. |
| `--engine` | — | `name` | no | no | option | — | Optional labor engine for this invocation (owner pool-directive name; packaged notes attached when present; any role). |
| `--help` | `-h` | — | no | no | option | — | Show public CLI help and exit. |

### `judge`

| Spelling | Aliases | Value | Required | Repeatable | Form | Modes/Phases | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--project` | — | `path` | no | no | option | — | Project root for ledger identity (defaults to process cwd). |
| `--attach` | — | `path` | no | yes | option | — | Attach a regular file; frozen at admission (repeatable). |

### `coder`

| Spelling | Aliases | Value | Required | Repeatable | Form | Modes/Phases | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `plan\|apply` | `plan`, `apply` | — | no | no | positional | phases=plan\|apply; default=apply | Optional phase token before the instruction; defaults to apply. |
| `--project` | — | `path` | no | no | option | — | Project root for ledger identity (defaults to process cwd). |
| `--attach` | — | `path` | no | yes | option | — | Attach a regular file; frozen at admission (repeatable). |

### `fixer`

| Spelling | Aliases | Value | Required | Repeatable | Form | Modes/Phases | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `plan\|apply` | `plan`, `apply` | — | no | no | positional | phases=plan\|apply; default=apply | Optional phase token before the instruction; defaults to apply. |
| `--project` | — | `path` | no | no | option | — | Project root for ledger identity (defaults to process cwd). |
| `--attach` | — | `path` | no | yes | option | — | Attach a regular file; frozen at admission (repeatable). |
| `--prerequisites` | — | `path` | no | no | option | — | JSON array of {id, requirement} prerequisite objects. |

### `reviewer`

| Spelling | Aliases | Value | Required | Repeatable | Form | Modes/Phases | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--project` | — | `path` | no | no | option | — | Project root for ledger identity (defaults to process cwd). |
| `--base` | — | `revision` | yes | no | option | — | Required fixed-point revision for the pinned review target. |
| `--authority-ref` | — | `ref` | no | yes | option | — | Durable authority reference/URL (repeatable; refs only, not inline prose). |

### `collector`

| Spelling | Aliases | Value | Required | Repeatable | Form | Modes/Phases | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--project` | — | `path` | no | no | option | — | Project root for ledger identity (defaults to process cwd). |
| `--attach` | — | `path` | no | yes | option | — | Attach a regular file; frozen at admission (repeatable). |
| `--pr` | — | `number` | yes | no | option | — | Required positive GitHub pull request number. |
| `--repo` | — | `owner/repo` | no | no | option | — | GitHub owner/repo override (defaults from origin when github.com). |
| `--request-manifest` | — | `path` | no | no | option | — | Optional request manifest JSON path ({requests:[{id,body}]}). |

### `doctor`

| Spelling | Aliases | Value | Required | Repeatable | Form | Modes/Phases | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--project` | — | `path` | no | no | option | — | Project root for ledger identity (defaults to process cwd). |
| `--attach` | — | `path` | no | yes | option | — | Attach a regular file; frozen at admission (repeatable). |
| `--issue` | — | `number` | yes | no | option | — | Required positive issue number for the retained case. |
| `--runs` | — | `path` | no | no | option | — | Optional project-relative .ak-roles/books/<book>/issues/<n>/runs override matching --issue. |

### `merger`

| Spelling | Aliases | Value | Required | Repeatable | Form | Modes/Phases | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--project` | — | `path` | no | no | option | — | Project root with one ordinary in-progress merge (defaults to cwd). |
| `--attach` | — | `path` | no | yes | option | — | Attach a regular file; frozen at admission (repeatable). |

### `notary`

| Spelling | Aliases | Value | Required | Repeatable | Form | Modes/Phases | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--project` | — | `path` | no | no | option | — | Project root for ledger identity (defaults to process cwd). |
| `--source-run` | — | `runId@role\|path` | yes | no | option | — | Required source run locator (runId@role under the book home, or path to that run directory). Zero prompt/attachment projection. |

### `analyst`

| Spelling | Aliases | Value | Required | Repeatable | Form | Modes/Phases | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `sweep` | — | — | no | no | positional | modes=sweep | Optional sweep mode token (at most once; no other positionals). |
| `--ticket` | — | `number` | no | no | option | modes=issue | Ticket/issue number; live filter by invocation.ticketNumber inside the cwd book (git common-dir). Bare call = whole book. No library-index bootstrap. |
| `--attach` | — | `path` | when:sweep | yes | option | modes=sweep; max=sweep:1 | Sweep-mode attachment path; required exactly once in sweep; payload is the attachment body. |
| `--cohort` | — | — | no | no | option | modes=cohort | Select cohort mode. |
| `--group-a-label` | — | `label` | when:cohort | no | option | modes=cohort | Cohort group A label (required in cohort mode). |
| `--group-a-issues` | — | `N\|book:N[,...]` | when:cohort | no | option | modes=cohort | Cohort group A issues: bare N joins cwd book; book:N selects another book; escape a literal comma/backslash in a book key as \, / \\ (required in cohort mode). |
| `--group-b-label` | — | `label` | when:cohort | no | option | modes=cohort | Cohort group B label (required in cohort mode). |
| `--group-b-issues` | — | `N\|book:N[,...]` | when:cohort | no | option | modes=cohort | Cohort group B issues: bare N joins cwd book; book:N selects another book; escape a literal comma/backslash in a book key as \, / \\ (required in cohort mode). |
<!-- END GENERATED: public-cli-options -->
