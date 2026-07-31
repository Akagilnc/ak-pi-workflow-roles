# Issue #36 pinned review materials

Canonical amended skill SHA-256: `0553da86a305f433a3ef14a7b3ad3b346729294afaf21bc073b9720a363c44d6`. No material allowlist; both legs may read any clone material.

Base `3fb482dd5f8c82e967bfba10143c408ba130f68b`; target `4c01703aac063f5f8516b18902244bda36f3a7af`; diff `git diff 3fb482dd5f8c82e967bfba10143c408ba130f68b...4c01703aac063f5f8516b18902244bda36f3a7af`.

## Commits
```text
4c01703 docs(docket): preserve Recorder thinking-sibling repair
a06141a fix(recorder): admit inert thinking siblings
c103e08 docs(docket): preserve Recorder thinking-sibling authority
```

## Standards
Sources: `CLAUDE.md`, `docs/adr/0016-tests-follow-logic-not-format.md`.

- **Mysterious Name** — a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code** — the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy** — a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps** — the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession** — a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches** — the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery** — one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change** — one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality** — abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains** — long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man** — a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest** — a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

## Spec
Issue #36 and `.ak/dockets/issues/36/judgment/authority-002/receipt.json`; repair receipt `.ak/dockets/issues/36/repair/apply/receipt.json`.
```json
{
  "body": "## Problem\n\nRecorder v2 rejects a lawful real Pi native-session terminating issuance whenever the final assistant row contains Pi `thinking` content blocks beside the sole package terminating `toolCall`.\n\nObserved twice while recording Issue #17 Judge medium after #33 merged:\n\n- child exit `0`;\n- `ak_judge_output` accepted exactly once;\n- persisted assistant row contained several `thinking` parts plus exactly one direct `ak_judge_output` tool call;\n- Recorder returned `acceptance-invalid` and published no docket.\n\nRaw reproduction remains gitignored under Issue #17 run sessions. `src/recorder/extract.ts::directIssuance` currently requires `message.content.length === 1`, although Pi persists reasoning siblings in the same assistant row.\n\n## Required boundary\n\nAdmit exactly one direct package terminating `toolCall` plus only lawful inert Pi reasoning content siblings. Continue rejecting:\n\n- multiple package terminating calls;\n- arbitrary/nested package lookalikes;\n- post-success content/lifecycle rows;\n- malformed issuance/result shapes.\n\nThinking text is not machine state and must not be copied into the Receipt or promoted as evidence. Add a representative real persisted-shape regression, rebuild generated Recorder artifacts, and preserve all #33 trust laws.\n",
  "comments": [],
  "number": 36,
  "state": "OPEN",
  "title": "Recorder rejects real Pi terminating rows with thinking siblings",
  "updatedAt": "2026-07-31T18:02:58Z",
  "url": "https://github.com/Akagilnc/ak-pi-workflow-roles/issues/36"
}
```
