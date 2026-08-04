# npm identity and license posture (maintainer note)

Maintainer-facing facts for portable package identity. Not a product CLI tutorial.

## Package name

Current `package.json` `name`: `@ak/pi-workflow-roles`.

### Registry check commands

```bash
npm whoami
npm view @ak/pi-workflow-roles
# When authenticated, also probe scope/org access, e.g.:
# npm access list packages @ak
# npm org ls ak
```

### Fallback order (only when authenticated evidence shows the current name is unpublishable)

1. `@akagilnc/pi-workflow-roles`
2. unscoped `ak-pi-workflow-roles`

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
