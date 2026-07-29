# Repair packet: escape-aware and unmatched quoted assignment scanning

At current HEAD, make the existing token-assignment handling escape-aware for quoted assignment values and wholly redact or fail closed on unmatched quoted values. Concrete probes `password="alpha \"beta\" gamma"` and `password="alpha beta` must leave no secret suffix. Preserve one scanner and other credential rules. Add focused scanner plus existing promotion-path regressions, regenerate dist, typecheck/full tests, one commit, Receipt. Do not inspect sessions.
