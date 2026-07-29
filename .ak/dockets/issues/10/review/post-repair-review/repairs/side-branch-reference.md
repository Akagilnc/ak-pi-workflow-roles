# Repair packet: exact side-branch Git references

At current HEAD, remove only the current-HEAD ancestry requirement from Git-reference admission. An exact resolvable side-branch commit with matching path/blob/SHA-256 must succeed. Preserve full commit resolution, object/path/blob/hash checks, dirty/untracked rejection, repository identity, and generated/pending future-reference failures. Replace the side-branch rejection test with positive exact-reference coverage; focused/typecheck/full tests, one commit, Receipt. Do not inspect sessions.
