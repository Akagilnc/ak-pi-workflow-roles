import assert from "node:assert/strict";
import test from "node:test";

import {
  isTicketCourtCountersignSource,
  roleFromRunDirectory,
  runIdFromRunDirectory,
} from "../../src/run-terminal-artifacts.ts";

test("#1195 ticket-court countersign source is recognized from run leaf", () => {
  const path = "/home/.ak-roles/books/b/1195/runs/01a0@countersign";
  assert.equal(roleFromRunDirectory(path), "countersign");
  assert.equal(runIdFromRunDirectory(path), "01a0");
  assert.equal(isTicketCourtCountersignSource(path), true);
  assert.equal(isTicketCourtCountersignSource("01a0@judge"), false);
  assert.equal(isTicketCourtCountersignSource("01a0@notary"), false);
  assert.equal(isTicketCourtCountersignSource("not-a-leaf"), false);
});
