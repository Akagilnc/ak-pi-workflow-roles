import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  STREAM_IDLE_TIMEOUT_CODE,
  StreamIdleTimeoutError,
  createStreamIdleGuard,
  isStreamIdleTimeoutError,
} from "../../src/stream-idle-guard.ts";

test("default idle timeout matches #102 owner-final 183s", () => {
  assert.equal(DEFAULT_STREAM_IDLE_TIMEOUT_MS, 183_000);
});

test("StreamIdleTimeoutError carries stable typed identity", () => {
  const error = new StreamIdleTimeoutError(1_000);
  assert.equal(error.name, "StreamIdleTimeoutError");
  assert.equal(error.code, STREAM_IDLE_TIMEOUT_CODE);
  assert.equal(error.code, "AK_STREAM_IDLE_TIMEOUT");
  assert.equal(error.idleTimeoutMs, 1_000);
  assert.equal(isStreamIdleTimeoutError(error), true);
  assert.equal(isStreamIdleTimeoutError(new Error("nope")), false);
});

test("idle guard aborts with StreamIdleTimeoutError after silence", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const guard = createStreamIdleGuard({ idleTimeoutMs: 5_000 });
  assert.equal(guard.signal.aborted, false);

  t.mock.timers.tick(4_999);
  assert.equal(guard.signal.aborted, false);

  t.mock.timers.tick(1);
  assert.equal(guard.signal.aborted, true);
  assert.ok(guard.signal.reason instanceof StreamIdleTimeoutError);
  assert.equal(guard.signal.reason.idleTimeoutMs, 5_000);
  assert.equal(guard.signal.reason.code, "AK_STREAM_IDLE_TIMEOUT");
  guard.dispose();
});

test("poke resets the idle window (not a total wall clock)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const guard = createStreamIdleGuard({ idleTimeoutMs: 5_000 });

  t.mock.timers.tick(4_000);
  guard.poke();
  t.mock.timers.tick(4_000);
  assert.equal(guard.signal.aborted, false);

  guard.poke();
  t.mock.timers.tick(5_000);
  assert.equal(guard.signal.aborted, true);
  assert.ok(isStreamIdleTimeoutError(guard.signal.reason));
  guard.dispose();
});

test("parent AbortSignal forwards its reason and cancels the idle timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const parent = new AbortController();
  const guard = createStreamIdleGuard({
    idleTimeoutMs: 5_000,
    parentSignal: parent.signal,
  });
  const parentReason = new Error("caller cancelled");
  parent.abort(parentReason);

  assert.equal(guard.signal.aborted, true);
  assert.equal(guard.signal.reason, parentReason);

  t.mock.timers.tick(5_000);
  assert.equal(guard.signal.reason, parentReason);
  guard.dispose();
});

test("already-aborted parent is observed immediately", () => {
  const parent = new AbortController();
  const reason = new Error("already done");
  parent.abort(reason);
  const guard = createStreamIdleGuard({
    idleTimeoutMs: 5_000,
    parentSignal: parent.signal,
  });
  assert.equal(guard.signal.aborted, true);
  assert.equal(guard.signal.reason, reason);
  guard.dispose();
});

test("dispose clears the timer so a late tick cannot abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const guard = createStreamIdleGuard({ idleTimeoutMs: 5_000 });
  guard.dispose();
  t.mock.timers.tick(5_000);
  assert.equal(guard.signal.aborted, false);
  guard.poke();
  t.mock.timers.tick(5_000);
  assert.equal(guard.signal.aborted, false);
});

test("idleTimeoutMs <= 0 disables the idle timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const guard = createStreamIdleGuard({ idleTimeoutMs: 0 });
  t.mock.timers.tick(183_000);
  assert.equal(guard.signal.aborted, false);
  guard.dispose();
});
