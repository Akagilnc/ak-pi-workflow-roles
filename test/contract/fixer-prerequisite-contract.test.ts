import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";

import { namedActivationCause } from "../../src/activation-trace.ts";
import {
  FixerPacketValidationError,
  fixerPrerequisitesSchema,
  parseFixerPrerequisites,
  type FixerInvocationInput,
} from "../../src/package-contracts/fixer-packet.ts";

const instructions = "# Repair packet\n\n保留 Unicode and `{ JSON-looking prose }` exactly.\n";
const prerequisitesText = JSON.stringify([
  { id: "owner.choice-1", requirement: "  Owner selects the public contract.  " },
  { id: "artifact_A", requirement: "Build artifact exists." },
]);

function input(prerequisites = parseFixerPrerequisites(prerequisitesText)): FixerInvocationInput {
  return Object.freeze({ instructions, prerequisites });
}

function mutableInput(): FixerInvocationInput {
  return {
    instructions: "Repair exactly what is assigned.",
    prerequisites: [{ id: "owner.choice-1", requirement: "Owner selects the contract." }],
  };
}

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

test("opaque fixer prose is independent of the frozen typed prerequisite attachment", () => {
  const prerequisites = parseFixerPrerequisites(prerequisitesText);
  assert.equal(Value.Check(fixerPrerequisitesSchema, JSON.parse(prerequisitesText)), true);
  assert.equal(input(prerequisites).instructions, instructions);
  assert.deepEqual(prerequisites, JSON.parse(prerequisitesText));
  assert.equal(Object.isFrozen(prerequisites), true);
  assert.equal(Object.isFrozen(prerequisites[0]), true);
  assert.throws(() => { (prerequisites as any).push({ id: "later", requirement: "late" }); }, TypeError);
});

test("prerequisite attachment failures name the violated field or constraint", () => {
  const invalid: Array<[string, RegExp]> = [
    ["{", /JSON/],
    [JSON.stringify({ prerequisites: [] }), /array/],
    [JSON.stringify([{ id: "bad/id", requirement: "x" }]), /id.*pattern/],
    [JSON.stringify([{ id: "x", requirement: " " }]), /requirement.*nonblank/],
    [JSON.stringify([{ id: "x", requirement: "x", extra: true }]), /entry.*fields/],
    [JSON.stringify([{ id: "Same", requirement: "x" }, { id: "Same", requirement: "y" }]), /duplicate.*id/],
  ];
  for (const [source, diagnostic] of invalid) assert.throws(() => parseFixerPrerequisites(source), diagnostic);
  assert.doesNotThrow(() => parseFixerPrerequisites(JSON.stringify([{ id: "Same", requirement: "x" }, { id: "same", requirement: "y" }])));
});

test("malformed prerequisite attachments keep their true causes behind one stable typed identity", () => {
  const syntax = captureValidationError("{");
  assert.ok(syntax.cause instanceof SyntaxError);
  const named = namedActivationCause(syntax);
  assert.equal(named.identity, "AK_INVALID_FIX_PACKET");
  assert.equal(named.name, "FixerPacketValidationError");
  assert.match(named.message, /prerequisites or instructions/);

  const shape = captureValidationError(JSON.stringify({ prerequisites: [] }));
  assert.ok(shape.cause instanceof Error);
  assert.match(shape.cause.message, /JSON array/);

  const duplicate = captureValidationError(JSON.stringify([
    { id: "same", requirement: "first" },
    { id: "same", requirement: "second" },
  ]));
  assert.ok(duplicate.cause instanceof Error);
  assert.match(duplicate.cause.message, /duplicate id: same/);
});
