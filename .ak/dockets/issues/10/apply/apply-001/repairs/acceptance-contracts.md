# Repair packet: exact acceptance lifecycle and Collector contracts

At the current committed HEAD, repair only these behaviors:

- ordered lifecycle acceptance rejects duplicate/replayed identical terminals, conflicting terminals, out-of-order events, unsupported envelopes, errors, orphans, and ambiguity;
- package acceptance text/result matching is exact, not substring-based;
- cover all five terminating package tools in both supported envelopes;
- Collector accepted output uses its exact closed recursive production contract, rejects unknown top-level/nested fields and malformed descendants, and preserves generated-result versus accepted-terminal distinction;
- only genuinely bound Judge/Reviewer acceptance may establish audit observation.

Preserve role outputs and Recorder startup isolation. Add focused red/green tests through shared leaf contracts; no parallel parser, session archive, role loading, or Coder Receipt fabrication. Make one forward commit and return a Receipt.
