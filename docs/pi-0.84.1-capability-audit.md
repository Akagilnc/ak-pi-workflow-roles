# Pi 0.84.1 capability audit

Issue #225 upgrade evidence. This is the single audit table for the 0.84.1 migration.

| Local mechanism / seam | Disposition | 0.84.1 evidence |
| --- | --- | --- |
| Pi host package imports | **adapt** | Pi package guidance requires `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `typebox` as `"*"` peers. They are optional so ordinary npm and real `pi install` do not materialize host runtimes; packed-install tests verify both paths. Development snapshots are 0.84.1 / 0.84.1 / 1.3.8. |
| Provider authentication headers | **adapt** | 0.84.1 types expose deletions as `Record<string, string \| null>`; `ComplianceDispatch` now preserves that type and the existing typecheck/package suite compiles against 0.84.1. |
| Codex fast file switch | **keep** | 0.84.1 accepts an explicit `serviceTier`, but has no equivalent file switch. The 0.84.1 patch remains the sole source and its deployment test observes `service_tier=priority` only for eligible requests. |
| Global patched Pi bytes | **adapt** | `ak-deploy-codex-fast-patch` explicitly deploys the repo patch to the resolved global 0.84.1 Pi installation, is idempotent, and rejects unknown target bytes. No postinstall hook is used. |
| Local `pi-telemetry` declaration | **delete** | Repository source has no direct import. 0.84.1 supplies it transitively, so no direct dependency is declared. |
| In-process child and nested legs | **keep** | R1 authority selected `IN_PROCESS_SUPERSEDES_200`; no RPC/provider bridge, private extension, flag, environment variable, or config is introduced. |
| `@earendil-works/pi-ai` compatibility export | **keep and re-audit** | 0.84.1 still publishes `./compat`; current package tests exercise all imported root symbols. Every later Pi upgrade must check this export before accepting the version. |
| Fatal provider event and settlement | **adapt** | 0.84.1 can emit `message_end` with `stopReason=error` and still leave the child process at exit 0. After excluding a lawful terminal and audit-incomplete result, every public role runner now supplies the typed missing-credential cause independently of exit status; retained auditor evidence continues to take precedence in shared settlement. The real empty-auth public-run tracer covers the zero-exit path. |

For every later Pi upgrade: read upstream changelog/API and installed bytes, update this audit shape for the new version, deploy the versioned patch, and rerun its wire test. Replace the patch with upstream only when upstream provides equivalent switch behavior.
