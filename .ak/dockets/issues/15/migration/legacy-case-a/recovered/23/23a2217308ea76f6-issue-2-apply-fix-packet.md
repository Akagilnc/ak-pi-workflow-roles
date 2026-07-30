# Issue #2 Apply residuals

Three Apply defects remain in the authorized documents:

1. `packets/fixer-repair.md:22-23` asks an instantiated packet to contain both “This packet path” and its own “SHA-256 of exact bytes.” Embedding that digest changes the exact bytes being digested, so the template is not practically instantiable and contradicts the receipt’s claim that all identities can be filled. Keep the packet’s own exact-byte digest in the external receipt/trail; in-packet path+digest fields should identify separately sealed artifacts.

2. `packets/judge-plan.md:25-26` repeats Judge posture law (“Local Apply-decidable mechanics are Apply obligations, not invented plan blockers”) despite the frozen requirement that `souls/judge.md` remain the sole owner and that templates not restate posture semantics. Retain the five evidence fields and packet-specific filling guidance, but remove the blocker-law restatement.

3. `packets/judge-apply.md:27` describes the range base as “Inclusive-exclusive,” which is internally ambiguous and can imply the wrong endpoint membership. State the base/target snapshot or delta meanings unambiguously without inventing an unspecified range convention.
