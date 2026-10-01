# @akagilnc/pi-workflow-roles

Packaged workflow roles for [Pi](https://pi.dev): `judge`, `countersign`, `secretariat`, `gleaner-left`, `fixer`, `coder`, `reviewer`, `collector`, `doctor`, `merger`, `notary`, `inspector`, `diarist`, `analyst`. 中文说明见 [README.zh-CN.md](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/README.zh-CN.md)。

## Install

Install through Pi so the CLI and runtime come from the same package copy, and add Pi's private npm bin to `PATH` once:

```bash
pi install npm:@akagilnc/pi-workflow-roles
export PATH="$HOME/.pi/agent/npm/node_modules/.bin:$PATH"
```

Update with `pi update npm:@akagilnc/pi-workflow-roles`—never a second global `npm install -g`. Inspect with `ak-role roles` and `ak-role help <role>`; seat and Gate-officer configuration lives under Reading results below.

Publish routing (Actions, not local stamp): successful `ci` push on the repository default branch → `latest`. Non-default-branch CI completions, PR completions, and failed CI never publish.

## Reading results

`ak-role` is the only supported way to call the package. Every run writes its complete Terminal result to stdout—read or redirect it there, never scrape Pi session files:

```bash
ak-role judge --model <provider/model[:thinking]> --attach ./plan.md "Review this plan." > result.txt
```

Exit status reports lifecycle honesty, not business success: every lawful typed result (including `audit_escalation`) exits zero; a failure without a lawful result exits nonzero, and its Terminal carries the Error Artifact ref and original cause instead of a fabricated receipt.

`ak-role resume <runId> [message]` reopens that run. Flag placement and the opaque continuation message are owned by `ak-role help resume`; model / host resolution is in `ak-role help`, and engine configuration is in `ak-role help config` ([ADR 0082](docs/adr/0082-three-layer-runtime-role-host-face.md)). Configure seats with `ak-role config set <seat> <provider/model[:thinking]>` or pass `--model` per invocation. Standard chain after a role `escalate`s: take the owner ruling and feed it back with `ak-role resume <runId> "<ruling>"` so the same run continues to a terminal. When an audit officer escalates, resume that officer's `runId`: escalation pauses only that seat, and the remaining gates continue after it. Notary's separate explicit `new` command still accepts only its source-run locator, not a caller prompt. A host switch does not get a second rule here: native dossier copy and prior-record delivery are [ADR 0086](docs/adr/0086-host-dossier-is-native-file-copy-sitian-append-only.md). Whether to resume is the caller's decision: the command does not require a typed HTTP 429 or a `resumable` state. Unknown run IDs are rejected. Any other resume failure prints one line pointing at that attempt's error record (`续跑失败，当次错误记录：<path>`); open the file for the cause. Every callable role accepts manual resume; Countersign and Gleaner-Left gained it in #599, Collector, Doctor, Notary, and Inspector in #633.

All callable roles also retry a non-lawful LLM call in place (same `runId` and session) up to `autoResumeLimit` times. Unset defaults to 2; `ak-role config set-auto-resume-limit <N>` writes the ceiling (`0` disables). Lawful typed terminals (`accepted`, `audit_escalation`, `no_receipt`) stop immediately. Manual `ak-role resume` stays available.

Seat and Gate-officer configuration:

```bash
ak-role config set judge <provider/model[:thinking]>
ak-role config set navigator <provider/model[:thinking]>
# Gate officers (direct summons on DONE submissions; province remains independently callable)
ak-role config set gatekeeper <provider/model[:thinking]>
ak-role config set inspector <provider/model[:thinking]>
ak-role config set notary <provider/model[:thinking]>
ak-role config unset gatekeeper
# persistent labor engine (callable roles); one-shot override remains --engine
# optional model id is a separate coordinate from the CLI engine name
ak-role config set-engine judge claude-code
ak-role config set-engine coder cursor cursor-grok-4.6-high
ak-role config set-engine-model coder cursor-grok-4.6-high
ak-role config unset-engine-model coder
ak-role config unset-engine judge
# persistent main-session host (callable roles); one-shot override remains --host
ak-role config set-host judge grok-build
ak-role config unset-host judge
ak-role config set-auto-resume-limit 3
```

**Host axis:** `--host` is a global public option on every callable role and on `resume`. Resolution order, the command face after `config set-host`, and where institutions stay are owned by `ak-role help` and [ADR 0082](docs/adr/0082-three-layer-runtime-role-host-face.md).

**Recommended hosts (token saving, [#971](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/971)):** long legs are capped by each host's own auto-compaction; the threshold lives in that host's own config. This package neither writes those files nor adds a compaction mechanism of its own.

| Seat | Recommended host | Where that host's compaction threshold lives (default path; each host's own home override applies) |
| --- | --- | --- |
| judge, countersign | `codex` | `~/.codex/config.toml`: `model_auto_compact_token_limit` |
| coder, fixer | `grok-build` | `~/.grok/config.toml`: `[model."<id>"] auto_compact_threshold_percent` |
| all other LLM seats (the analyst is deterministic and has no host) | `pi` (package default) | `~/.pi/agent/settings.json`: `compaction.reserveTokens` (trigger = model window − this value; needs pi ≥ 0.85.1) |

Set a seat with `ak-role config set-host <seat> <host>`; use `--host` for a one-off. Before moving a seat, make sure its model is one that host can run (for example `codex` only runs OpenAI-family models); otherwise set it first with `ak-role config set <seat> <provider/model[:thinking]>`.

**Host providers (#788):** seat rows keep one provider name. Owner edits `~/.ak-roles/host-providers.json` (`{ "hermes": { "xai": "xai-oauth" } }`); code only reads it. Missing table entries ask the host directory (hermes this ticket): unique match wins, zero or many fail loud. Priority is table > unique > fail — no package discretion. `config show` prints the table as written.

**Machine method Skills:** Run `ak-role setup` to install missing required Skills under `~/.agents/skills` and update those names through the Skills CLI (`skills update -g`). An occupied path is warned and left untouched. Setup adds links for installed Claude Code and Hermes when needed. This directory is the sole machine installation source. Roles warn on stdout when their required Skill is missing and continue. Pi receives paths from that directory through native `--skill`. Claude Code and Codex use native Skill discovery; Hermes ACP and Grok ACP cannot force Skills through their current harnesses. The package does not prepend or strip Skill commands in role requests, or modify host trust or configuration.

For Gate officers (`gatekeeper` / `inspector` / `notary`) resolution is officer pin → province (`gatekeeper`) pin → inherit parent session; an explicit selection that fails is loud and does not fall back. Configuration usage and refusal text are owned by `ak-role config` / `ak-role help config`. The persistent file is machine-wide and shared across CLI builds: seat keys this build does not know are skipped on read (not an error); unknown field-level keys on known seats keep their existing tolerance.

Receipts are typed by default so callers compose roles without parsing prose; navigator is the prose-exit exception ([#959](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/959)) — its final words are presented as-is. Ordering and stopping stay caller-owned ([ADR 0010](docs/adr/0010-callers-own-role-composition-and-repetition.md)). Programmatic consumers derive contracts from the exported schemas in `src/package-contracts/`, not from this guide.

Gate submission gate: on DONE-side submissions (`completed` / `partially_completed`) the package summons the subject officer directly (`inspector` for worker completion; `notary` for judge draft / countersign verdict) — it does not spawn a Gatekeeper child to choose the seat; the officer is summoned only after the submission tool call has ended; a pass settles without returning to the submitting seat, and a bounce resumes the submitting seat to submit again until every officer passes—not role failure; `planned` / `refused` / `unfinished` skip the officer summons and settle; `ak-role gatekeeper` remains available for independent province dispatch/pass; read gate history from the typed gate section of the receipt, never from session prose. Pointers: [ADR 0067](docs/adr/0067-menxia-province-founding-jishizhong-fubaolang.md), [ADR 0072](docs/adr/0072-menxia-pre-pr-submission-hooks.md), [ADR 0079](docs/adr/0079-direct-officer-summons-ticket-memory-pointer-input.md). A labor-engine detour that fails to spawn, exits nonzero, or produces no usable output stops the run through the existing infrastructure-failure path with the original cause visible ([ADR 0071](docs/adr/0071-engine-detour-failure-seat-fallback-declaration.md)). Runtime fact `decisiveFacts.engineDetourToolUsage` (#537) counts only the package tool `ak_engine_detour`; the bash/CLI ordinary path is a permanent blind spot and must not be read as "this seat did not use an engine".

## Call the roles

The examples below are usage sketches; option identity, aliases, requiredness, and mode faces are owned by `ak-role help <command>`, not by a second flag contract here.

```bash
# model axis (#178): caller specifies — either configure the seat once…
#   ak-role config set <seat> <provider/model[:thinking]>
# …or pass --model on the call (shown below). No package default model.

# countersign — ticket-court review before work starts; does not summon the diarist; resume continues the exact session
ak-role countersign --model <provider/model[:thinking]> --attach ./ticket.md "裁：本票 #582 是否足以开工。"

# secretariat — rewrite the ticket per 票面法; seat and gate are the 中书省 row in README.zh-CN.md (#924, #1021)
ak-role secretariat --model <provider/model[:thinking]> "整理 #924 票面并送庭。"

# gleaner-left — unanchored pre-merge memorials; resume continues the exact session; --base required; instruction may be empty; callers must not pass directional instruction
ak-role gleaner-left --model <provider/model[:thinking]> --base main

# judge — adjudicate the supplied materials
ak-role judge --model <provider/model[:thinking]> --attach ./findings.md --attach ./adr.md "Adjudicate every finding."

# coder — first implementation
ak-role coder --model <provider/model[:thinking]> plan "Propose the first implementation plan."
ak-role coder --model <provider/model[:thinking]> apply --attach ./plan.md "Implement the approved slice."

# reviewer — fixed-target parallel completeness + correctness review; completed ≠ approved, read the findings
ak-role reviewer --model <provider/model[:thinking]> --base main --authority-ref docs/adr/0001-roles-grow-by-demand.md "Review the branch."
# optional single-lens override
ak-role reviewer --model <provider/model[:thinking]> --base main --lens correctness --authority-ref CLAUDE.md

# collector — GitHub PR review evidence (LLM gathers via host CLI; optional request-manifest materials)
ak-role collector --model <provider/model[:thinking]> --pr 42 --repo owner/repository "Collect findings for the assigned issue."
ak-role collector --model <provider/model[:thinking]> --repo owner/repository "Collect findings for #42"
ak-role collector --model <provider/model[:thinking]> --pr 42 --request-manifest ./requests.json "Collect with named request bodies."

# fixer — repair the assigned findings
ak-role fixer --model <provider/model[:thinking]> --attach ./findings.md --prerequisites ./prereqs.json "Repair the findings."

# doctor — diagnose one retained case
ak-role doctor --model <provider/model[:thinking]> --issue 115 "Diagnose this retained case."

# merger — reconcile merge materials (role escalates when nothing is in progress)
ak-role merger --model <provider/model[:thinking]> --project /path/to/worktree "Reconcile the merge."

# notary — direct summons with a source-run locator; duties are in souls/notary.md
ak-role notary --model <provider/model[:thinking]> --source-run <runId@role|path>

# inspector — direct complexity and test-quality check
ak-role inspector --model <provider/model[:thinking]> --attach ./change.patch "Review this material."

# gatekeeper — direct Gate province review; dispatch an officer or pass
ak-role gatekeeper --model <provider/model[:thinking]> --attach ./submission.json "审：这批材料该谁审？"

# navigator — direct free-form prose route advice; attends automatically on top-level public entry legs only
ak-role navigator --model <provider/model[:thinking]> "刚完成 coder apply 收敛，下一步？"

# diarist — gather this case's decisions into per-ticket 起居录; secretariat summons it before drafting a new ticket
ak-role diarist --model <provider/model[:thinking]> "整理 #708 的本案依据。"

# before a countersign court, call the diarist only if the owner has said something new about the ticket since its last record; otherwise open or resume the court directly
ak-role diarist --model <provider/model[:thinking]> "整理 #582 自上次成录以来的御话。"
# for a multi-ticket court, summon once with all ticket numbers; the diarist records each ticket separately
ak-role diarist --model <provider/model[:thinking]> "整理 #582、#583 自上次成录以来的御话，分别成录。"
# countersign reports ticketNumber itself: use an existing diary's ticket number first; without a diary the officer identifies it
ak-role countersign --model <provider/model[:thinking]> --attach ./ticket.md "裁：本票 #582 是否足以开工。"

# analyst — deterministic metrics; bare call = whole book (no model seat)
ak-role analyst

# after escalate: feed the owner ruling into the same session (standard chain)
ak-role --model <provider/model[:thinking]> resume <runId> "<ruling>"
```

## Names

Roles are named after Tang/Song offices; the full roster and naming rule live in [README.zh-CN.md](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/README.zh-CN.md).

## Normative pointers

- Command usage, resolution, and refusal text: `ak-role help`, `ak-role help <command>`, `ak-role help config` (sole authority).
- Decisions and rationale: `docs/adr/` (composition ADR 0010, public CLI face ADR 0052, submission gates ADR 0066/0067/0070/0072, labor engines ADR 0069/0071, court diary ADR 0075, among others; not exhaustive).
- Glossary: [CONTEXT.md](CONTEXT.md). Programmatic contracts: `src/package-contracts/` exports.
