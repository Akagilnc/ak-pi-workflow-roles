# @akagilnc/pi-workflow-roles

Packaged workflow roles for [Pi](https://pi.dev): `judge`, `fixer`, `coder`, `reviewer`, `collector`, `doctor`, `merger`. 中文说明见 [README.zh-CN.md](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/README.zh-CN.md)。

## Install

Install through Pi so the CLI and runtime come from the same package copy, and add Pi’s private npm bin to `PATH` once:

```bash
pi install npm:@akagilnc/pi-workflow-roles
export PATH="$HOME/.pi/agent/npm/node_modules/.bin:$PATH"
```

Update with `pi update npm:@akagilnc/pi-workflow-roles`—never a second global `npm install -g`. Inspect with `ak-role roles` and `ak-role help <role>`; set per-seat model defaults with `ak-role config set judge openai-codex/gpt-5.6-sol:high`; set or clear a persistent labor engine (callable roles) with `ak-role config set-engine <seat> <name>` / `ak-role config unset-engine <seat>`.

## Reading results

`ak-role` is the only supported way to call the package. Every run writes its complete Terminal result to stdout—read or redirect it there, never scrape Pi session files:

```bash
ak-role judge --attach ./plan.md "Review this plan." > result.txt
```

Exit status reports lifecycle honesty, not business success: every lawful typed result (including `audit_escalation`) exits zero; a failure without a lawful result exits nonzero, and its Terminal carries the Error Artifact ref and original cause instead of a fabricated receipt.

A run interrupted by a typed Codex/xAI HTTP 429 with no lawful result prints a complete `ak-role resume <runId>` command in its failure Terminal. Resume reopens the exact session; override the model for one run with the global flags. The package never auto-switches providers, only a typed 429 makes a run resumable, and unknown, terminal, or concurrently-resumed run IDs are rejected. Collector and Doctor are one-shot.

Global overrides work before or after the role: `ak-role --model xai/grok-4.5:high resume <runId>`.

Every run also prepares Navigator advice in the same Terminal. Configure it like any other seat:

```bash
ak-role config set navigator openai-codex/gpt-5.6-luna:medium
# persistent labor engine (callable roles; not navigator); one-shot override remains --engine
ak-role config set-engine judge opus
ak-role config unset-engine judge
```

`config set` stores the seat model default; `config set-engine` / `unset-engine` store or clear the persistent labor-engine name on callable roles (same seats as `--engine`; navigator refused — no independent activation). Usage and refusal text are owned by `ak-role config` in the public CLI.

Receipts are typed, so callers compose roles without parsing prose; ordering and stopping stay caller-owned. Programmatic consumers derive contracts from the exported schemas in `src/package-contracts/`, not from this guide.

When a labor-engine detour fails and the seat continues the labor on the main road, the typed receipt may carry a mechanical `engineLaborFallback` field: `{ engine, failure, laborBy: "seat" }`. It appears only after a real detour failure that fell back to seat labor (including package-owned idle timeout on the detour tool)—not on detour success or caller cancel. First failure wins for the activation; model-forged `engineLaborFallback` keys are stripped unless the package latch recorded one. Sole producer: `src/engine-labor-fallback.ts`; decision record: [ADR 0071](docs/adr/0071-engine-detour-failure-seat-fallback-declaration.md). This README only projects that contract.

## Call the roles

Public option identity, aliases, requiredness, and mode faces live in the generated [Public CLI options](#public-cli-options-generated) table and in `ak-role help <command>` — both project the same typed source. The examples below are usage sketches, not a second flag contract. An instruction is optional for judge, collector, and doctor, and required nonblank for coder, fixer, reviewer, and merger.

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

### `taishi`

| Spelling | Aliases | Value | Required | Repeatable | Form | Modes/Phases | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `sweep` | — | — | no | no | positional | modes=sweep | Optional sweep mode token (at most once; no other positionals). |
| `--project-root` | — | `path` | when:model-groups | yes | option | modes=issue\|model-groups; max=issue:1 | Project-root scope key. Issue: at most one (with --ticket at least one of the two). Model-groups: one or more required. |
| `--ticket` | — | `number` | no | no | option | modes=issue | Ticket/issue number for issue mode (with --project-root at least one of the two). |
| `--attach` | — | `path` | when:sweep | yes | option | modes=sweep; max=sweep:1 | Sweep-mode attachment path; required exactly once in sweep; payload is the attachment body. |
| `--cohort` | — | — | no | no | option | modes=cohort; xor=model-groups | Select cohort mode (mutually exclusive with --model-groups). |
| `--model-groups` | — | — | no | no | option | modes=model-groups; xor=cohort | Select model-groups mode (mutually exclusive with --cohort). |
| `--group-a-label` | — | `label` | when:cohort | no | option | modes=cohort | Cohort group A label (required in cohort mode). |
| `--group-a-issues` | — | `N[,N...]` | when:cohort | no | option | modes=cohort | Cohort group A comma-separated positive issue numbers (required in cohort mode). |
| `--group-b-label` | — | `label` | when:cohort | no | option | modes=cohort | Cohort group B label (required in cohort mode). |
| `--group-b-issues` | — | `N[,N...]` | when:cohort | no | option | modes=cohort | Cohort group B comma-separated positive issue numbers (required in cohort mode). |
<!-- END GENERATED: public-cli-options -->
