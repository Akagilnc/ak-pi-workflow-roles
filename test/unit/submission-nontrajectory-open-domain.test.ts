/**
 * #1134 — class-wide regression: non-trajectory submission fields carry no
 * format constraint on any seat, any host.
 *
 * The root cause of ak-fund-advisor #111 is that the package declaration IS the
 * validator hermes runs before dispatch: a `classResults` anyOf / array /
 * nested-object declaration kept `{"item": [...]}` out of the tool entirely, so
 * the Fixer wrote class settlement into prose and the run ended
 * `ak-tool-execution-failed`. Owner 9ed9fa43-e814-40c4-afe6-879767bc6daf ruled
 * the boundary: 只有需要拿来判断走势的字段，才有格式/枚举要求.
 *
 * So this table is the inverse of submission-status-open-domain.test.ts: that
 * one proves an unknown `status` still reaches the host, this one proves every
 * OTHER field reaches the host whatever shape the seat writes it in — array,
 * object, `{"item": [...]}`, bare string, or omitted. Table-driven across every
 * packaged seat (ADR 0045: scan the class, not the reported instance), and each
 * seat is checked on both the raw TypeBox declaration handed to
 * `registerTool({ parameters })` and the Codex/OpenAI-strict transport
 * projection that host actually sends, so a host projection cannot quietly
 * re-add a constraint the package deleted.
 *
 * Trajectory fields are deliberately absent from the probe set: their legal
 * words ride the field description, and the three-state review field keeps its
 * owner-approved required enum (owner 1707c6ec-ac17-4876-97d1-73b57c734259
 * 「那就改」). Per souls/quality-law.md this asserts behavior the package owns —
 * what the host is allowed to reject — not the prose of any description.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { TSchema } from "typebox";
import { Value } from "typebox/value";

import { closeJsonSchemaForCodex } from "../../src/headless-host/description.ts";
import { terminatingToolJsonSchema } from "../../src/role-envelope.ts";

import { coderOutputSchema } from "../../src/worker-role.ts";
import { fixerOutputSchema } from "../../src/package-contracts/fixer-output.ts";
import { reviewerOutputSchema } from "../../src/reviewer-role.ts";
import { doctorSubmissionSchema } from "../../src/doctor-contracts.ts";
import { mergerOutputSchema } from "../../src/merger-contracts.ts";
import { collectorOutputArgsSchema } from "../../src/collector-tool-schemas.ts";
import { gleanerLeftOutputSchema } from "../../src/gleaner-left-role.ts";
import { diaristOutputSchema } from "../../src/diarist-role.ts";
import { secretariatVerdictSchema } from "../../src/secretariat-role.ts";
import { gatekeeperDecisionSchema } from "../../src/package-contracts/gatekeeper-output.ts";
import { navigatorOutputSchema } from "../../src/package-contracts/navigator-output.ts";

/** Every shape ak-fund #111's Fixer could plausibly write a settlement in. */
const SHAPES: ReadonlyArray<readonly [string, unknown]> = [
  ["array", [{ name: "ParserCase", disposition: "completed" }]],
  ["object", { name: "ParserCase", disposition: "completed" }],
  ["item-wrapper", { item: [] }],
  ["string", "逐类结算：ParserCase 已完成"],
  ["nested-object", { cases: [{ name: "A", disposition: "refused" }] }],
];

type Seat = {
  readonly seat: string;
  readonly schema: TSchema;
  /** A lawful trajectory word, so the probe differs only in the field under test. */
  readonly trajectory: Readonly<Record<string, unknown>>;
  /** Non-trajectory fields this seat declares. */
  readonly fields: readonly string[];
};

const SEATS: readonly Seat[] = [
  {
    seat: "coder",
    schema: coderOutputSchema,
    trajectory: { status: "completed" },
    fields: ["report", "remainingScope", "reason"],
  },
  {
    seat: "fixer",
    schema: fixerOutputSchema,
    trajectory: { status: "completed" },
    fields: ["report", "remainingScope", "blocker", "reason", "classResults", "testEvidence"],
  },
  {
    seat: "reviewer",
    schema: reviewerOutputSchema,
    trajectory: { status: "completed" },
    fields: ["amendments", "diagnostic"],
  },
  {
    seat: "doctor",
    schema: doctorSubmissionSchema,
    trajectory: { status: "completed" },
    fields: ["case", "findings", "reason", "missingEvidence"],
  },
  {
    seat: "merger",
    schema: mergerOutputSchema,
    trajectory: { status: "completed" },
    fields: ["attemptId", "report", "mergeCommitId", "diagnosis"],
  },
  {
    seat: "collector",
    schema: collectorOutputArgsSchema,
    trajectory: {},
    fields: ["groups", "unfinishedReasons"],
  },
  {
    seat: "gleaner-left",
    schema: gleanerLeftOutputSchema,
    trajectory: { status: "completed" },
    fields: ["findings"],
  },
  {
    seat: "diarist",
    schema: diaristOutputSchema,
    trajectory: { status: "completed" },
    fields: ["ticketNumber", "reason", "sessions", "ticketSessions"],
  },
  {
    seat: "secretariat",
    schema: secretariatVerdictSchema,
    trajectory: { secretariatStatus: "converged" },
    fields: ["ticketNumber", "note", "evidence", "decisionGate"],
  },
  {
    seat: "gatekeeper",
    schema: gatekeeperDecisionSchema,
    trajectory: { status: "pass" },
    fields: ["officer", "findings"],
  },
  {
    seat: "navigator",
    schema: navigatorOutputSchema,
    trajectory: {},
    fields: ["prose"],
  },
];

test("every non-trajectory submission field accepts every shape on the package declaration", () => {
  for (const seat of SEATS) {
    for (const field of seat.fields) {
      for (const [shape, value] of SHAPES) {
        const payload = { ...seat.trajectory, [field]: value };
        assert.equal(
          Value.Check(seat.schema, payload),
          true,
          `${seat.seat}.${field} as ${shape} must reach the host`,
        );
      }
      // Omitted entirely stays lawful: nothing is required but the trajectory read.
      assert.equal(
        Value.Check(seat.schema, { ...seat.trajectory }),
        true,
        `${seat.seat} without ${field} must reach the host`,
      );
    }
  }
});

test("the Codex strict transport projection does not re-add a constraint the package deleted", () => {
  for (const seat of SEATS) {
    const closed = closeJsonSchemaForCodex(terminatingToolJsonSchema(seat.schema)) as {
      properties?: Record<string, unknown>;
      required?: readonly string[];
    };
    const properties = closed.properties ?? {};
    // Under strict transport every property is present-or-null, so probe each
    // declared field against every shape with the rest of the envelope nulled.
    for (const field of seat.fields) {
      for (const [shape, value] of SHAPES) {
        const probe = Object.fromEntries(
          Object.keys(properties).map((name) => [name, name === field ? value : null]),
        );
        assert.equal(
          Value.Check(closed, probe),
          true,
          `${seat.seat}.${field} as ${shape} must survive the Codex projection`,
        );
      }
    }
  }
});

test("the trajectory field keeps its owner-approved declaration on every seat", () => {
  for (const seat of SEATS) {
    const properties = (seat.schema as { properties?: Record<string, { description?: unknown }> })
      .properties ?? {};
    for (const name of Object.keys(seat.trajectory)) {
      assert.equal(
        typeof properties[name]?.description,
        "string",
        `${seat.seat}.${name} must keep the description that names its legal words`,
      );
    }
  }
});