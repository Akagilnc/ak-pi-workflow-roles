# Repair packet: executable transaction and installed-package proof

At the current committed HEAD, repair only these behaviors:

- black-box coverage for inherited stdin, large/binary separate tees, child-created collision/symlink, non-ignored scratch risk, real cleanup/promotion failures, race/no-overwrite, ordinary cleanup, and child signal plus Recorder failure;
- staging and final destination are on a mechanically safe same filesystem while preserving outside-or-ignored scratch and no apparently complete failure docket;
- installed tarball `.bin` proves stdin, child nonzero, child signal, stream and outcome semantics;
- successful archived signal is re-raised, Recorder failure remains one scanned JSON line and status 125;
- no production test hooks or parallel transaction mechanism.

Preserve acceptance/scanner/admission/role behavior. Add focused red/green tests, make coherent forward commit(s) only if package and transaction ownership genuinely require separation, and return a Receipt.
