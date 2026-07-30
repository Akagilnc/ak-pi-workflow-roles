# Fresh review for HEAD 93c8911

## Standards

- **P1 — Soul audit still bypasses model-specific request headers.** `src/soul-auditor.ts:111-126,175-181` calls `getProviderAuth(model.provider)`, then dispatches directly through `provider.stream()`. Pi’s model-aware path calls `getAuth(model)` and merges configured per-model headers (`node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js:262-275`), which `getProviderAuth(provider)` bypasses (`node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.js:68-69`). Consequently, models requiring configured routing/auth headers can complete the judge call but fail the mandatory audit. The integration test only supplies headers from provider auth resolution (`test/package-entrypoint.integration.test.ts:75-85,287-292`), so it does not cover model-configured headers.


## Spec

- **P1 — Audit authentication still diverges from Pi request preparation** (`src/soul-auditor.ts:111-126`): `getProviderAuth(model.provider)` resolves provider-only auth. Pi prepares requests using model-aware auth, which additionally merges `model.headers` and configured per-model headers. Because the audit then dispatches directly to `provider.stream`, those model-specific credentials/tenant headers are omitted. Valid judge verdicts can therefore fail mandatory audit authentication or reach the wrong tenant. The integration test covers resolver-returned headers/base URL, but not model/configured headers, so it does not establish the required parity.
