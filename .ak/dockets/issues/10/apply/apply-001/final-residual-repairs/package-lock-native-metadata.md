# Repair packet: package-lock native lifecycle metadata

At current committed HEAD with only `package-lock.json` dirty after exact `npm install`, commit the authoritative lockfile synchronization for package `os`, `cpu`, and install lifecycle metadata. Prove repeated `npm install` leaves status empty, generated native output remains ignored/host-loadable, typecheck/full tests/pack remain green, and no unrelated metadata changes. One forward commit and exact Receipt; do not inspect sessions.
