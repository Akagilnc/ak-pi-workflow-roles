# Repair packet: canonical archive identity credential gate

At current HEAD, apply the existing credential-free structural-metadata gate to canonical archive repositoryRoot before stage allocation or child spawn. A valid archive worktree under credential-shaped path must fail closed with no spawn/promotion; clean control succeeds. Never persist a redacted replacement archive identity. Existing config/archive/manifest seams only, focused/typecheck/full tests, one commit, Receipt. Do not inspect sessions.
