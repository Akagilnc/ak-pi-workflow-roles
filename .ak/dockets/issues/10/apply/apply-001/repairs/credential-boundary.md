# Repair packet: credential boundary and dual-failure diagnostic

At the current committed HEAD, repair only these behaviors:

- composed Authorization Basic/Bearer headers must redact the complete credential, never leave it after a redacted prefix;
- bounded provider/package token forms include representative `sk-proj-`, `sk-ant-`, `glpat-`, `xoxb-`, and `AIza...`;
- prove category × credential coverage across argv/context, archive/reference/config/provenance, Receipt/audit, copied bytes, generated manifest/report, and public diagnostics;
- on child plus Recorder failure, preserve one bounded scanner-processed child diagnostic distinct from byte-exact child tee output;
- no secret may reach stage, final core, report, manifest, or Recorder failure JSON.

Preserve every other Recorder, role, package, migration, and transaction behavior. Add focused red/green tests, use the existing scanner/error/run seams, make one forward commit, run focused/typecheck tests, and return a Receipt. Do not inspect session payloads or add another scanner/diagnostic mechanism.
