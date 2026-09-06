# @akagilnc/pi-workflow-roles

Packaged workflow roles for [Pi](https://pi.dev): `judge`, `countersign`, `gleaner-left`, `fixer`, `coder`, `reviewer`, `collector`, `doctor`, `merger`, `notary`, `inspector`, `diarist`, `analyst`. 中文说明见 [README.zh-CN.md](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/README.zh-CN.md)。

## Install

Install through Pi so the CLI and runtime come from the same package copy, and add Pi's private npm bin to `PATH` once:

```bash
pi install npm:@akagilnc/pi-workflow-roles
export PATH="$HOME/.pi/agent/npm/node_modules/.bin:$PATH"
```

Four court seats (`coder` / `fixer` / `judge` / `countersign`) resolve an unbound ticket from the instruction via a Hermes labor-engine detour before the turn runs. Keep a working `hermes` executable on `PATH` for those seats; spawn failure, nonzero exit, or unusable output stops the run through the existing infrastructure-failure path with the original cause visible ([ADR 0071](docs/adr/0071-engine-detour-failure-seat-fallback-declaration.md)). Pi-only installs that never dispatch those seats do not need Hermes.

Update with `pi update npm:@akagilnc/pi-workflow-roles`—never a second global `npm install -g`. Inspect with `ak-role roles` and `ak-role help <role>`; seat and Gate-officer configuration lives under Reading results below.

### Test channel (`next`)

Family / dogfood installs use the same package under dist-tag `next`. Pi installation surface is isolated via `PI_CODING_AGENT_DIR` (package config, ledger, and books remain machine-scoped under user home, never following `HOME`). Do not mount or copy host credentials into the test surface; do not use a book/worktree as a stand-in for install isolation. No second global npm.

```bash
export PI_CODING_AGENT_DIR="/path/to/test-surface/.pi/agent"
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

`ak-role resume <runId> [message]` reopens that run under the **current seat table** for model / host / engine — the same resolution as starting a new leg (`--flag` → persistent seat → package default). Standard chain after a role `escalate`s: take the owner ruling and feed it back with `ak-role resume <runId> "<ruling>"` so the same run continues to a terminal. `[message]` applies only to seats that accept caller instruction: for those seats the optional `message` after `runId` is passed through unchanged as the continuation prompt (opaque: not parsed as flags); omit it to use the package resume envelope. Notary/符宝郎 must omit `message` and derives evidence from the existing source-run/dossier binding. Global `--model` / `--host` / `--engine` override the table for that resume only. On a real host switch (live seat host differs from the previous invocation host), prior native records of the previous host are delivered once as context to the target host; same-host resume does not re-inject. Each host writes only its native volume (Pi: `session/session.jsonl`; Grok CLI journals stay in the operator grok home, factory dossier is sitian records on the run), with unified ledger entries recorded in 司天台 (Sitian). Whether to resume is the caller's decision: the command does not require a typed HTTP 429 or a `resumable` state. Unknown run IDs and missing session principals are rejected. Every callable role accepts manual resume; Countersign and Gleaner-Left gained it in #599, Collector, Doctor, Notary, and Inspector in #633.

Judge, coder, fixer, reviewer, and merger also retry a non-lawful LLM call in place (same `runId` and session) up to `autoResumeLimit` times. Unset defaults to 2; `ak-role config set-auto-resume-limit <N>` writes the ceiling (`0` disables). Lawful typed terminals (`accepted`, `audit_escalation`, `no_receipt`) stop immediately. Manual `ak-role resume` stays available.

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
ak-role config set-engine judge opus
ak-role config unset-engine judge
# persistent main-session host (callable roles); one-shot override remains --host
ak-role config set-host judge grok-build
ak-role config unset-host judge
ak-role config set-auto-resume-limit 3
```

**Host axis (invocation-insensible after default):** `--host` is a global public option on every callable role and on `resume`. Resolution is invocation `--host` → persistent seat host (`config set-host`) → package default (`pi`). After `config set-host <seat> <name>`, the same command face used with Pi runs that seat on the named host with zero extra flags and zero caller-side changes; bare `resume` follows the same table. All public callable roles and their institutional sub-legs (soul audit, doctor audit, navigator, reviewer evidence children) are host-neutral on the shared in-process institutional session seam.

For Gate officers (`gatekeeper` / `inspector` / `notary`) resolution is officer pin → province (`gatekeeper`) pin → inherit parent session; an explicit selection that fails is loud and does not fall back. Configuration usage and refusal text are owned by `ak-role config` / `ak-role help config`. The persistent file is machine-wide and shared across CLI builds: seat keys this build does not know are skipped on read (not an error); unknown field-level keys on known seats keep their existing tolerance.

Receipts are typed, so callers compose roles without parsing prose; ordering and stopping stay caller-owned ([ADR 0010](docs/adr/0010-callers-own-role-composition-and-repetition.md)). Programmatic consumers derive contracts from the exported schemas in `src/package-contracts/`, not from this guide.

Gate submission gate: on DONE-side submissions (`completed` / `partially_completed`) the package summons the subject officer directly (`inspector` for worker completion; `notary` for judge draft / countersign verdict) — it does not spawn a Gatekeeper child to choose the seat; bounce means rewrite-and-resubmit in that same session, not role failure; `planned` / `refused` / `unfinished` skip the officer summons and settle; `ak-role gatekeeper` remains available for independent province dispatch/pass; read gate history from the typed gate section of the receipt, never from session prose. Pointers: [ADR 0067](docs/adr/0067-menxia-province-founding-jishizhong-fubaolang.md), [ADR 0072](docs/adr/0072-menxia-pre-pr-submission-hooks.md), [ADR 0079](docs/adr/0079-direct-officer-summons-ticket-memory-pointer-input.md). A labor-engine detour that fails to spawn, exits nonzero, or produces no usable output stops the run through the existing infrastructure-failure path with the original cause visible ([ADR 0071](docs/adr/0071-engine-detour-failure-seat-fallback-declaration.md)).

## Call the roles

The examples below are usage sketches; option identity, aliases, requiredness, and mode faces are owned by `ak-role help <command>`, not by a second flag contract here.

```bash
# countersign — ticket-court review before work starts; resume continues the exact session
ak-role countersign --attach ./ticket.md "裁：本票 #582 是否足以开工。"

# gleaner-left — unanchored pre-merge memorials; resume continues the exact session; --base required; instruction may be empty; callers must not pass directional instruction
ak-role gleaner-left --base main

# judge — adjudicate the supplied materials
ak-role judge --attach ./findings.md --attach ./adr.md "Adjudicate every finding."

# coder — first implementation
ak-role coder plan "Propose the first implementation plan."
ak-role coder apply --attach ./plan.md "Implement the approved slice."

# reviewer — fixed-target two-axis review; completed ≠ approved, read the findings
ak-role reviewer --base main "Review the branch."

# collector — GitHub PR review evidence
ak-role collector --pr 42 --repo owner/repository

# fixer — repair the assigned findings
ak-role fixer --attach ./findings.md --prerequisites ./prereqs.json "Repair the findings."

# doctor — diagnose one retained case
ak-role doctor --issue 115 "Diagnose this retained case."

# merger — resolve one merge already in conflict (start it with Git's ort first)
ak-role merger --project /path/to/worktree "Reconcile the active merge."

# notary — document-fidelity check on one retained source run; ticket key inherited from source-run admitted form
ak-role notary --source-run <runId@role|path>

# inspector — direct complexity and test-quality check
ak-role inspector --attach ./change.patch "Review this material."

# gatekeeper — direct Gate province review; dispatch an officer or pass
ak-role gatekeeper --attach ./submission.json "审：这批材料该谁审？"

# navigator — direct route advice (ordered next-role candidates); automatic attendance unchanged
ak-role navigator "刚完成 coder apply 收敛，下一步？"

# diarist — gather and organize this case's decision basis into its per-ticket 起居录
ak-role diarist "整理 #708 的本案依据。"

# countersign — ticket-court five questions; ticket recognition via instruction
ak-role countersign --attach ./ticket.md "裁：本票 #582 是否足以开工。"

# analyst — deterministic metrics; bare call = whole book
ak-role analyst

# after escalate: feed the owner ruling into the same session (standard chain)
ak-role resume <runId> "<ruling>"
```

## Names

Roles are named after Tang/Song offices; the full roster and naming rule live in [README.zh-CN.md](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/README.zh-CN.md).

## Codex fast tier

Enable fast tier with `echo "fast_mode = on" > ~/.pi-codex-fast`; disable it with `echo "fast_mode = off" > ~/.pi-codex-fast` (or delete the file). The change takes effect on the next request without a restart. Fast tier costs more than the default tier.

## Normative pointers

- Command usage and refusal text: `ak-role help <command>`, `ak-role help config` (sole authority).
- Decisions and rationale: `docs/adr/` (composition ADR 0010, public CLI face ADR 0052, submission gates ADR 0066/0067/0070/0072, labor engines ADR 0069/0071, court diary ADR 0075, among others; not exhaustive).
- Glossary: [CONTEXT.md](CONTEXT.md). Programmatic contracts: `src/package-contracts/` exports.
