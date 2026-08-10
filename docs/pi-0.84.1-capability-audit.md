# Pi 0.84.1 capability audit

Issue #225 upgrade evidence. This is the single audit table for the 0.84.1 migration.

| Local mechanism / seam | Disposition | 0.84.1 evidence |
| --- | --- | --- |
| Pi host package imports | **adapt** | Pi package guidance requires `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `typebox` as `"*"` peers. They are optional so ordinary npm and real `pi install` do not materialize host runtimes; packed-install tests verify both paths. Development snapshots are 0.84.1 / 0.84.1 / 1.3.8. |
| Provider authentication headers | **adapt** | 0.84.1 types expose deletions as `Record<string, string \| null>`; `ComplianceDispatch` now preserves that type and the existing typecheck/package suite compiles against 0.84.1. |
| Codex fast file switch | **keep** | 0.84.1 accepts an explicit `serviceTier`, but has no equivalent file switch. The single 0.84.1 patch remains the sole source. Machine Pi 0.84.1 fast-on smoke `resp_0314b23330e8080f016a799a4afd1c819b8805bd096657cac7` completed through `openai-codex-responses`; the provider seam reported outgoing `service_tier=priority`. Upgrade maintenance simply regenerates and applies that one patch, then repeats this one wire smoke. |
| Local `pi-telemetry` declaration | **delete** | Repository source has no direct import. 0.84.1 supplies it transitively, so no direct dependency is declared. |
| In-process child and nested legs | **keep** | R1 authority selected `IN_PROCESS_SUPERSEDES_200`; no RPC/provider bridge, private extension, flag, environment variable, or config is introduced. |
| `@earendil-works/pi-ai` compatibility export | **keep and re-audit** | 0.84.1 still publishes `./compat`; current package tests exercise all imported root symbols. Every later Pi upgrade must check this export before accepting the version. |
| Fatal provider event and settlement | **adapt** | 0.84.1 can emit `message_end` with `stopReason=error` and still leave the child process at exit 0. After excluding a lawful terminal and audit-incomplete result, every public role runner now supplies the typed missing-credential cause independently of exit status; retained auditor evidence continues to take precedence in shared settlement. The real empty-auth public-run tracer covers the zero-exit path. |

For every later Pi upgrade: read upstream changelog/API and installed bytes, update this audit shape for the new version, regenerate and apply the one versioned patch, and perform one fast-on wire smoke through the existing provider seam. Replace the patch with upstream only when upstream provides equivalent switch behavior.
