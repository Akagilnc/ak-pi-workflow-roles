/**
 * #633 — Collector marks outputAccepted during execute before the shared
 * submission ledger adjudicates turn sole-ness. A correctable non-sole
 * rejection must release only that provisional latch so a later sole output
 * can accept; the accepted singleton remains strict without release.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { emptyCollectorManifest } from "../../src/collector-config.ts";
import { createCollectorLedger } from "../../src/collector-ledger.ts";

function freshLedger() {
  return createCollectorLedger({
    repository: {
      display: "acme/widgets",
      canonical: "acme/widgets",
      owner: "acme",
      repo: "widgets",
    },
    prNumber: 42,
    manifest: emptyCollectorManifest(),
  });
}

test("provisional output latch clears on release so a later sole accept can latch again", () => {
  const ledger = freshLedger();
  ledger.markOutputAccepted();
  assert.equal(ledger.outputAccepted, true);
  ledger.releaseProvisionalOutputAccepted();
  assert.equal(ledger.outputAccepted, false);
  ledger.markOutputAccepted();
  assert.equal(ledger.outputAccepted, true);
});

test("accepted singleton still rejects a second mark without release", () => {
  const ledger = freshLedger();
  ledger.markOutputAccepted();
  assert.throws(() => ledger.markOutputAccepted(), /唯一终局|singleton/i);
  assert.equal(ledger.outputAccepted, true);
});
