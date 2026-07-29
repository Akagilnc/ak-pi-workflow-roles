# Successor repair packet — exact required set

Prior nonconformance disposition: `.ak/dockets/issues/10/review/final-verification-review/successor/nonconformance-dispositions.md` / SHA-256 `413eea4e3a3759de0211b2001605327545109ec231ab92c2df8ba008b452de2a`.

## Required exact set

- **R1** — Deepen the existing `authorization-header` rule to redact the complete CR/LF-bounded header value for every scheme, including Digest/custom quoted and comma-separated auth parameters. Preserve Basic/Bearer/Token and quoted-assignment behavior. Add focused parameterized cases and one external-input promotion regression; regenerate dist; no second scanner/admission mechanism.
- **R2** — Reverify the existing isolated prepack implementation at `a8a2b5bedc215d692ad1ac41d7ad9b5622e11a94` through its focused stress/package lifecycle tests and full default-concurrency gate. Add no production mechanism. Preserve an evidence-bearing keyed disposition.

The Apply report must contain exactly one disposition line for each required key and no other R-like key: `R1 implemented(<test>)|refused(<reason>)` and `R2 implemented(<test>)|refused(<reason>)`. Run typecheck, full tests, pack, diff-check, leave clean, one forward commit, exact Receipt. Do not inspect sessions or rewrite prior artifacts.
