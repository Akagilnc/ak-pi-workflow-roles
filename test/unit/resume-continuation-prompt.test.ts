/**
 * #959 / ADR 0080: auto-resume and manual bare resume stay separate entries.
 * Auto-resume keeps a non-empty prompt; manual bare stays empty-capable.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  RESUME_TRANSPORT_ENVELOPE,
  buildAutoResumeContinuationPrompt,
  buildResumeContinuationPrompt,
  selectResumeContinuationPrompt,
} from "../../src/public-cli/run-lifecycle.ts";

test("manual bare resume without message stays empty (no auto envelope leak)", () => {
  assert.equal(selectResumeContinuationPrompt(), "");
  assert.equal(
    buildResumeContinuationPrompt({ packageRoot: "/unused-when-no-engine" }),
    "",
  );
});

test("auto-resume without engine material keeps the non-empty transport envelope", () => {
  assert.equal(
    buildAutoResumeContinuationPrompt({ packageRoot: "/unused-when-no-engine" }),
    RESUME_TRANSPORT_ENVELOPE,
  );
  assert.notEqual(RESUME_TRANSPORT_ENVELOPE.trim(), "");
});

test("caller message still wins verbatim when supplied on the manual selector", () => {
  assert.equal(selectResumeContinuationPrompt("请继续"), "请继续");
  assert.equal(selectResumeContinuationPrompt(""), "");
});
