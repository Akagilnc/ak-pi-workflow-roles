# Owner disposition — repair-002 Plan attempt 001

## Facts

The response preserved the exact `{R1,R2,R3,R4}` key set, each key appeared once, and every keyed disposition was nonblank and substantively complete. Its rejection was caused only by the synonymous table headers `Key | Plan` rather than `R# | Disposition`.

No downstream consumer or repository runtime failed to understand the response. The rejection depended mechanically on free-text header spelling and had no demonstrated owner.

## Ruling

Manual R-ledger reconciliation is narrowed to:

1. the response key set exactly equals the packet key set;
2. each key appears exactly once; and
3. each keyed disposition is nonblank.

Reconciliation locates exact `R1..Rn` keys at the start of keyed data lines. Table headers and their literal spelling are not evidence and are not conformance requirements.

No additional per-item wording grammar is imposed by this ruling.

## Historical treatment

The committed Receipt, manifest, and contemporaneous nonconformance record remain unchanged. This disposition does not rewrite their historical classification. It establishes that the header-only rejection must not trigger another Plan, Apply, repair, or other invocation now or in an equivalent future case.

The obsolete literal-header requirements in `packets/fixer-repair.md` and `docs/development-closure.md` will be removed as a separate process-law change after issue #15 Case-A migration closure. That follow-up must not be mixed into the fixed migration construction or review target.
