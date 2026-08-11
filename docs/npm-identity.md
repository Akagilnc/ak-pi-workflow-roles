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

### Auth freshness refresh (2026-08-05T13:38:30Z)

Court continue required fresh authenticated registry evidence. Re-ran read-only
probes on the maintainer machine. **Do not publish. Do not rename on this
unauthenticated/invalid-token result.**

| Probe | Result | Meaning |
| --- | --- | --- |
| `npm whoami` | `E401` Unauthorized | Token present in npm config but **invalid** — not a clean `ENEEDAUTH` empty-login, and not a successful whoami. Cannot invent an identity. |
| `npm view @akagilnc/pi-workflow-roles` | `E404` Not found | Public registry still shows fallback #1 name free (public read; not auth proof). |
| `npm access list packages @akagilnc` | `E401` invalid token | Authenticated scope probe blocked — same invalid token. |
| `npm access list collaborators @akagilnc/pi-workflow-roles` | `E401` invalid token | Collaborators probe blocked — same invalid token. |
| `npm view @ak/pi-workflow-roles` | `E404` Not found | Public E404 only; **insufficient** alone for rename or publish-rights claims (court continue). |

**Refresh decision:** leave package name `@akagilnc/pi-workflow-roles` (historical
authenticated 2026-08-04 decision under user `akagilnc`). Fresh whoami did **not**
succeed, so the 2026-08-04 authenticated probe table is **not** re-confirmed on this
pass. **Blocker for Apply court:** maintainer npm credential must be renewed
(`npm login` / valid token) before any further identity rename or publish step.
Public E404 must not be treated as fresh AC1 clearance.

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





### Authenticated refresh (2026-08-05T14:04Z, post `npm login`)

Read-only probes only; no `npm publish`.

| Probe | Result |
| --- | --- |
| `npm whoami` | `akagilnc` |
| `npm view @ak/pi-workflow-roles` | `E404 Not found` |
| `npm org ls ak` | `ak - owner` |
| `npm access list packages @ak` | `exit 0` |
| `npm access list collaborators @ak/pi-workflow-roles` | `E403 Forbidden` |
| `npm view @akagilnc/pi-workflow-roles` | `E404 Not found` |
| `npm access list collaborators @akagilnc/pi-workflow-roles` | `E404 Package not found` |
| `npm access list packages @akagilnc` | `exit 0` |
| `npm view ak-pi-workflow-roles` | `E404 Not found` |

**Decision unchanged:** maintainer `akagilnc`; settled name remains `@akagilnc/pi-workflow-roles` (fallback #1). Own-scope reachable (collaborators E404 = package absent). Foreign `@ak` collaborators E403. No publish performed.

## License posture

- Project license: **Apache-2.0** (`package.json` `"license": "Apache-2.0"` + root `LICENSE` = complete Apache License 2.0 text).
- Matt Pocock skills attribution: **separate** third-party notice in `THIRD_PARTY_NOTICES.md` (MIT). Not project license authority; not a dual-license expression.

## Host peer dependencies

Pi supplies `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `typebox`. Following Pi's package contract, all three are optional `"*"` peers; ordinary npm install therefore does not materialize a private Pi runtime. Development and typecheck use snapshots `pi-ai@0.84.1`, `pi-coding-agent@0.84.1`, and `typebox@1.3.8`.

The packed-artifact npm seam and a real `pi install` in an isolated home verify that host peers remain absent from the package install tree, including after a repeated install. Upgrade evidence is maintained in `docs/pi-0.84.1-capability-audit.md`.
