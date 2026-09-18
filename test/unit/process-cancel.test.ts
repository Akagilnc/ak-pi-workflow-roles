/**
 * #855 process-cancel: catchable signals abort once; name is retained for settlement.
 * Install scope is role-turn commands only (analyst/roles/config keep default termination).
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { commandNeedsProcessCancel } from "../../src/public-cli/cli.ts";
import {
  installProcessCancelHandlers,
  processCancelDiagnostic,
  processCancelSignalName,
} from "../../src/public-cli/process-cancel.ts";

test("installProcessCancelHandlers aborts once with the first catchable signal name", () => {
  const fake = new EventEmitter() as NodeJS.Process;
  const handle = installProcessCancelHandlers(fake);
  try {
    assert.equal(handle.signal.aborted, false);
    assert.equal(handle.receivedSignal(), undefined);
    fake.emit("SIGTERM");
    assert.equal(handle.signal.aborted, true);
    assert.equal(handle.receivedSignal(), "SIGTERM");
    assert.equal(processCancelSignalName(handle.signal), "SIGTERM");
    assert.equal(processCancelDiagnostic("SIGTERM"), "ak-role terminated by SIGTERM");
    // Second signal does not overwrite the first.
    fake.emit("SIGINT");
    assert.equal(handle.receivedSignal(), "SIGTERM");
  } finally {
    handle.dispose();
  }
});

test("processCancelSignalName ignores unrelated abort reasons", () => {
  const controller = new AbortController();
  controller.abort(new Error("nested parent"));
  assert.equal(processCancelSignalName(controller.signal), undefined);
  assert.equal(processCancelSignalName(undefined), undefined);
});

test("commandNeedsProcessCancel is true only for role-turn commands", () => {
  assert.equal(commandNeedsProcessCancel(["judge", "x"]), true);
  assert.equal(commandNeedsProcessCancel(["--model", "p/m", "fixer", "x"]), true);
  assert.equal(commandNeedsProcessCancel(["resume", "01a0"]), true);
  assert.equal(commandNeedsProcessCancel(["new", "judge", "x"]), true);
  assert.equal(commandNeedsProcessCancel(["analyst", "--ticket", "1"]), false);
  assert.equal(commandNeedsProcessCancel(["roles"]), false);
  assert.equal(commandNeedsProcessCancel(["config", "show"]), false);
  assert.equal(commandNeedsProcessCancel(["help"]), false);
  assert.equal(commandNeedsProcessCancel(["--help"]), false);
  assert.equal(commandNeedsProcessCancel([]), false);
});
