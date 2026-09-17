/**
 * #959: auto-resume continuation.prompt must stay non-empty when the caller
 * supplies no message and no engine material (codex rejects empty stdin).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  RESUME_TRANSPORT_ENVELOPE,
  buildResumeContinuationPrompt,
  selectResumeContinuationPrompt,
} from "../../src/public-cli/run-lifecycle.ts";

test("auto-resume without message or engine material keeps a non-empty Chinese neutral prompt", () => {
  assert.equal(selectResumeContinuationPrompt(), RESUME_TRANSPORT_ENVELOPE);
  assert.equal(
    buildResumeContinuationPrompt({ packageRoot: "/unused-when-no-engine" }),
    RESUME_TRANSPORT_ENVELOPE,
  );
  assert.notEqual(selectResumeContinuationPrompt().trim(), "");
  // ADR 0073: machine text into the role view must be Chinese and neutral.
  assert.match(RESUME_TRANSPORT_ENVELOPE, /[\u4e00-\u9fff]/);
  assert.equal(RESUME_TRANSPORT_ENVELOPE.includes("[ak-role:"), false);
});

test("caller message still wins verbatim when supplied", () => {
  assert.equal(selectResumeContinuationPrompt("请继续"), "请继续");
  assert.equal(selectResumeContinuationPrompt(""), "");
});
