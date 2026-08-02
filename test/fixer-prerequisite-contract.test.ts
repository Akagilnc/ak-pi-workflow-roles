import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";

import { namedActivationCause } from "../src/activation-trace.ts";
import {
  FixerPacketValidationError,
  fixerPrerequisitesSchema,
  parseFixerPrerequisites,
  type FixerInvocationInput,
} from "../src/package-contracts/fixer-packet.ts";
import {
  fixerOutputSchema,
  validateFixerOutput,
  validateFixerOutputForPacket,
} from "../src/package-contracts/fixer-output.ts";

const instructions = "# Repair packet\n\n保留 Unicode and `{ JSON-looking prose }` exactly.\n";
const prerequisitesText = JSON.stringify([
  { id: "owner.choice-1", requirement: "  Owner selects the public contract.  " },
  { id: "artifact_A", requirement: "Build artifact exists." },
]);

function input(prerequisites = parseFixerPrerequisites(prerequisitesText)): FixerInvocationInput {
  return Object.freeze({ instructions, prerequisites });
}

const planRefusal = {
  status: "refused" as const,
  report: "Cannot lawfully plan yet.",
  remainingScope: "contract selection",
  blocker: { cause: "prerequisite_unmet" as const, prerequisiteId: "owner.choice-1", evidence: "No owner choice is recorded." },
};
const applyRefusal = {
  status: "refused" as const,
  report: "Blocked.",
  classResults: [{
    name: "Artifact",
    disposition: "refused" as const,
    remainingScope: "artifact consumer",
    blocker: { cause: "prerequisite_unmet" as const, prerequisiteId: "artifact_A", evidence: "Artifact is absent." },
  }],
};

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

test("typed prerequisite blockers cross the public TypeBox schema and prerequisite-aware production validator", () => {
  const invocation = input();
  for (const [phase, candidate] of [["plan", planRefusal], ["apply", applyRefusal]] as const) {
    assert.equal(Value.Check(fixerOutputSchema, candidate), true);
    assert.deepEqual(validateFixerOutput(candidate, phase), candidate);
    assert.deepEqual(validateFixerOutputForPacket(candidate, phase, invocation), candidate);
  }
});

test("current leaves reject old, malformed, and undeclared prerequisite references in plan and apply", () => {
  const invocation = mutableInput();
  const blockers = [
    { cause: "prerequisite_unmet", evidence: "old missing-ID leaf" },
    { cause: "prerequisite_unmet", prerequisiteId: "bad/id", evidence: "malformed" },
    { cause: "prerequisite_unmet", prerequisiteId: "undeclared", evidence: "not declared" },
  ];
  for (const [index, blocker] of blockers.entries()) {
    const plan = { ...planRefusal, blocker };
    const refusedLeaf = { ...applyRefusal.classResults[0], blocker };
    const apply = { ...applyRefusal, classResults: [refusedLeaf] };
    const mixed = { status: "partially_completed", report: "Mixed.", classResults: [{ name: "Done", disposition: "completed", searchScope: "all", exceptions: [], commitSha: "a".repeat(40) }, refusedLeaf] };
    assert.equal(Value.Check(fixerOutputSchema, plan), index === 2, `TypeBox plan blocker ${index}`);
    assert.equal(Value.Check(fixerOutputSchema, apply), index === 2, `TypeBox apply blocker ${index}`);
    assert.throws(() => validateFixerOutputForPacket(plan, "plan", invocation), /Fixer output/);
    assert.throws(() => validateFixerOutputForPacket(apply, "apply", invocation), /Fixer output/);
    assert.throws(() => validateFixerOutputForPacket(mixed, "apply", invocation), /Fixer output/);
  }
  const decorated = { ...planRefusal, blocker: { ...planRefusal.blocker, presentation: true } };
  assert.equal(Value.Check(fixerOutputSchema, decorated), true);
  assert.deepEqual(validateFixerOutputForPacket(decorated, "plan", invocation), planRefusal);
  const empty = input(Object.freeze([]));
  assert.throws(() => validateFixerOutputForPacket(planRefusal, "plan", empty), /prerequisiteId.*declared/);
  assert.throws(() => validateFixerOutputForPacket(applyRefusal, "apply", empty), /prerequisiteId.*declared/);
  assert.throws(() => validateFixerOutputForPacket({ status: "partially_completed", report: "Mixed.", classResults: [{ name: "Done", disposition: "completed", searchScope: "all", exceptions: [], commitSha: "a".repeat(40) }, applyRefusal.classResults[0]] }, "apply", empty), /prerequisiteId.*declared/);
});

test("zero declarations preserve authority refusal, completed apply, and existing settlement combinations", () => {
  const invocation = input(Object.freeze([]));
  const authority = { status: "refused" as const, report: "Forbidden.", remainingScope: "outside authority", blocker: { cause: "authority_violation" as const, evidence: "Owner excluded it." } };
  const completed = { status: "completed" as const, report: "Done.", classResults: [{ name: "Contract", disposition: "completed" as const, searchScope: "all", exceptions: [], commitSha: "a".repeat(40) }] };
  assert.deepEqual(validateFixerOutputForPacket(authority, "plan", invocation), authority);
  assert.deepEqual(validateFixerOutputForPacket(completed, "apply", invocation), completed);
});
