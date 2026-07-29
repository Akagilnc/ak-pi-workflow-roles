# Repair packet: manifest schema and admission law

At the current committed HEAD, repair only these behaviors:

- schema enforces exactly one of reference/stored identity, canonical path/hash/identity shapes, coherent receipt/audit links, and lawful child exit/signal combinations;
- real emitted manifests are mechanically validated against the public schema and malformed fixtures reject;
- canonical Git worktree/reference rules reject `.git`, directory-as-blob, unresolvable/future commits, dirty/untracked references, repository confusion, missing mandatory authority/task, reserved IDs, duplicate references/copies, committed external copies, generated-as-future references, and malformed/coherence cases;
- final scan/redaction report includes all final manifest hits without divergence.

Use existing config/path/admit/manifest/schema seams. Preserve transaction/process/package and role behavior. Add focused red/green tests, make one forward commit, and return a Receipt. No session inspection or new admission mechanism.
