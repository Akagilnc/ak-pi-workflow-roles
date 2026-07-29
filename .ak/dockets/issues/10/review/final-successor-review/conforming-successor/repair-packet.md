# Conforming successor repair packet

Prior disposition: `.ak/dockets/issues/10/review/final-successor-review/conforming-successor/nonconformance-disposition.md` / SHA-256 `32d952fe9c8f126b19d05380d71459185ca6e4c23c269ce0207e635ad355b17a`.

## Exact required set

| R# | Requirement |
| --- | --- |
| R1 | Make the sole existing Authorization-header rule consume the complete CR/LF-bounded header value in every form, including a whole-quoted value containing escaped Digest/custom auth-parameter quotes. Add focused and external-input promotion regressions; regenerate dist; preserve Basic/Bearer/Token, token-assignment, following lines, and one scanner/admission path. |
| R2 | Reverify the existing isolated prepack implementation and default-concurrency/package lifecycle gates without production changes. |

The Apply response must be exactly one Markdown table with columns `R#` and `Disposition`, each required key exactly once, no extra R-like key, and each disposition exactly `implemented(<test>)` or `refused(<reason>)`. Run typecheck, full tests, pack, diff-check, one forward commit, clean tree. Preserve all prior artifacts and never inspect sessions.
