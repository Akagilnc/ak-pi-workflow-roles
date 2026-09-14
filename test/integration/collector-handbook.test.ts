import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import test from "node:test";

import { ActivationLedgerError } from "../../src/activation-ledger-topology.ts";
import {
  createCollectorHandbookStore,
  resolveCollectorHandbookRoot,
} from "../../src/collector-handbook.ts";
import { COLLECTOR_HANDBOOK_MAX_BYTES } from "../../src/collector-tool-schemas.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

test("#677 handbook store: write general+repo, second store reads same bytes", async () => {
  await withTempRoot("ak-collector-handbook-", async (home) => {
    const ledgerHome = join(home, ".ak-roles");
    const bookKey = "widgets-book";
    const sessionPath = join(ledgerHome, "books", bookKey, "runs", "r1@collector", "session", "session.jsonl");
    await mkdir(join(sessionPath, ".."), { recursive: true });

    const placement = resolveCollectorHandbookRoot(sessionPath);
    assert.equal(placement.ledgerHome, ledgerHome);
    assert.equal(placement.bookKey, bookKey);

    const first = createCollectorHandbookStore({
      ledgerHome: placement.ledgerHome,
      handbookRoot: placement.root,
      repositoryCanonical: "acme/widgets",
      seedGeneral: "seed-general-v1",
    });
    const empty = await first.read();
    assert.equal(empty.general, "seed-general-v1");
    assert.equal(empty.generalSource, "seed");
    assert.equal(empty.repo, "");
    assert.equal(empty.repoSource, "empty");

    await first.write("general", "general-after-field-evidence");
    await first.write("repo", "repo-diff: coderabbit incremental only");

    const second = createCollectorHandbookStore({
      ledgerHome: placement.ledgerHome,
      handbookRoot: placement.root,
      repositoryCanonical: "acme/widgets",
      seedGeneral: "seed-general-v1",
    });
    const reused = await second.read();
    assert.equal(reused.general, "general-after-field-evidence");
    assert.equal(reused.generalSource, "book");
    assert.equal(reused.repo, "repo-diff: coderabbit incremental only");
    assert.equal(reused.repoSource, "book");

    // Opaque persistence — file bytes are the authority, not a parsed schema.
    const generalPath = join(placement.root, "general.md");
    const repoPath = join(placement.root, "repos", "acme__widgets.md");
    assert.equal(await readFile(generalPath, "utf8"), "general-after-field-evidence");
    assert.equal(await readFile(repoPath, "utf8"), "repo-diff: coderabbit incremental only");
  });
});

test("#677 handbook store: missing session topology fails closed", () => {
  assert.throws(
    () => resolveCollectorHandbookRoot("/tmp/not-under-ak-roles/session.jsonl"),
    (error: unknown) => error instanceof Error,
  );
});

test("#677 handbook root uses platform separators only (literal backslash stays in bookKey on POSIX)", async () => {
  await withTempRoot("ak-collector-handbook-posix-", async (home) => {
    const ledgerHome = join(home, ".ak-roles");
    // On POSIX, `\\` is a legal character inside a single path segment.
    const bookKey = sep === "/" ? "book\\key" : "book-key";
    const sessionPath = join(ledgerHome, "books", bookKey, "runs", "r1@collector", "session", "session.jsonl");
    await mkdir(join(sessionPath, ".."), { recursive: true });

    const placement = resolveCollectorHandbookRoot(sessionPath);
    assert.equal(placement.bookKey, bookKey);
    assert.equal(placement.ledgerHome, ledgerHome);
    assert.equal(placement.root, join(ledgerHome, "books", bookKey, "collector-handbook"));
  });
});

test("#677 handbook write and read share UTF-8 byte ceiling", async () => {
  await withTempRoot("ak-collector-handbook-bound-", async (home) => {
    const ledgerHome = join(home, ".ak-roles");
    const bookKey = "widgets-book";
    const sessionPath = join(ledgerHome, "books", bookKey, "runs", "r1@collector", "session", "session.jsonl");
    await mkdir(join(sessionPath, ".."), { recursive: true });
    const placement = resolveCollectorHandbookRoot(sessionPath);
    const store = createCollectorHandbookStore({
      ledgerHome: placement.ledgerHome,
      handbookRoot: placement.root,
      repositoryCanonical: "acme/widgets",
    });
    const over = "x".repeat(COLLECTOR_HANDBOOK_MAX_BYTES + 1);
    await assert.rejects(() => store.write("general", over));

    // Pre-existing / concurrent oversized file must fail at the read seam too.
    await mkdir(placement.root, { recursive: true });
    await writeFile(join(placement.root, "general.md"), over, "utf8");
    await assert.rejects(() => store.read());
  });
});

test("#677 handbook read refuses pre-existing leaf symlink (ADR 0038)", async () => {
  await withTempRoot("ak-collector-handbook-symlink-", async (home) => {
    const ledgerHome = join(home, ".ak-roles");
    const bookKey = "widgets-book";
    const sessionPath = join(ledgerHome, "books", bookKey, "runs", "r1@collector", "session", "session.jsonl");
    await mkdir(join(sessionPath, ".."), { recursive: true });

    const placement = resolveCollectorHandbookRoot(sessionPath);
    await mkdir(placement.root, { recursive: true });

    const outside = join(home, "outside-secret.txt");
    await writeFile(outside, "SECRET-OUTSIDE-LEDGER", "utf8");
    await symlink(outside, join(placement.root, "general.md"));

    const store = createCollectorHandbookStore({
      ledgerHome: placement.ledgerHome,
      handbookRoot: placement.root,
      repositoryCanonical: "acme/widgets",
      seedGeneral: "seed-must-not-mask-symlink",
    });

    await assert.rejects(
      () => store.read(),
      (error: unknown) => error instanceof ActivationLedgerError,
    );

    // Outside content must never have been admitted as handbook material.
    // (Rejection is the contract; this asserts we did not quietly follow the link.)
    const outsideBytes = await readFile(outside, "utf8");
    assert.equal(outsideBytes, "SECRET-OUTSIDE-LEDGER");
  });
});
