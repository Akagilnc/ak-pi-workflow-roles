import assert from "node:assert/strict";
import test from "node:test";
import { Type, type Static } from "typebox";

import { stringEnum } from "../../src/typebox-string-enum.ts";
import { observePackagedMethodSkillInvocation } from "../../src/package-resources/method-skill.ts";

const phaseSchema = stringEnum(["plan", "apply"] as const, {
  description: "Execution phase.",
});
type Phase = Static<typeof phaseSchema>;
const phase: Phase = "apply";
void phase;

// Compile-time inference guard: the helper must not widen literals to string.
// @ts-expect-error not a member of the enum
const invalidPhase: Phase = "review";
void invalidPhase;

test("package string enum emits the Google-compatible schema shape", () => {
  assert.deepEqual(phaseSchema, {
    type: "string",
    enum: ["plan", "apply"],
    description: "Execution phase.",
  });
  assert.deepEqual(Type.Object({ phase: phaseSchema }), {
    type: "object",
    required: ["phase"],
    properties: {
      phase: {
        type: "string",
        enum: ["plan", "apply"],
        description: "Execution phase.",
      },
    },
  });
});

test("package skill observer preserves the complete native expansion identity", () => {
  const location = "/package/resources/method-skills/tdd/SKILL.md";
  const content = "References are relative to /package/resources/method-skills/tdd.\n\n# TDD";
  const request = "Implement the approved slice.";
  const expansion = `<skill name="tdd" location="${location}">\n${content}\n</skill>\n\n${request}`;

  assert.deepEqual(
    observePackagedMethodSkillInvocation(expansion, {
      name: "tdd",
      allowedLocations: [location],
      includeExpansionIdentity: true,
    }),
    { name: "tdd", location, content, userMessage: request },
  );
  assert.deepEqual(
    observePackagedMethodSkillInvocation(`${expansion}\nassistant prose`, {
      name: "tdd",
      allowedLocations: [location],
      includeExpansionIdentity: true,
    }),
    {
      name: "tdd",
      location,
      content,
      userMessage: `${request}\nassistant prose`,
    },
  );
  assert.equal(
    observePackagedMethodSkillInvocation(expansion.replace("</skill>\n\n", "</skill>\n"), {
      name: "tdd",
      allowedLocations: [location],
      includeExpansionIdentity: true,
    }),
    undefined,
  );
});
