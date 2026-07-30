# Judge repair-003 Apply proof

Judge in Apply posture. Fixed construction target: `8bc5db9837fff3aa7b16000cffeb888dfd76233a`; pre-Apply head: `6e1681ca01aa2aa97a4ee843426283c02b295d9c`; construction commits are `d81605c5bcd478a01fbf5612c34399b8f4b44bdf` then `8bc5db9837fff3aa7b16000cffeb888dfd76233a`. Later `fe3a1b0` only archives the accepted Fixer Receipt.

Read:

- `.ak/dockets/issues/15/repair/repair-003/packet.md`
- `.ak/dockets/issues/15/repair/repair-003/plan-003/receipt.json`
- `.ak/dockets/issues/15/repair/repair-003/plan-003/judge/receipt.json`
- `.ak/dockets/issues/15/repair/repair-003/apply/receipt.json`
- `.ak/dockets/issues/15/repair/repair-003/apply/manual-reconciliation.md`
- `.ak/dockets/issues/15/repair/repair-003/recorder-closure/manifest.json`
- `.ak/dockets/issues/15/repair/repair-003/recorder-closure/exhibits/cutoff-scan-implementation`
- `.ak/dockets/issues/15/repair/repair-003/recorder-closure/inputs/cutoff-scan-summary`
- `.ak/dockets/issues/15/repair/repair-002/historical-nonconformance.json`
- `test/legacy-case-a-migration-verifier.test.ts`
- fixed Git diff `6e1681ca01aa2aa97a4ee843426283c02b295d9c..8bc5db9837fff3aa7b16000cffeb888dfd76233a`

Adjudicate exact R1-R4 executable proof. Independently check the sealed cutoff oracle and pre-cutoff `coder.ts` counterexample; closed association grammar/source universe, output updates, and real second-item mutation; Recorder successor input attribution and scanner identity; 597/277 results and both redactions; ledger tuple/seal verification; historical-byte preservation; typecheck and focused verifier.

Explicitly decide whether the two construction commits are lawful: `d81605c` first introduced the repair-003 Recorder files and `8bc5db9` then modified those newly introduced files to bind forward Git identities. Determine whether this is an unaccepted intermediate construction state within one Apply or an append-only violation that requires preservation/disposition. Do not silently ignore it.

Key reconciliation law is exact R key set, each once, nonblank disposition; headings and `implemented/refused` wording are not requirements.

Allowed inspection: Git/tree/stat/JSON/SHA, current `/tmp` names/lstat, and admitted non-generic source bytes needed for proof. Do not inspect generic JSONL/session/tool-event payloads or `.ak/work` beyond this request. Case B/#16/#17 remain out.

Return `converged` only if all R1-R4 are actually proved at the fixed target. Return `continue` with the smallest exact forward repair for any sustained defect. Submit through `ak_judge_output`.
