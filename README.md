# @akagilnc/pi-workflow-roles

Packaged workflow roles for [Pi](https://pi.dev): `judge`, `countersign`, `gleaner-left`, `fixer`, `coder`, `reviewer`, `collector`, `doctor`, `merger`, `notary`, `analyst`. 中文说明见 [README.zh-CN.md](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/README.zh-CN.md)。

## Install

Install through Pi so the CLI and runtime come from the same package copy, and add Pi's private npm bin to `PATH` once:

```bash
pi install npm:@akagilnc/pi-workflow-roles
export PATH="$HOME/.pi/agent/npm/node_modules/.bin:$PATH"
```

Update with `pi update npm:@akagilnc/pi-workflow-roles`—never a second global `npm install -g`. Inspect with `ak-role roles` and `ak-role help <role>`; seat and Gate-officer configuration lives under Reading results below.

### Test channel (`next`)

Family / dogfood installs use the same package under dist-tag `next`, on a dedicated `HOME` so the test surface never shares AK config, ledger, book, or `PI_CODING_AGENT_DIR` with the host install. Do not mount or copy host credentials into the test home; do not use a book/worktree as a stand-in for install isolation. No second global npm.

```bash
export HOME=/path/to/test-home          # dedicated test HOME
export PI_CODING_AGENT_DIR="$HOME/.pi/agent"
export PATH="$PI_CODING_AGENT_DIR/npm/node_modules/.bin:$PATH"
```

- **First install of next**: `pi install npm:@akagilnc/pi-workflow-roles@next` → `ak-role roles` runs; installed version looks like `0.1.<count>-next.<shortsha>`.
- **Advance to a newer next**: `pi update npm:@akagilnc/pi-workflow-roles@next` → `<shortsha>` becomes the new CI `head_sha` prefix (7 chars).
- **Same-version reinstall / restore**: rerun the first-install command → idempotent; version unchanged (stamp path that only moves the dist-tag when the version is already on the registry).

Publish routing (Actions, not local stamp): successful `ci` push on `main` → `latest`; successful `ci` push on an allowlisted non-main branch (see `.github/workflows/ci.yml` `push.branches`) → `next`. PR completions and failed CI never publish.

## Reading results

`ak-role` is the only supported way to call the package. Every run writes its complete Terminal result to stdout—read or redirect it there, never scrape Pi session files:

```bash
ak-role judge --attach ./plan.md "Review this plan." > result.txt
```

Exit status reports lifecycle honesty, not business success: every lawful typed result (including `audit_escalation`) exits zero; a failure without a lawful result exits nonzero, and its Terminal carries the Error Artifact ref and original cause instead of a fabricated receipt.

`ak-role resume <runId> [message]` reopens that run's exact Pi session. Standard chain after a role `escalate`s: take the owner ruling and feed it back with `ak-role resume <runId> "<ruling>"` so the same session continues to a terminal. The optional `message` after `runId` is passed through unchanged as the continuation prompt (opaque: not parsed as flags); omit it to use the package resume envelope. Whether to resume is the caller's decision: the command does not require a typed HTTP 429 or a `resumable` state. Unknown run IDs and missing session principals are rejected. Collector, Doctor, Notary, Countersign, and Gleaner-Left remain one-shot. The model resolves from the **current seat configuration**; pass `--model` explicitly when identity matters (#552 ruling).

Judge, coder, fixer, reviewer, and merger also retry a non-lawful LLM call in place (same `runId` and session) up to `autoResumeLimit` times. Unset defaults to 2; `ak-role config set-auto-resume-limit <N>` writes the ceiling (`0` disables). Lawful typed terminals (`accepted`, `audit_escalation`, `no_receipt`) stop immediately. Manual `ak-role resume` stays available.

Seat and Gate-officer configuration:

```bash
ak-role config set judge <provider/model[:thinking]>
ak-role config set navigator <provider/model[:thinking]>
# Gate officers (automatic on submission; not caller commands except direct notary)
ak-role config set gatekeeper <provider/model[:thinking]>
ak-role config set inspector <provider/model[:thinking]>
ak-role config set notary <provider/model[:thinking]>
ak-role config unset gatekeeper
# persistent labor engine (callable roles; not navigator); one-shot override remains --engine
ak-role config set-engine judge opus
ak-role config unset-engine judge
# persistent main-session host (callable roles); one-shot override remains --host
ak-role config set-host judge grok-build
ak-role config unset-host judge
ak-role config set-auto-resume-limit 3
```

**Host axis (invocation-insensible after default):** `--host` is a global public option on every callable role. Resolution is invocation `--host` → persistent seat host (`config set-host`) → package default (`pi`). After `config set-host <seat> <name>`, the same command face used with Pi runs that seat on the named host with zero extra flags and zero caller-side changes. All public callable roles and their institutional sub-legs (soul audit, doctor audit, navigator, reviewer evidence children) are host-neutral on the shared in-process institutional session seam.

For Gate officers (`gatekeeper` / `inspector` / `notary`) resolution is officer pin → province (`gatekeeper`) pin → inherit parent session; an explicit selection that fails is loud and does not fall back. Configuration usage and refusal text are owned by `ak-role config` / `ak-role help config`. The persistent file is machine-wide and shared across CLI builds: seat keys this build does not know are skipped on read (not an error); unknown field-level keys on known seats keep their existing tolerance.

Receipts are typed, so callers compose roles without parsing prose; ordering and stopping stay caller-owned ([ADR 0010](docs/adr/0010-callers-own-role-composition-and-repetition.md)). Programmatic consumers derive contracts from the exported schemas in `src/package-contracts/`, not from this guide.

Gate submission gate: on completing-side submissions the package may spawn the Gate province before the run settles (`gatekeeper` dispatching `inspector` or `notary`); bounce means rewrite-and-resubmit in that same session, not role failure; `planned` / `refused` / `unfinished` skip the province; read gate history from the typed gate section of the receipt, never from session prose. Pointers: [ADR 0067](docs/adr/0067-menxia-province-founding-jishizhong-fubaolang.md), [ADR 0072](docs/adr/0072-menxia-pre-pr-submission-hooks.md). A labor-engine detour that fails to spawn, exits nonzero, or produces no usable output stops the run through the existing infrastructure-failure path with the original cause visible ([ADR 0071](docs/adr/0071-engine-detour-failure-seat-fallback-declaration.md)).

## Call the roles

The examples below are usage sketches; option identity, aliases, requiredness, and mode faces are owned by `ak-role help <command>`, not by a second flag contract here.

```bash
# countersign — ticket-court review before work starts; one-shot
ak-role countersign --attach ./ticket.md "裁：本票是否足以开工。"

# gleaner-left — unanchored pre-merge memorials; one-shot; --base required; instruction may be empty; callers must not pass directional instruction
ak-role gleaner-left --base main

# judge — adjudicate the supplied materials
ak-role judge --attach ./findings.md --attach ./adr.md "Adjudicate every finding."

# coder — first implementation
ak-role coder plan "Propose the first implementation plan."
ak-role coder apply --attach ./plan.md "Implement the approved slice."

# reviewer — fixed-target two-axis review; completed ≠ approved, read the findings
ak-role reviewer --base main "Review the branch."

# collector — GitHub PR review evidence; one-shot
ak-role collector --pr 42 --repo owner/repository

# fixer — repair the assigned findings
ak-role fixer --attach ./findings.md --prerequisites ./prereqs.json "Repair the findings."

# doctor — diagnose one retained case; one-shot
ak-role doctor --issue 115 "Diagnose this retained case."

# merger — resolve one merge already in conflict (start it with Git's ort first)
ak-role merger --project /path/to/worktree "Reconcile the active merge."

# notary — document-fidelity check on one retained source run; one-shot; optional --ticket for court diary
ak-role notary --source-run <runId@role|path>
ak-role notary --source-run <runId@role|path> --ticket 582

# countersign — ticket-court five questions; optional --ticket (diarist pipeline refreshes court diary first)
ak-role countersign --ticket 582 --attach ./ticket.md "裁：本票是否足以开工。"

# analyst — deterministic metrics; bare call = whole book
ak-role analyst

# after escalate: feed the owner ruling into the same session (standard chain)
ak-role resume <runId> "<ruling>"
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
| `--engine` | — | `name` | no | no | option | — | Labor engine for this invocation (owner pool-directive name; packaged notes attached when present; any role). |
| `--host` | — | `name` | no | no | option | — | Select the named main-session host adapter for this invocation. |
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
| `--ticket` | — | `number` | no | no | option | — | Optional ticket/issue number when Notary reads the court diary (ticket-provenance) for a ticket. |


### `countersign`

| Spelling | Aliases | Value | Required | Repeatable | Form | Modes/Phases | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--project` | — | `path` | no | no | option | — | Project root for ledger identity (defaults to process cwd). |
| `--attach` | — | `path` | no | yes | option | — | Attach a regular file; frozen at admission (repeatable). |
| `--ticket` | — | `number` | no | no | option | — | Ticket/issue number for court diary (diarist) and ticket-keyed provenance. Overrides attachment frontmatter when both present. |

### `gleaner-left`

Optional free positional `instruction` may be empty. Callers must not pass directional instruction; the seat self-fetches the merge-candidate diff against `--base`.

| Spelling | Aliases | Value | Required | Repeatable | Form | Modes/Phases | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--project` | — | `path` | no | no | option | — | Project root for ledger identity (defaults to process cwd). |
| `--base` | — | `revision` | yes | no | option | — | Required comparison-base revision for the unanchored merge-candidate diff. |

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

## Normative pointers

- Command usage and refusal text: `ak-role help <command>`, `ak-role help config` (sole authority).
- Decisions and rationale: `docs/adr/` (composition ADR 0010, public CLI face ADR 0052, submission gates ADR 0066/0067/0070/0072, labor engines ADR 0069/0071, court diary ADR 0075, among others; not exhaustive).
- Glossary: [CONTEXT.md](CONTEXT.md). Programmatic contracts: `src/package-contracts/` exports.
