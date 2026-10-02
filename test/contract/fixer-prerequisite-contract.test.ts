import assert from "node:assert/strict";
import test from "node:test";

import { namedActivationCause } from "../../src/activation-trace.ts";
import {
  FixerPacketValidationError,
  parseFixerPrerequisites,
} from "../../src/package-contracts/fixer-packet.ts";

function captureValidationError(source: string): FixerPacketValidationError {
  let caught: unknown;
  try {
    parseFixerPrerequisites(source);
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof FixerPacketValidationError)) {
    throw new Error("expected a typed Fixer packet validation error");
  }
  return caught;
}

test("prerequisite attachment failures retain typed identity for each invalid shape", () => {
  const invalid = [
    "{",
    JSON.stringify({ prerequisites: [] }),
    JSON.stringify([{ id: "bad/id", requirement: "x" }]),
    JSON.stringify([{ id: "x", requirement: " " }]),
    JSON.stringify([{ id: "Same", requirement: "x" }, { id: "Same", requirement: "y" }]),
  ];
  for (const source of invalid) assert.throws(() => parseFixerPrerequisites(source), FixerPacketValidationError);
  assert.doesNotThrow(() => parseFixerPrerequisites(JSON.stringify([{ id: "Same", requirement: "x" }, { id: "same", requirement: "y" }])));
});

test("malformed prerequisite attachments keep their true causes behind one stable typed identity", () => {
  const syntax = captureValidationError("{");
  assert.ok(syntax.cause instanceof SyntaxError);
  const named = namedActivationCause(syntax);
  assert.equal(named.identity, "AK_INVALID_FIX_PACKET");
  assert.equal(named.name, "FixerPacketValidationError");

  const shape = captureValidationError(JSON.stringify({ prerequisites: [] }));
  assert.ok(shape.cause instanceof Error);

  const duplicate = captureValidationError(JSON.stringify([
    { id: "same", requirement: "first" },
    { id: "same", requirement: "second" },
  ]));
  assert.ok(duplicate.cause instanceof Error);
});
