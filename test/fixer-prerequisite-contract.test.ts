import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";

import { namedActivationCause } from "../src/activation-trace.ts";
import {
  FixPacketValidationError,
  fixerPacketV1Schema,
  parseFixPacketV1,
  type FixPacketV1,
} from "../src/package-contracts/fixer-packet.ts";
import {
  fixerOutputSchema,
  validateFixerOutput,
  validateFixerOutputForPacket,
} from "../src/package-contracts/fixer-output.ts";

const packetText = JSON.stringify({
  version: 1,
  instructions: "  Keep this opaque: # heading and prerequisite-looking prose.  ",
  prerequisites: [
    { id: "owner.choice-1", requirement: "  Owner selects the public contract.  " },
    { id: "artifact_A", requirement: "Build artifact exists." },
  ],
});

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

function mutablePacket(): FixPacketV1 {
  return {
    version: 1,
    instructions: "Repair exactly what is assigned.",
    prerequisites: [{ id: "owner.choice-1", requirement: "Owner selects the contract." }],
  };
}

function captureValidationError(source: string): FixPacketValidationError {
  let caught: unknown;
  try {
    parseFixPacketV1(source);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof FixPacketValidationError);
  return caught;
}

test("FixPacketV1 parser admits only the closed JSON contract, preserves opaque strings, and freezes the invocation input", () => {
  const packet = parseFixPacketV1(packetText);
  assert.equal(Value.Check(fixerPacketV1Schema, JSON.parse(packetText)), true);
  assert.deepEqual(packet, JSON.parse(packetText));
  assert.equal(Object.isFrozen(packet), true);
  assert.equal(Object.isFrozen(packet.prerequisites), true);
  assert.equal(Object.isFrozen(packet.prerequisites[0]), true);
  assert.throws(() => { (packet.prerequisites as any).push({ id: "later", requirement: "late" }); }, TypeError);
});

test("FixPacketV1 hard-cuts legacy Markdown and malformed, extra, blank, or duplicate declarations", () => {
  const invalid = [
    "# Legacy repair packet",
    "{",
    JSON.stringify({ version: 2, instructions: "repair", prerequisites: [] }),
    JSON.stringify({ version: 1, instructions: " ", prerequisites: [] }),
    JSON.stringify({ version: 1, instructions: "repair", prerequisites: [], extra: true }),
    JSON.stringify({ version: 1, instructions: "repair", prerequisites: [{ id: "bad/id", requirement: "x" }] }),
    JSON.stringify({ version: 1, instructions: "repair", prerequisites: [{ id: "x", requirement: " " }] }),
    JSON.stringify({ version: 1, instructions: "repair", prerequisites: [{ id: "Same", requirement: "x" }, { id: "Same", requirement: "y" }] }),
  ];
  for (const source of invalid) assert.throws(() => parseFixPacketV1(source), /FixPacketV1/);
  assert.doesNotThrow(() => parseFixPacketV1(JSON.stringify({ version: 1, instructions: "repair", prerequisites: [{ id: "Same", requirement: "x" }, { id: "same", requirement: "y" }] })));
});

test("invalid packets retain their true cause without changing the stable activation identity", () => {
  const syntax = captureValidationError("{");
  assert.ok(syntax.cause instanceof SyntaxError);
  assert.deepEqual(namedActivationCause(syntax), {
    identity: "AK_INVALID_FIX_PACKET",
    name: "FixPacketValidationError",
    message: "FixPacketV1 violates the exact packet contract",
  });

  const schema = captureValidationError(JSON.stringify({ version: "not-v1" }));
  assert.ok(schema.cause instanceof Error);
  assert.match(schema.cause.message, /FixPacketV1 schema validation failed/);

  const duplicate = captureValidationError(JSON.stringify({
    version: 1,
    instructions: "repair",
    prerequisites: [{ id: "same", requirement: "first" }, { id: "same", requirement: "second" }],
  }));
  assert.ok(duplicate.cause instanceof Error);
  assert.match(duplicate.cause.message, /duplicate prerequisite id: same/);
});

test("typed prerequisite blockers cross the public TypeBox schema and packet-aware production validator", () => {
  const packet = parseFixPacketV1(packetText);
  for (const [phase, candidate] of [["plan", planRefusal], ["apply", applyRefusal]] as const) {
    assert.equal(Value.Check(fixerOutputSchema, candidate), true);
    assert.deepEqual(validateFixerOutput(candidate, phase), candidate);
    assert.deepEqual(validateFixerOutputForPacket(candidate, phase, packet), candidate);
  }
});

test("current leaves reject old, malformed, extra, and undeclared prerequisite references in plan and apply", () => {
  const packet = mutablePacket();
  const blockers = [
    { cause: "prerequisite_unmet", evidence: "old missing-ID leaf" },
    { cause: "prerequisite_unmet", prerequisiteId: "bad/id", evidence: "malformed" },
    { cause: "prerequisite_unmet", prerequisiteId: "undeclared", evidence: "not declared" },
    { cause: "prerequisite_unmet", prerequisiteId: "owner.choice-1", evidence: "x", extra: true },
  ];
  for (const [index, blocker] of blockers.entries()) {
    const plan = { ...planRefusal, blocker };
    const refusedLeaf = { ...applyRefusal.classResults[0], blocker };
    const apply = { ...applyRefusal, classResults: [refusedLeaf] };
    const mixed = { status: "partially_completed", report: "Mixed.", classResults: [{ name: "Done", disposition: "completed", searchScope: "all", exceptions: [], commitSha: "a".repeat(40) }, refusedLeaf] };
    assert.equal(Value.Check(fixerOutputSchema, plan), index === 2, `TypeBox plan blocker ${index}`);
    assert.equal(Value.Check(fixerOutputSchema, apply), index === 2, `TypeBox apply blocker ${index}`);
    assert.throws(() => validateFixerOutputForPacket(plan, "plan", packet), /Fixer output/);
    assert.throws(() => validateFixerOutputForPacket(apply, "apply", packet), /Fixer output/);
    assert.throws(() => validateFixerOutputForPacket(mixed, "apply", packet), /Fixer output/);
  }
  const empty = { version: 1, instructions: "repair", prerequisites: [] } satisfies FixPacketV1;
  assert.throws(() => validateFixerOutputForPacket(planRefusal, "plan", empty), /Fixer output/);
  assert.throws(() => validateFixerOutputForPacket(applyRefusal, "apply", empty), /Fixer output/);
  assert.throws(() => validateFixerOutputForPacket({ status: "partially_completed", report: "Mixed.", classResults: [{ name: "Done", disposition: "completed", searchScope: "all", exceptions: [], commitSha: "a".repeat(40) }, applyRefusal.classResults[0]] }, "apply", empty), /Fixer output/);
});

test("zero declarations preserve authority refusal, completed apply, and existing settlement combinations", () => {
  const packet = parseFixPacketV1(JSON.stringify({ version: 1, instructions: "repair", prerequisites: [] }));
  const authority = { status: "refused" as const, report: "Forbidden.", remainingScope: "outside authority", blocker: { cause: "authority_violation" as const, evidence: "Owner excluded it." } };
  const completed = { status: "completed" as const, report: "Done.", classResults: [{ name: "Contract", disposition: "completed" as const, searchScope: "all", exceptions: [], commitSha: "a".repeat(40) }] };
  assert.deepEqual(validateFixerOutputForPacket(authority, "plan", packet), authority);
  assert.deepEqual(validateFixerOutputForPacket(completed, "apply", packet), completed);
});
