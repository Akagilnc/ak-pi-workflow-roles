/**
 * #959 / ADR 0080: auto-resume and manual bare resume stay separate entries.
 * Auto-resume keeps a non-empty prompt; manual bare stays empty-capable.
 * #1167: continuation is envelope-only — engine rides startup materials.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  RESUME_TRANSPORT_ENVELOPE,
  buildAutoResumeContinuationPrompt,
} from "../../src/public-cli/run-lifecycle.ts";

test("auto-resume continuation is the non-empty transport envelope", () => {
  assert.equal(buildAutoResumeContinuationPrompt(), RESUME_TRANSPORT_ENVELOPE);
  assert.notEqual(RESUME_TRANSPORT_ENVELOPE.trim(), "");
});
