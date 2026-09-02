import assert from "node:assert/strict";
import test from "node:test";

import {
  isKnownRoleTurnHost,
  shouldProjectHostTransition,
} from "../../src/host-transition-prior-native.ts";

/** Pure host-pair gate — no filesystem (small-tier). */
test("shouldProjectHostTransition only for known unequal hosts", () => {
  assert.equal(shouldProjectHostTransition("pi", "grok-build"), true);
  assert.equal(shouldProjectHostTransition("grok-build", "pi"), true);
  assert.equal(shouldProjectHostTransition("pi", "pi"), false);
  assert.equal(shouldProjectHostTransition("grok-build", "grok-build"), false);
  assert.equal(shouldProjectHostTransition("third-adapter", "grok-build"), false);
  assert.equal(shouldProjectHostTransition("pi", "third-adapter"), false);
  assert.equal(isKnownRoleTurnHost("pi"), true);
  assert.equal(isKnownRoleTurnHost("grok-build"), true);
  assert.equal(isKnownRoleTurnHost("third-adapter"), false);
});
