## Current live Standards finding

- **P2 — Critical Pi execution boundary remains mocked rather than integration-tested.**  
  `test/judge-role.test.ts:18-22,33-51` still defines a partial fake `ExtensionAPI` and an `any`-typed tool executor. `toolCallContext()` manually appends the expected assistant message (`:54-74`), and tests invoke `tool.execute(...)` directly (`:109-115,145-151,265-272`). Consequently, the suite does not load `extensions/role-runtime.ts` or exercise Pi’s actual schema validation, assistant-message persistence, parallel tool batch, and termination lifecycle. The new singleton check depends specifically on that lifecycle through `ctx.sessionManager.getLeafEntry()` (`src/role-runtime.ts:115-135`), so the highest-risk integration contract remains unprotected despite the added unit coverage.

No current runtime regression was found in the fix diff; the other prior Standards findings are closed.
