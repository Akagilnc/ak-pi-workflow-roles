# @akagilnc/pi-workflow-roles

Packaged workflow roles for [Pi](https://pi.dev): `judge`, `fixer`, `coder`, `reviewer`, `collector`, `doctor`, `merger`, `notary`, `analyst`. 中文说明见 [README.zh-CN.md](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/README.zh-CN.md)。

## Install

Install through Pi so the CLI and runtime come from the same package copy, and add Pi's private npm bin to `PATH` once:

```bash
pi install npm:@akagilnc/pi-workflow-roles
export PATH="$HOME/.pi/agent/npm/node_modules/.bin:$PATH"
```

Update with `pi update npm:@akagilnc/pi-workflow-roles`—never a second global `npm install -g`. Inspect with `ak-role roles` and `ak-role help <role>`; seat and Gate-officer configuration lives under Reading results below.

## Reading results

`ak-role` is the only supported way to call the package. Every run writes its complete Terminal result to stdout—read or redirect it there, never scrape Pi session files:

```bash
ak-role judge --attach ./plan.md "Review this plan." > result.txt
```

Exit status reports lifecycle honesty, not business success: every lawful typed result (including `audit_escalation`) exits zero; a failure without a lawful result exits nonzero, and its Terminal carries the Error Artifact ref and original cause instead of a fabricated receipt.

`ak-role resume <runId> [message]` reopens that run's exact Pi session. Standard chain after a role `escalate`s: take the owner ruling and feed it back with `ak-role resume <runId> "<ruling>"` so the same session continues to a terminal. The optional `message` after `runId` is passed through unchanged as the continuation prompt (opaque: not parsed as flags); omit it to use the package resume envelope. Whether to resume is the caller's decision: the command does not require a typed HTTP 429 or a `resumable` state. Unknown run IDs and missing session principals are rejected. Collector, Doctor, and Notary remain one-shot. The model resolves from the **current seat configuration**; pass `--model` explicitly when identity matters (#552 ruling).

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
ak-role config set-auto-resume-limit 3
```

For Gate officers (`gatekeeper` / `inspector` / `notary`) resolution is officer pin → province (`gatekeeper`) pin → inherit parent session; an explicit selection that fails is loud and does not fall back. Configuration usage and refusal text are owned by `ak-role config` / `ak-role help config`.

Receipts are typed, so callers compose roles without parsing prose; ordering and stopping stay caller-owned ([ADR 0010](docs/adr/0010-callers-own-role-composition-and-repetition.md)). Programmatic consumers derive contracts from the exported schemas in `src/package-contracts/`, not from this guide.

Gate submission gate: on completing-side submissions the package may spawn the Gate province before the run settles (`gatekeeper` dispatching `inspector` or `notary`); bounce means rewrite-and-resubmit in that same session, not role failure; `planned` / `refused` / `unfinished` skip the province; read gate history from the typed gate section of the receipt, never from session prose. Pointers: [ADR 0067](docs/adr/0067-menxia-province-founding-jishizhong-fubaolang.md), [ADR 0072](docs/adr/0072-menxia-pre-pr-submission-hooks.md). A labor-engine detour that fails to spawn, exits nonzero, or produces no usable output stops the run through the existing infrastructure-failure path with the original cause visible ([ADR 0071](docs/adr/0071-engine-detour-failure-seat-fallback-declaration.md)).

## Call the roles

The examples below are usage sketches; option identity, aliases, requiredness, and mode faces are owned by `ak-role help <command>`, not by a second flag contract here.

```bash
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

# notary — document-fidelity check on one retained source run; one-shot
ak-role notary --source-run <runId@role|path>

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
- Decisions and rationale: `docs/adr/` (composition ADR 0010, public CLI face ADR 0052, submission gates ADR 0066/0067/0070/0072, labor engines ADR 0069/0071, among others; not exhaustive).
- Glossary: [CONTEXT.md](CONTEXT.md). Programmatic contracts: `src/package-contracts/` exports.
