# Target-local closure review specification

Use documented repository standards and frozen issue #10 authority/Plan-002. Verify the diff after `fede0e1001cf8b523fb13ce165f67deca164e81f` for these concrete facts:

- Authorization separator whitespace cannot cross CR, LF, or CRLF;
- empty/whitespace-only Authorization fields preserve following lines;
- nonempty and whole-quoted escaped parameter values remain wholly redacted through the existing external-input promotion path;
- exactly one scanner/admission path remains;
- the R1 repair packet, two-column Apply response, and manual exact-set reconciliation conform to documented closure law;
- no unrelated production change occurred.

Prior heuristic smells are nonrequirements. Prior Reviewer refusals are procedural evidence, not findings. Do not inspect sessions. Report only concrete documented-standard or frozen-spec violations; report none if none.
