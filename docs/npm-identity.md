# npm identity and license posture (maintainer note)

Maintainer-facing facts for portable package identity. Not a product CLI tutorial.

## Package name

Current `package.json` `name`: `@akagilnc/pi-workflow-roles`.

Settled under authenticated registry evidence (2026-08-04, npm user `akagilnc`).
The previous candidate `@ak/pi-workflow-roles` is **not** publishable by this
maintainer; fallback #1 was applied.

### Authenticated evidence trail (AC1)

Read-only probes only; no `npm publish`.

| Probe | Result | Meaning |
| --- | --- | --- |
| `npm whoami` | `akagilnc` | Authenticated (ENEEDAUTH cleared). |
| `npm view @ak/pi-workflow-roles` | `E404` Not found | Name not taken on the public registry (not proof of publish rights alone). |
| `npm org ls ak` | `{"ak":"owner"}` | Org/scope `ak` exists; sole listed member is user `ak` as owner — **not** `akagilnc`. |
| `npm access list packages @ak` | `{}` | No packages visible under `@ak` for this login. |
| `npm access list collaborators @ak/pi-workflow-roles` | `E403` Forbidden | Same class of response as a foreign scope (e.g. `@types/…` nonexistent package → `E403`). |
| `npm access get status @ak/pi-workflow-roles` | `private` | Status string only; does not grant publish rights given the `E403` collaborators probe. |
| `npm view @akagilnc/pi-workflow-roles` | `E404` Not found | Fallback #1 name free. |
| `npm access list collaborators @akagilnc/pi-workflow-roles` | `E404` Package not found | Own-scope response (package absent), **not** `E403`. |
| `npm access list packages @akagilnc` | `{}` | Scope reachable; no packages published yet. |
| `npm view ak-pi-workflow-roles` | `E404` Not found | Fallback #2 still free (not needed). |

**Decision:** current name unpublishable under authenticated evidence → apply
documented fallback order item 1 → set name to `@akagilnc/pi-workflow-roles`.

### Registry check commands

```bash
npm whoami
npm view @akagilnc/pi-workflow-roles
npm access list packages @akagilnc
npm access list collaborators @akagilnc/pi-workflow-roles
# Historical rejected candidate (foreign scope for this login):
# npm view @ak/pi-workflow-roles
# npm org ls ak
# npm access list collaborators @ak/pi-workflow-roles   # E403
```

### Fallback order (only when authenticated evidence shows the current name is unpublishable)

1. `@akagilnc/pi-workflow-roles` ← **applied** (this document’s settled name)
2. unscoped `ak-pi-workflow-roles` (still available; not applied)

Do not rename on unauthenticated guesses. If `npm whoami` returns `ENEEDAUTH`, leave the name unchanged and record the auth blocker; do not claim publishability.

## License posture

- Project license: **Apache-2.0** (`package.json` `"license": "Apache-2.0"` + root `LICENSE` = complete Apache License 2.0 text).
- Matt Pocock skills attribution: **separate** third-party notice in `THIRD_PARTY_NOTICES.md` (MIT). Not project license authority; not a dual-license expression.

## Peer dependency ranges

Explicit ranges replace upstream Pi docs' `"*"` recommendation for bundled peers. Ticket #104 / #11 Finding 4 require upper-bound discipline because Pi/TypeBox minor bumps have broken extension APIs.

| peer | range | executable matrix |
| --- | --- | --- |
| `@earendil-works/pi-coding-agent` | `~0.83.0` | `0.83.0` |
| `@earendil-works/pi-ai` | `~0.83.0` | `0.83.0` |
| `typebox` | `>=1.3.7 <=1.3.8` | `1.3.7`, `1.3.8` |

Distribution remains one Pi-managed npm copy (`pi install npm:<package>`), not a second global install. Packed metadata is verified via the repository `npm pack` seam (`getSharedIsolatedPack`).
