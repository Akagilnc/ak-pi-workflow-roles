import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
/**
 * Mechanical regression for the activation-ledger append seam: when the
 * platform lacks O_NOFOLLOW (Windows — nodejs/node#41590), the JS bitwise-or
 * in ACTIVATION_LEDGER_APPEND_OPEN_FLAGS would silently drop the flag and the
 * lstat→open TOCTOU anti-symlink protection would vanish. The append seam must
 * refuse fail-closed through the existing typed ActivationLedgerError channel
 * BEFORE any open, never append unprotected, and create no ledger file.
 *
 * Own file because the ESM customization hook that strips the constant is
 * process-global (node:test runs one process per file) and must be registered
 * BEFORE the production module graph resolves its node:fs bindings — hence
 * dynamic import, never a static one. Same tracer-bullet pattern as the #418
 * publication-seam regression; no production test hooks.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

test("activation ledger append refuses fail-closed when O_NOFOLLOW is unavailable", async () => {
  return await withTempRoot("ak-ledger-nofollow-", async (home) => {
    // Shim node:fs so production sees a platform without O_NOFOLLOW (exactly
    // the Windows shape): the constants object simply lacks the key.
    const hooksSource = [
      "const SHIM_SOURCE = `",
      "export * from \"node:fs\";",
      "import * as origFs from \"node:fs\";",
      "const strippedConstants = { ...origFs.constants };",
      "delete strippedConstants.O_NOFOLLOW;",
      "export const constants = Object.freeze(strippedConstants);`;",
      "export function resolve(specifier, context, nextResolve) {",
      "  if (specifier === \"node:fs\" && !String(context.parentURL ?? \"\").startsWith(\"ak-ledger-nofollow-shim:\")) {",
      "    return { url: \"ak-ledger-nofollow-shim:///node_fs\", shortCircuit: true };",
      "  }",
      "  return nextResolve(specifier, context);",
      "}",
      "export function load(url, context, nextLoad) {",
      "  if (url.startsWith(\"ak-ledger-nofollow-shim:\")) {",
      "    return { format: \"module\", source: SHIM_SOURCE, shortCircuit: true };",
      "  }",
      "  return nextLoad(url, context);",
      "}",
    ].join("\n");
    const hooksPath = join(home, "ak-ledger-nofollow-hooks.mjs");
    writeFileSync(hooksPath, hooksSource, "utf8");

    register(pathToFileURL(hooksPath));
    const ledgerModuleUrl = pathToFileURL(
      join(import.meta.dirname, "../../src/activation-ledger.ts"),
    ).href;
    const ledger = await import(ledgerModuleUrl);

    const fact = ledger.buildAcceptedActivationFact({
      role: "coder",
      observedAt: "2026-08-23T00:00:00.000Z",
      session: { kind: "session-file", path: "/tmp/session.jsonl" },
      correlation: ledger.correlationIdentityFromEnv({}),
    });
    const ledgerPath = ledger.activationWaitingLedgerPath(home, "book-a");

    assert.throws(
      () => ledger.appendAcceptedActivationFact(ledgerPath, fact, { ledgerHome: home }),
      (error: unknown) => {
        assert.ok(
          error instanceof ledger.ActivationLedgerError,
          `expected ActivationLedgerError, got ${String(error)}`,
        );
        const ledgerError = error as Error;
        assert.match(ledgerError.message, /O_NOFOLLOW/);
        assert.match(ledgerError.message, /refusing to append/);
        return true;
      },
    );
    // Fail-closed happened before any open: no ledger file was created.
    assert.throws(() => statSync(ledgerPath), (error: unknown) => {
      return (error as { code?: unknown }).code === "ENOENT";
    });
    });
});
