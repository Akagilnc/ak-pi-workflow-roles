# Code review material

## Standards axis

## Findings

- **P1 — Unsupported role values silently disable all safeguards.**  
  `src/role-runtime.ts:65-66,124-125` returns for every value except exactly `"judge"`. Thus `--ak-role judeg` runs ordinary Pi without soul injection, verdict tooling, or audit, despite the flag claiming to activate a packaged role (`:60-63`). Reject non-empty unsupported role names during startup.

- **P1 — Malformed audit output can be accepted as “pass.”**  
  `src/soul-auditor.ts:49-70` finds only the first matching call and accepts any call whose `status` is `"pass"`, even if `violations` is missing/non-array/non-empty, extra properties exist, or the model made multiple decision calls. Because constrained sampling is only `"prefer"` (`:43-46`), unsupported providers do not guarantee schema enforcement. This defeats the README’s compliance-before-acceptance guarantee (`README.md:12-15`). Validate the complete response and require exactly one schema-conforming call.

- **P1 — Valid unauthenticated Pi providers cannot run the auditor.**  
  `src/soul-auditor.ts:84-91` rejects successful auth resolution when `apiKey` is absent. Pi explicitly supports providers requiring no authorization; `getApiKeyAndHeaders()` can return `{ok:true}` without a key. Consequently, an otherwise active local/custom model can adjudicate but can never produce an accepted verdict. Pass optional authentication through instead of imposing API-key authentication.

- **P2 — Verdict model permits contract-invalid states (Fowler “data clump”/flag-argument smell).**  
  The single object with independent optionals at `src/role-runtime.ts:10-30` allows `converged` with `fix`, `continue` with `decisionGate`, and whitespace-only escalation questions/options. Runtime checks at `:89-100` only trim `fix.summary` and only test `decisionGate` presence. This contradicts the status-specific contract in `README.md:42-46` and makes invalid states representable.

- **P2 — Tests mock away the package’s highest-risk boundaries.**  
  `test/judge-role.test.ts:12-36` uses `any` and a partial fake API, never loading `extensions/role-runtime.ts`, validating through Pi’s schema machinery, exercising unsupported roles, or testing parallel/terminating behavior. `test/soul-auditor.test.ts:80-95` tests only empty `revise`, missing malformed/multiple `pass` cases and auth-without-key. `test/judge-soul.test.ts:7-12` merely matches phrases, so unrelated text could satisfy it. Add entrypoint-level and adversarial contract tests.


## Spec axis

## Findings

- **High — “Pass must terminate” is not guaranteed.** `terminate: true` is only a Pi early-termination hint and applies only when every tool result in the batch terminates. The implementation merely prompts the model to make this the final action, without preventing sibling tool calls (`src/role-runtime.ts:80-83,114-118`). A passing verdict submitted alongside another tool can continue the agent loop. Enforce sole/final verdict submission rather than relying on model compliance.

- **High — Verdict contract is not an exact three-shape union.** The schema makes `fix` and `decisionGate` independently optional (`src/role-runtime.ts:10-30`), while runtime validation only checks required presence for `continue` and `escalate` (`src/role-runtime.ts:89-100`). It therefore accepts combinations such as `converged + fix`, `continue + decisionGate`, or `escalate + fix`. Model the contract as exactly `converged`, `continue + fix.summary`, or `escalate + decisionGate`, rejecting status-inapplicable fields.

- **High — Auditor can accept contradictory or multiple audit decisions.** `readAuditDecision` selects the first matching tool call (`src/soul-auditor.ts:49-56`) despite instructing “exactly once” (`src/soul-auditor.ts:101`). It also accepts `status: "pass"` regardless of non-empty `violations` (`src/soul-auditor.ts:57-68`). Thus a response containing an initial pass followed by revise, or pass with violations, still accepts the verdict. Validate exactly one schema-conformant, internally consistent decision and fail closed.

- **High — Bundled Soul depends heavily on upstream workflow formats and artifacts.** It requires ADRs, ticket IDs, “review legs,” current-head rounds, container-global law, `stationReceiptContracts`, specific issue/ADR numbers, and native `blocked_by` relationships (`souls/judge.md:8-18,27-38,43-49`). This contradicts the requirement that adjudication not depend on upstream material formats. The Soul must express format-neutral evidentiary rules or explicitly treat unavailable structures as optional inputs.

- **Medium — Escalation permits whitespace-only decision-gate content.** TypeBox `minLength: 1` accepts `" "` for the question and options (`src/role-runtime.ts:22-23`), and unlike `fix.summary`, runtime validation does not trim them (`src/role-runtime.ts:95-100`). Reject semantically empty gate fields.
