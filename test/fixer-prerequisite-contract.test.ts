import assert from "node:assert/strict";
import test from "node:test";

import {
  parseFixerPrerequisites,
  type FixerInvocationInput,
} from "../src/package-contracts/fixer-packet.ts";
import {
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

test("opaque fixer prose is independent of the frozen typed prerequisite attachment", () => {
  const prerequisites = parseFixerPrerequisites(prerequisitesText);
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
    [JSON.stringify([{ id: "bad\/id", requirement: "x" }]), /id.*pattern/],
    [JSON.stringify([{ id: "x", requirement: " " }]), /requirement.*nonblank/],
    [JSON.stringify([{ id: "x", requirement: "x", extra: true }]), /entry.*fields/],
    [JSON.stringify([{ id: "Same", requirement: "x" }, { id: "Same", requirement: "y" }]), /duplicate.*id/],
  ];
  for (const [source, diagnostic] of invalid) assert.throws(() => parseFixerPrerequisites(source), diagnostic);
  assert.doesNotThrow(() => parseFixerPrerequisites(JSON.stringify([{ id: "Same", requirement: "x" }, { id: "same", requirement: "y" }])));
});

test("prerequisite_unmet cites a declared typed prerequisite identity", () => {
  assert.deepEqual(validateFixerOutputForPacket(planRefusal, "plan", input()), planRefusal);
  assert.throws(
    () => validateFixerOutputForPacket({ ...planRefusal, blocker: { ...planRefusal.blocker, prerequisiteId: "undeclared" } }, "plan", input()),
    /prerequisiteId.*declared/,
  );
  assert.throws(() => validateFixerOutputForPacket(planRefusal, "plan", input(Object.freeze([]))), /prerequisiteId.*declared/);
});
