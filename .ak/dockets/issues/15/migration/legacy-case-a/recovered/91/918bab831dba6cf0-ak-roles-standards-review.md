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
