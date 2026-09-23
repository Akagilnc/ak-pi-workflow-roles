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

`ak-role resume <runId> [message]` reopens that run under the **current seat table** for model / host / engine — the same resolution as starting a new leg (model: `--model` → persistent seat → officer inherit; still none → error. host: `--host` → persistent seat host → package default `pi`). Configure seats first with `ak-role config set <seat> <provider/model[:thinking]>` or pass `--model` per invocation. Standard chain after a role `escalate`s: take the owner ruling and feed it back with `ak-role resume <runId> "<ruling>"` so the same run continues to a terminal. For every callable seat, including Notary/符宝郎, the optional `message` after `runId` is passed through unchanged as the continuation prompt (opaque: not parsed as flags); when omitted, the package adds no continuation text. Notary's separate explicit `new` command still accepts only its source-run locator, not a caller prompt. Global `--model` / `--thinking` / `--host` / `--engine` override the table for that resume only — place them before `<runId>` (either before `resume` or between `resume` and `<runId>`, e.g. `ak-role --model xai/grok-4.5 resume 01abc…` or `ak-role resume --model xai/grok-4.5 01abc…`); the one argv after `<runId>` is always the opaque message, never a flag (#471). On a real host switch (live seat host differs from the previous invocation host), prior native records of the previous host are delivered once as context to the target host; same-host resume does not re-inject. Each host writes only its native volume (Pi: `session/session.jsonl`; Grok CLI journals stay in the operator grok home, factory dossier is sitian records on the run), with unified ledger entries recorded in 司天台 (Sitian). Whether to resume is the caller's decision: the command does not require a typed HTTP 429 or a `resumable` state. Unknown run IDs and missing session principals are rejected. Every callable role accepts manual resume; Countersign and Gleaner-Left gained it in #599, Collector, Doctor, Notary, and Inspector in #633.

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
# optional model id for multi-model engines (cursor/opencode/agy); omit for name-is-model engines
ak-role config set-engine judge opus
ak-role config set-engine coder cursor cursor-grok-4.6-high
ak-role config set-engine-model coder cursor-grok-4.6-high
ak-role config unset-engine-model coder
ak-role config unset-engine judge
# persistent main-session host (callable roles); one-shot override remains --host
ak-role config set-host judge grok-build
ak-role config unset-host judge
ak-role config set-auto-resume-limit 3
```

**Host axis (invocation-insensible after default):** `--host` is a global public option on every callable role and on `resume`. Resolution is invocation `--host` → persistent seat host (`config set-host`) → package default (`pi`). After `config set-host <seat> <name>`, the same command face used with Pi runs that seat on the named host with zero extra flags and zero caller-side changes; bare `resume` follows the same table. Public callable roles and their institutional sub-legs (soul audit, doctor audit) share the in-process institutional session seam; Reviewer method Skill delivery is Pi-native `/skill:ak-cross-m-review` today — non-Pi host-native loader remains OPEN ([#922](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/922)).

**Recommended hosts (token saving, [#971](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/971)):** long legs are capped by each host's own auto-compaction; the threshold lives in that host's own config. This package neither writes those files nor adds a compaction mechanism of its own.

| Seat | Recommended host | Where that host's compaction threshold lives (default path; each host's own home override applies) |
| --- | --- | --- |
| judge, countersign | `codex` | `~/.codex/config.toml`: `model_auto_compact_token_limit` |
| coder, fixer | `grok-build` | `~/.grok/config.toml`: `[model."<id>"] auto_compact_threshold_percent` |
| all other LLM seats (the analyst is deterministic and has no host) | `pi` (package default) | `~/.pi/agent/settings.json`: `compaction.reserveTokens` (trigger = model window − this value; needs pi ≥ 0.85.1) |

Set a seat with `ak-role config set-host <seat> <host>`; use `--host` for a one-off. Before moving a seat, make sure its model is one that host can run (for example `codex` only runs OpenAI-family models); otherwise set it first with `ak-role config set <seat> <provider/model[:thinking]>`.

**Host providers (#788):** seat rows keep one provider name. Owner edits `~/.ak-roles/host-providers.json` (`{ "hermes": { "xai": "xai-oauth" } }`); code only reads it. Missing table entries ask the host directory (hermes this ticket): unique match wins, zero or many fail loud. Priority is table > unique > fail — no package discretion. `config show` prints the table as written.

**Forced method skills (#922):** Pi uses `--skill`. Claude uses `--plugin-dir` and its native slash command when a role binds exactly one Skill; its current print harness cannot issue multiple slash commands for one turn, so multi-Skill roles such as Fixer have no forced-method call on Claude. Codex discovers the packaged methods through its documented project `.agents/skills` catalog, which is created only when absent and then left in place; existing entries are never replaced, and Codex receives every official `$skill-name` invocation. Hermes ACP and Grok ACP cannot force a Skill call through their current harness interfaces. These gaps are documentation only: the package does not invent an adapter, capability probe, typed failure, catalog, or operator prerequisite for them. The package never changes host trust or configuration.

For Gate officers (`gatekeeper` / `inspector` / `notary`) resolution is officer pin → province (`gatekeeper`) pin → inherit parent session; an explicit selection that fails is loud and does not fall back. Configuration usage and refusal text are owned by `ak-role config` / `ak-role help config`. The persistent file is machine-wide and shared across CLI builds: seat keys this build does not know are skipped on read (not an error); unknown field-level keys on known seats keep their existing tolerance.

Receipts are typed by default so callers compose roles without parsing prose; navigator is the prose-exit exception ([#959](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/959)) — its final words are presented as-is. Ordering and stopping stay caller-owned ([ADR 0010](docs/adr/0010-callers-own-role-composition-and-repetition.md)). Programmatic consumers derive contracts from the exported schemas in `src/package-contracts/`, not from this guide.

Gate submission gate: on DONE-side submissions (`completed` / `partially_completed`) the package summons the subject officer directly (`inspector` for worker completion; `notary` for judge draft / countersign verdict) — it does not spawn a Gatekeeper child to choose the seat; bounce means rewrite-and-resubmit in that same session, not role failure; `planned` / `refused` / `unfinished` skip the officer summons and settle; `ak-role gatekeeper` remains available for independent province dispatch/pass; read gate history from the typed gate section of the receipt, never from session prose. Pointers: [ADR 0067](docs/adr/0067-menxia-province-founding-jishizhong-fubaolang.md), [ADR 0072](docs/adr/0072-menxia-pre-pr-submission-hooks.md), [ADR 0079](docs/adr/0079-direct-officer-summons-ticket-memory-pointer-input.md). A labor-engine detour that fails to spawn, exits nonzero, or produces no usable output stops the run through the existing infrastructure-failure path with the original cause visible ([ADR 0071](docs/adr/0071-engine-detour-failure-seat-fallback-declaration.md)). Runtime fact `decisiveFacts.engineDetourToolUsage` (#537) counts only the package tool `ak_engine_detour`; the bash/CLI ordinary path is a permanent blind spot and must not be read as "this seat did not use an engine".

## Call the roles

The examples below are usage sketches; option identity, aliases, requiredness, and mode faces are owned by `ak-role help <command>`, not by a second flag contract here.

```bash
# model axis (#178): caller specifies — either configure the seat once…
#   ak-role config set <seat> <provider/model[:thinking]>
# …or pass --model on the call (shown below). No package default model.

# countersign — ticket-court review before work starts; admission runs the ticket's diarist first (#742, caller-transparent); resume continues the exact session
ak-role countersign --model <provider/model[:thinking]> --attach ./ticket.md "裁：本票 #582 是否足以开工。"

# secretariat — rewrite ticket per 票面法; submission routes converged verdicts through the shared countersign gate (#924, #1021)
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

# collector — GitHub PR review evidence (bind target, read handbook/field activity, trigger as needed, wait window, return materials)
ak-role collector --model <provider/model[:thinking]> --pr 42 --repo owner/repository "Collect findings for the assigned issue."
ak-role collector --model <provider/model[:thinking]> --repo owner/repository "Collect findings for #42"
# optional: wait-window ms after the work step opens (default 600000 = 10 minutes)
ak-role collector --model <provider/model[:thinking]> --pr 42 --repo owner/repository --wait-ms 120000 "Collect with a 2-minute window."

# fixer — repair the assigned findings
ak-role fixer --model <provider/model[:thinking]> --attach ./findings.md --prerequisites ./prereqs.json "Repair the findings."

# doctor — diagnose one retained case
ak-role doctor --model <provider/model[:thinking]> --issue 115 "Diagnose this retained case."

# merger — reconcile merge materials (role escalates when nothing is in progress)
ak-role merger --model <provider/model[:thinking]> --project /path/to/worktree "Reconcile the merge."

# notary — document-fidelity check on one retained source run; ticket key inherited from source-run admitted form
ak-role notary --model <provider/model[:thinking]> --source-run <runId@role|path>

# inspector — direct complexity and test-quality check
ak-role inspector --model <provider/model[:thinking]> --attach ./change.patch "Review this material."

# gatekeeper — direct Gate province review; dispatch an officer or pass
ak-role gatekeeper --model <provider/model[:thinking]> --attach ./submission.json "审：这批材料该谁审？"

# navigator — direct free-form prose route advice; attends automatically on top-level public entry legs only
ak-role navigator --model <provider/model[:thinking]> "刚完成 coder apply 收敛，下一步？"

# diarist — gather and organize this case's decision basis into its per-ticket 起居录 (LLM resolves the ticket itself, no mechanical verification since #779; countersign admission runs it automatically, other stations summon it explicitly)
ak-role diarist --model <provider/model[:thinking]> "整理 #708 的本案依据。"

# countersign — ticket-court five questions; ticket recognition via instruction; admission runs the ticket's diarist first (#742)
ak-role countersign --model <provider/model[:thinking]> --attach ./ticket.md "裁：本票 #582 是否足以开工。"

# analyst — deterministic metrics; bare call = whole book (no model seat)
ak-role analyst

# after escalate: feed the owner ruling into the same session (standard chain)
ak-role --model <provider/model[:thinking]> resume <runId> "<ruling>"
```

## Names

Roles are named after Tang/Song offices; the full roster and naming rule live in [README.zh-CN.md](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/README.zh-CN.md).

## Normative pointers

- Command usage and refusal text: `ak-role help <command>`, `ak-role help config` (sole authority).
- Decisions and rationale: `docs/adr/` (composition ADR 0010, public CLI face ADR 0052, submission gates ADR 0066/0067/0070/0072, labor engines ADR 0069/0071, court diary ADR 0075, among others; not exhaustive).
- Glossary: [CONTEXT.md](CONTEXT.md). Programmatic contracts: `src/package-contracts/` exports.
