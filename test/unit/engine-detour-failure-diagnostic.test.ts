/**
 * #395 — engine detour failure diagnostic must carry the child's terminal
 * error row (last non-empty stdout line, e.g. a 529 result row) verbatim.
 * The diagnostic string is the seam consumed by the tool receipt text.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ENGINE_DETOUR_EMPTY_STDOUT_DIAGNOSTIC,
  engineDetourFailureDiagnostic,
} from "../../src/engine-detour.ts";

test("#395: empty stderr + stdout JSONL — diagnostic carries last error row verbatim", () => {
  const stdout = [
    '{"type":"system","subtype":"init","session_id":"s1"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}',
    '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"API Error: 529 Overloaded","requestId":"req_018XYZ"}',
  ].join("\n");
  const diagnostic = engineDetourFailureDiagnostic({
    stderr: "",
    code: 1,
    stdout,
  });
  assert.match(
    diagnostic,
    /API Error: 529 Overloaded/,
    "typed failure diagnostic must contain the child's terminal error row",
  );
  assert.notEqual(
    diagnostic,
    "engine detour exited with code 1",
    "exit-code-only string that swallows the cause is the #395 bug",
  );
});

test("#395: empty stderr + whitespace-tailed stdout — last non-empty row carried", () => {
  const stdout = '{"type":"result","is_error":true,"result":"boom"}\n\n';
  const diagnostic = engineDetourFailureDiagnostic({
    stderr: "   \n",
    code: 1,
    stdout,
  });
  assert.match(diagnostic, /\{"type":"result","is_error":true,"result":"boom"\}/);
});

test("non-empty stderr still returned verbatim (unchanged)", () => {
  const diagnostic = engineDetourFailureDiagnostic({
    stderr: "engine blew up\n",
    code: 1,
    stdout: "",
  });
  assert.equal(diagnostic, "engine blew up\n");
});

test("empty stderr + empty stdout still yields stable constant (unchanged)", () => {
  const diagnostic = engineDetourFailureDiagnostic({
    stderr: "",
    code: 0,
    stdout: "",
  });
  assert.equal(diagnostic, ENGINE_DETOUR_EMPTY_STDOUT_DIAGNOSTIC);
});
