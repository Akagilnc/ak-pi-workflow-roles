Wave-4 plan (no edits or commits made)

Current facts
- HEAD is exactly baseline `802d28af17efa588aa12d9f8dc689e4a740ebc1d` on `feature/deepen-role-runtime`; baseline is an ancestor, the worktree is clean, and the frozen-surface diff is empty.
- The five scoped files retain 53 named tests (82 repository-wide) and 346 scoped `assert.*` calls.

Duplication inventory
- Full in-process Pi bootstrap appears 5 times across 3 modules: 3 blocks in `test/package-entrypoint.integration.test.ts`, 1 in `test/reviewer-role.test.ts` (the malformed Agent sibling test), and 1 in `test/reviewer-package-lifecycle.test.ts`. Each repeats faux provider/model creation, `ModelRuntime` plus in-memory credentials, native provider/auth registration, disabled compaction/retry settings, hermetic `DefaultResourceLoader` options, reload/error access, `SessionManager.inMemory`, `createAgentSession`, flag binding, and disposal. This is the primary deep extraction seam.
- Temporary directory allocation has 8 actual blocks across 4 scoped modules. HOME save/set/restore is repeated in the packaged Coder and installed Reviewer tests; recursive cleanup is repeated in every full-process/full-Pi fixture.
- `test/audit-failure-subprocess.test.ts` repeats the same raw `spawn(piCli)`, environment merge, stdout/stderr collection, close/error handling, and cleanup 3 times. The two help tests in `test/package-entrypoint.integration.test.ts` are additional subprocess consumers, although their successful help semantics differ from fatal print/JSON execution.
- Hermetic canonical Skill writing already has 3 real consumer modules through `test/helpers/test-skill.ts` (packaged Coder, installed Reviewer, fatal Reviewer subprocess). Invalid Coder Skill fixtures are intentionally different and stay scenario-local.
- Package manifest read/entrypoint resolution is repeated by all 5 package-entrypoint tests. Exact tar creation/list/content inspection, consumer Git history, local dependency wiring, npm installation, and installed entrypoint selection occur only in `test/reviewer-package-lifecycle.test.ts`.
- Provider responses and evidence are not generic duplication: Judge auth/model override dispatch, Coder native expansion, Fixer mixed batch, malformed Reviewer sibling, and installed Reviewer parallel/audit flows each capture different raw contexts and facts.

Execution-semantics boundaries
1. Fast controller: `test/judge-role.test.ts` and 20 of 21 `test/reviewer-role.test.ts` tests use small role-specific faux `ExtensionAPI` maps and direct tool execution. They do not load Pi, a package, or a process. Leave both local; unifying them would create the prohibited generic mock/controller framework and would obscure role-specific flags/tool sets.
2. In-process Pi: the 5 blocks above exercise real loader, schema validation, session entries, tool results, provider calls, flags, and termination without a child CLI. Extract only their repeated bootstrap/lifecycle.
3. Installed package: retain tar packing, exact 17-path assertion, no-SKILL/content checks, consumer Git repository, npm install, and writable-clone scenario locally because there is only one real consumer. Reuse only the shared temp-home, Skill, package metadata, and in-process adapters.
4. Fatal subprocess: preserve real process exit, stdout/stderr, JSON events, `isError`, abort markers, call-count diagnostics, and absence of accepted receipts. Use a separate raw subprocess adapter; never emulate these semantics in-process.

Concrete module/interface
- Replace the shallow `test/helpers/test-skill.ts` with one `test/helpers/pi-test-harness.ts` module.
- Keep its public surface small:
  - package fixture metadata: repository root, Pi CLI path, raw manifest loading, and manifest entrypoint resolution;
  - `withHermeticHome(...)`: creates a unique HOME/agent area, restores the prior HOME exactly, and recursively removes the area in `finally`;
  - `writeTestSkill(...)`: the existing deterministic canonical Skill writer, unchanged in bytes/return evidence;
  - `withInProcessPi(options, scenario)`: owns offline faux provider/model runtime/auth registration, settings, loader, session manager/session creation, flags/binding, and configured shutdown/disposal. It passes the scenario the raw faux provider/state, model/runtime, loader/extensions result, session, and `SessionManager`; it does not select or summarize entries;
  - `runPiSubprocess(args, options)`: owns only spawn/stream collection and returns raw `{ code, stdout, stderr }`. Callers continue to construct exact help/print/JSON arguments and parse JSON locally.
- Keep scenario-varying seams explicit in `withInProcessPi`: cwd/agentDir, source path versus extension factory, Skill paths, model/provider/auth resolver, model overrides path, mode, role flags, custom/no-tools, and whether Reviewer shutdown must be emitted. Common hermetic loader/settings defaults stay internal. Do not introduce scenario names, a fixture registry, an assertion API, or boolean evidence helpers.

File-by-file migration
- `test/package-entrypoint.integration.test.ts`: use shared package metadata and raw subprocess execution for both help tests; migrate Judge/Coder/Fixer bootstrap and cleanup to `withInProcessPi`. Keep soul/task/packet bytes, symlinked canonical TDD setup, special auth/model override, faux response queues, captured `Context`s, all session-entry lookups, provider counts, tool lists, schema errors, singleton checks, and receipt assertions next to each test.
- `test/reviewer-role.test.ts`: migrate only “real Pi rejects completed when a schema-invalid Agent sibling…” to the in-process adapter. Leave the controller harness and every direct ledger/audit/fatal test untouched.
- `test/reviewer-package-lifecycle.test.ts`: use shared hermetic HOME, Skill creation, and in-process bootstrap. Keep package/tar/Git/npm setup, parallel barrier, raw parent/child/audit contexts, raw session entries/usage, ledger provenance, clone-isolation snapshots, and all assertions local.
- `test/audit-failure-subprocess.test.ts`: retain its three scenario builders and all stage tables/assertions, but route their common process invocation through `runPiSubprocess` and temp cleanup through `withHermeticHome`. JSON parsing remains in tests so malformed/raw output is visible.
- `test/judge-role.test.ts`: no change; it is entirely the fast-controller seam.
- Delete `test/helpers/test-skill.ts` only after all three consumers use the deep module.

Harness proof and preservation
- Add at most one focused harness test proving HOME restoration and recursive cleanup even when the scenario callback throws, while preserving the exact thrown sentinel. Do not add tests for selectors/DSLs because none will exist. Existing role tests already prove that contexts, session entries/tool results/usage, stdout/stderr, exit codes, and fatal diagnostics remain raw.
- The architectural deletion test is the resulting import graph: the same module must serve package-entrypoint, reviewer-package-lifecycle, reviewer-role’s real-Pi case, and audit-failure subprocess tests. Deleting it would reintroduce the 5 full Pi blocks, 3 spawn collectors, and repeated HOME/cleanup code across multiple modules. One-off install/Git/tar logic will not be moved merely to inflate that claim.

Implementation/TDD order for the apply phase
1. Record baseline names and assertion inventory; run the five scoped test files as characterization.
2. Add the cleanup/failure-preservation test first, then implement the hermetic environment and fold in `writeTestSkill`.
3. Add the raw subprocess adapter and migrate help/fatal callers without changing their argument arrays or assertions.
4. Add the in-process adapter; migrate the three packaged roles, malformed Reviewer sibling, then installed Reviewer one at a time, running each affected test file after migration.
5. Run a same-pattern check: scoped consumers should no longer contain repeated `ModelRuntime.create`, `DefaultResourceLoader`, `SettingsManager.inMemory`, `createAgentSession`, raw `spawn(piCli)`, or manual HOME restoration; fast controller `SessionManager` use and one-off package/Git setup remain legitimate.
6. Audit the diff against baseline: all 53 existing test names retained verbatim; existing scenario assertions retained verbatim or mechanically relocated without weakening; no raw-evidence replacement; no host-state lookup; no production changes.

Final gate for the later apply phase
- `npm run typecheck`
- `EMPTY_HOME=$(mktemp -d); HOME="$EMPTY_HOME" npm test`
- `npm pack --dry-run` and confirm the lifecycle’s exact baseline production file list/no `SKILL.md` or copied canonical content
- `git diff --check`
- Confirm `git diff 802d28af17efa588aa12d9f8dc689e4a740ebc1d...HEAD -- src extensions souls README.md CONTEXT.md package.json package-lock.json docs .github` is empty.
- Confirm strict baseline ancestry, exactly one new forward Coder commit, and a clean worktree. Do not amend, squash, or push.
