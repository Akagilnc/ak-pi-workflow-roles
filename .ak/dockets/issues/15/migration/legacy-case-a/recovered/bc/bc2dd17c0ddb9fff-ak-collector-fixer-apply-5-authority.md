# Approved Collector repair plan 5

# Fixer plan — Collector repair packet 5 (plan only)

**HEAD:** `91a1a92` (clean)  
**Phase:** plan — no code, test, doc, or Git mutation  
**Authority bounds:** no Soul change; no provider gateway/proxy; no upstream Pi dep. Production delta only if the loaded-Skill red exposes a `getCommands()` gap (`command.source === "skill"`), plus README/`--help` text.

---

## Context (evidence)

- F1 receipt oracle still `continue`s on `raw === null` and only checks `collectorToolArgumentsValid({})` for observe, not full `classifyCollectorBatch` legal result (`test/collector-receipt.test.ts` ~1052–1086).
- F1 real-Pi sibling is a single observe+blank-rationale row; packet requires two siblings: unknown leg field and `unavailable` without `unavailableScope` (`test/collector-role.test.ts` ~1173–1206).
- Activation already filters `pi.getCommands()` by name substrings (`skill`/`prompt`/`template`) at `src/collector-role.ts` ~543–559. Pi 0.82.1 emits every loaded Skill as `{ name: "skill:<n>", source: "skill" }`, including `disable-model-invocation` (prompt-excluded, command-present).
- Existing `F3-ambient-skills` is late `before_agent_start` mutation, not a normally discovered Skill path; fabricated `skill-ambient` command is extension-sourced.
- README Collector section shows launch flags but does not categorically forbid every Skill (incl. command-only) or document the Pi 0.82.1 late-hostile-extension limitation. Help test only matches flag presence.
- Prior same-family work (`91a1a92`) closed dual-schema/decoy/seam oracles; do not re-litigate those. This packet is residual exact-oracle + categorical Skill ownership.

---

## 1. F1 receipt exact-oracle residual

| | |
|---|---|
| **Behavior** | Every malformed output row, including `null`, reaches shared `classifyCollectorBatch` and is denied. `ak_collector_observe` with `{}` is classified legal: `allow: true` and permitted sole operational observe. |
| **Owner** | `test/collector-receipt.test.ts` only (shared Check/classify already correct in `src/collector-ledger.ts`). |
| **Red** | `raw === null` skip leaves null outside batch; observe `{}` stops at `collectorToolArgumentsValid` without legal classify assertion. |
| **Green** | Remove `if (raw === null) continue`. Add classify for observe `{}` asserting `allow: true` + permitted operational `ak_collector_observe`. Keep invalid observe `undefined`/`null` deny rows. |
| **Scope** | Test-only. No schema/ledger/runtime change. |

---

## 2. F1 real-Pi observe+invalid-output siblings

| | |
|---|---|
| **Behavior** | Two real-Pi sibling batches (valid observe + invalid output) each terminate fatal/nonzero with all six GitHub counters zero. |
| **Owner** | `test/collector-role.test.ts` F1 invalid-output block (sibling section). |
| **Red** | Sole sibling is observe+blank-rationale; missing required shapes. |
| **Green** | Replace/extend that sibling with exactly: (a) unknown leg field, (b) `unavailable` without `unavailableScope`. Each: `exitCode === 1` (or latched fatal) + `assertZeroGitHub` on user/pull/reviews/issueComments/reviewComments/create. Sole-output invalid matrix may remain. |
| **Scope** | Test-only. No production change (deny path already owns both shapes). |

---

## 3. Loaded-Skill startup fail-closed (owner-approved path)

| | |
|---|---|
| **Behavior** | Normally discovered Skill (`noSkills: false` + real Skill resource/path via harness `additionalSkillPaths` / discovery) fails at activation configuration, before provider/GitHub work. Matrix command-only `disable-model-invocation` if included. |
| **Owner** | Primary: activation `pi.getCommands()` seam in `src/collector-role.ts`. Test: new real-Pi row in `test/collector-role.test.ts`. If red shows name-filter miss, add `command.source === "skill"` at that seam only. |
| **Red** | No loaded-Skill path today; only fabricated extension command and late mutation. |
| **Green** | Assert: startup configuration failure text; nonzero exit; no successful `ak_collector_output` receipt; all six GitHub counters zero; `faux.state.callCount === 0`; response remains pending. |
| **Scope** | New test required. Production only if gap proven — then `source === "skill"` on existing seam. **No** provider proxy, **no** Soul, **no** second ambient mechanism. |

---

## 4. Late hostile Skill-mutation sibling (label + oracle tighten)

| | |
|---|---|
| **Behavior** | Existing `before_agent_start` skills injection stays an **unsupported hostile sibling-extension injection**. Still forbidden (not a permitted Skill). Pi 0.82.1 makes provider count non-normative at this late seam. |
| **Owner** | `test/collector-role.test.ts` `F3-ambient-skills` (+ comment/label). Production `systemPromptOptions.skills` guard unchanged. |
| **Red** | Row not labeled as hostile sibling-extension; risk of over-asserting provider-zero/pending (packet-4 demand superseded). |
| **Green** | Explicit label in test name/comments. Assert: latched fatal/nonzero, no successful receipt, all six GitHub counters zero. **Do not** assert provider callCount or pending responses. Preserve non-Skill ambient rows (contextFiles/append/commands) without broadening the late-seam exception. |
| **Scope** | Test labeling/oracle only. No production broaden; no provider-zero on this row. |

---

## 5. Categorical Skill forbid in README + packaged `--help`

| | |
|---|---|
| **Behavior** | Docs and help state categorically: Collector forbids **every** Skill, including command-only; supported profile is `--no-skills`, `--no-extensions` with only the explicit Collector package extension, no prompt templates/context files, one print/JSON prompt. Document narrow Pi 0.82.1 late-hostile-extension limitation **without** implying a security boundary or provider-zero guarantee. |
| **Owner** | `README.md` Collector section; Collector/`ak-role` flag `description` strings that surface in `pi --help` (`src/collector-role.ts` and/or `src/role-runtime.ts` as needed for help text only); `test/collector-package-lifecycle.test.ts` help assertion. |
| **Red** | README shows launch line but not categorical forbid / limitation; help test only checks flag presence. |
| **Green** | README + help text carry the categorical forbid + supported profile + narrow late-hostile note. Lifecycle test asserts **actual** help substrings (forbid Skills incl. command-only; profile flags/words), not mere `/ak-collector-*/`. |
| **Scope** | Docs + flag description strings + lifecycle test. No Soul. No behavior change beyond help text. |

---

## Apply order (when approved)

1. F1 receipt oracle (item 1)  
2. F1 real-Pi siblings (item 2)  
3. Loaded-Skill red → green; production `source === "skill"` only if red demands it (item 3)  
4. Relabel/tighten late hostile Skill row (item 4)  
5. README + flag help + lifecycle help assertions (item 5)  
6. Verify on new HEAD: focused Collector role/receipt/package tests + `npm run typecheck`  
7. Single forward commit (no amend); title prefix per task contract

## Out of scope / refuse triggers

- Soul edits; provider gateway/proxy; upstream Pi bumps  
- Relaxing AC, deleting failure paths, or broadening late-seam exception to non-Skill ambient rows  
- Replacing activation `getCommands()` ownership with a parallel Skill detector  
- Asserting provider-zero/pending on the late hostile Skill-mutation row  

## Risk notes

- Loaded Skill should already hit name `skill:` via `getCommands()`; prefer proving that before any production edit; if editing, use `source === "skill"` (and keep existing name filters for prompt/template).  
- Command-only Skills are prompt-invisible but command-visible — item 3 is the proof path; item 4 must not be misread as that path.  
- Help text must be categorical without claiming a security boundary.


## Binding Judge Apply instructions

Plan posture is approved at clean HEAD 91a1a92; execute items 1–5 in the stated order. Apply must materialize a valid real SKILL.md through DefaultResourceLoader (`noSkills: false` plus `additionalSkillPaths`/normal discovery), include the command-only `disable-model-invocation: true` boundary, and mechanically establish that Pi loaded it and exposed `skill:<name>` with Skill source. Run this row against the current activation seam before production edits; add only `command.source === "skill"` at that seam if the red demonstrates a gap. Do not substitute a fabricated extension command or late prompt mutation. Keep the loaded-Skill row’s startup-configuration error, nonzero exit, no successful receipt, all-six-GitHub-zero, provider-zero, and pending-response assertions. For each F1 real-Pi sibling, put valid observe and the specified invalid output in the same batch and assert fatal/nonzero plus all six GitHub counters zero. Relabel the existing late Skill mutation as unsupported hostile sibling-extension injection and retain fatal/no-receipt/GitHub-zero without provider-count or pending-response assertions. Make packaged help tests match emitted categorical Skill-prohibition and supported-profile text, not merely flag names. Then verify focused Collector role/receipt/package tests and `npm run typecheck` on the new HEAD; no Soul, provider proxy/gateway, parallel detector, or upstream dependency change is authorized.
