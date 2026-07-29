# CR/LF boundary repair packet

## Exact required set

| R# | Requirement |
| --- | --- |
| R1 | In the sole existing Authorization-header rule, replace vertical-capable separator whitespace with horizontal-only whitespace and handle empty/whitespace-only values without consuming CR, LF, CRLF, or the following line. Preserve complete nonempty header-value redaction, whole-quoted escaped parameters, Basic/Bearer/Token, assignments, one scanner and one admission path. Add CR/LF/CRLF empty and whitespace-only focused plus external-input regressions; regenerate dist. |

The Apply response must be exactly one Markdown table with columns `R#` and `Disposition`, R1 exactly once, and disposition `implemented(<test>)` or `refused(<reason>)`. Run typecheck/full/pack/diff, one forward commit, clean tree. Do not inspect sessions.
