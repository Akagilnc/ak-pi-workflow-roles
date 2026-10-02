# @akagilnc/pi-workflow-roles

Packaged workflow roles for [Pi](https://pi.dev): `judge`, `countersign`, `secretariat`, `gleaner-left`, `fixer`, `coder`, `reviewer`, `collector`, `doctor`, `merger`, `notary`, `inspector`, `diarist`, `analyst`. 中文说明见 [README.zh-CN.md](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/README.zh-CN.md)。

## Install

Installation policy: [ADR 0052](docs/adr/0052-public-cli-is-the-only-supported-external-role-interface.md). Example:

```bash
pi install npm:@akagilnc/pi-workflow-roles
export PATH="$HOME/.pi/agent/npm/node_modules/.bin:$PATH"
```

Update example: `pi update npm:@akagilnc/pi-workflow-roles`. Inspect with `ak-role roles` and `ak-role help <role>`; seat and Gate-officer configuration lives under Reading results below.

Publish routing: [registry workflow](.github/workflows/publish-registry.yml).

## Reading results

Public entry and result delivery: [ADR 0052](docs/adr/0052-public-cli-is-the-only-supported-external-role-interface.md). Example:

```bash
ak-role judge --model <provider/model[:thinking]> --attach ./plan.md "Review this plan." > result.txt
```

Exit status and Terminal semantics: [ADR 0052](docs/adr/0052-public-cli-is-the-only-supported-external-role-interface.md), [Terminal implementation](src/public-cli/terminal.ts).

Manual continuation and flag placement: `ak-role help resume`; model / host resolution: `ak-role help`; engine configuration: `ak-role help config`. Audit continuation: [ADR 0003](docs/adr/0003-per-role-submission-tools.md). Host switching and prior-record delivery: [ADR 0086](docs/adr/0086-host-dossier-is-native-file-copy-sitian-append-only.md). Resume failure handling: [public execution seam](src/public-cli/post-admission.ts).

Automatic retry behavior: [auto-resume implementation](src/public-cli/auto-resume.ts); configuration usage: `ak-role help config`; effective limit: `ak-role config show`.

Seat and Gate-officer configuration:

```bash
ak-role config set judge <provider/model[:thinking]>
ak-role config set navigator <provider/model[:thinking]>
# Gate-officer configuration examples
ak-role config set gatekeeper <provider/model[:thinking]>
ak-role config set inspector <provider/model[:thinking]>
ak-role config set notary <provider/model[:thinking]>
ak-role config unset gatekeeper
# Engine configuration examples
ak-role config set-engine judge claude-code
ak-role config set-engine coder cursor cursor-grok-4.6-high
ak-role config set-engine-model coder cursor-grok-4.6-high
ak-role config unset-engine-model coder
ak-role config unset-engine judge
# Host configuration examples
ak-role config set-host judge grok-build
ak-role config unset-host judge
ak-role config set-auto-resume-limit 3
```

**Host axis:** `ak-role help`; institutional boundaries: [ADR 0082](docs/adr/0082-three-layer-runtime-role-host-face.md). Host recommendations and native compaction configuration: [#971](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/971).

**Host providers:** `ak-role help` and [provider resolution](src/public-cli/host-providers.ts); table inspection: `ak-role config show`.

**Machine method Skills:** run `ak-role setup`; installation behavior: [machine Skill setup](src/public-cli/machine-method-skills.ts), [ADR 0052](docs/adr/0052-public-cli-is-the-only-supported-external-role-interface.md); host capabilities: [Pi Skill delivery](src/pi/role-turn-host.ts) and [external host descriptions](src/host-descriptions.ts).

**Gate-officer resolution:** [institutional resolution](src/institutional-resolution.ts); configuration usage: `ak-role help config`; persisted-file reading: [config implementation](src/public-cli/config.ts).

**Receipts:** [exported contracts](src/package-contracts/); Navigator's output face: `ak-role help navigator`. Composition and stopping: [ADR 0010](docs/adr/0010-callers-own-role-composition-and-repetition.md).

**Submission gates:** [ADR 0079](docs/adr/0079-direct-officer-summons-ticket-memory-pointer-input.md), [submission gate](src/submission-gate.ts), [role gate composition](src/worker-role.ts) and [judge gates](src/judge-role.ts). Labor-engine failure policy: [ADR 0071](docs/adr/0071-engine-detour-failure-seat-fallback-declaration.md). Engine usage measurement: [usage fact owner](src/engine-detour-usage.ts).

## Call the roles

The examples below are usage sketches; option identity, aliases, requiredness, and mode faces are owned by `ak-role help <command>`, not by a second flag contract here.

```bash
# Model usage: ak-role help

# countersign
ak-role countersign --model <provider/model[:thinking]> --attach ./ticket.md "裁：本票 #582 是否足以开工。"

# secretariat
ak-role secretariat --model <provider/model[:thinking]> "整理 #924 票面并送庭。"

# gleaner-left
ak-role gleaner-left --model <provider/model[:thinking]> --base main

# judge
ak-role judge --model <provider/model[:thinking]> --attach ./findings.md --attach ./adr.md "Adjudicate every finding."

# coder
ak-role coder --model <provider/model[:thinking]> plan "Propose the first implementation plan."
ak-role coder --model <provider/model[:thinking]> apply --attach ./plan.md "Implement the approved slice."

# reviewer
ak-role reviewer --model <provider/model[:thinking]> --base main --authority-ref docs/adr/0001-roles-grow-by-demand.md "Review the branch."
# optional single-lens override
ak-role reviewer --model <provider/model[:thinking]> --base main --lens correctness --authority-ref CLAUDE.md

# collector
ak-role collector --model <provider/model[:thinking]> --pr 42 --repo owner/repository "Collect findings for the assigned issue."
ak-role collector --model <provider/model[:thinking]> --repo owner/repository "Collect findings for #42"
ak-role collector --model <provider/model[:thinking]> --pr 42 --request-manifest ./requests.json "Collect with named request bodies."

# fixer
ak-role fixer --model <provider/model[:thinking]> --attach ./findings.md --prerequisites ./prereqs.json "Repair the findings."

# doctor
ak-role doctor --model <provider/model[:thinking]> --issue 115 "Diagnose this retained case."

# merger
ak-role merger --model <provider/model[:thinking]> --project /path/to/worktree "Reconcile the merge."

# notary — direct summons with a source-run locator; duties are in souls/notary.md
ak-role notary --model <provider/model[:thinking]> --source-run <runId@role|path>

# inspector
ak-role inspector --model <provider/model[:thinking]> --attach ./change.patch "Review this material."

# gatekeeper
ak-role gatekeeper --model <provider/model[:thinking]> --attach ./submission.json "审：这批材料该谁审？"

# navigator
ak-role navigator --model <provider/model[:thinking]> "刚完成 coder apply 收敛，下一步？"

# diarist
ak-role diarist --model <provider/model[:thinking]> "整理 #708 的本案依据。"

# Additional diarist request examples; method: resources/diarist-collect.md
ak-role diarist --model <provider/model[:thinking]> "整理 #582 自上次成录以来的御话。"
# Multi-ticket request example
ak-role diarist --model <provider/model[:thinking]> "整理 #582、#583 自上次成录以来的御话，分别成录。"
# countersign request example
ak-role countersign --model <provider/model[:thinking]> --attach ./ticket.md "裁：本票 #582 是否足以开工。"

# analyst
ak-role analyst

# Resume request example; audit continuation: ADR 0003
ak-role --model <provider/model[:thinking]> resume <runId> "<ruling>"
```

## Names

Roster: [README.zh-CN.md](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/README.zh-CN.md). Naming rule: [ADR 0051](docs/adr/0051-roles-are-named-after-tang-song-offices.md).

## Normative pointers

- Command usage, resolution, and refusal text: `ak-role help`, `ak-role help <command>`, `ak-role help config` (sole authority).
- Decisions and rationale: `docs/adr/` (composition ADR 0010, public CLI face ADR 0052, submission gates ADR 0066/0067/0070/0072, labor engines ADR 0069/0071, court diary ADR 0075, among others; not exhaustive).
- Glossary: [CONTEXT.md](CONTEXT.md). Programmatic contracts: `src/package-contracts/` exports.
