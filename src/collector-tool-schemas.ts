import { Type, type Static } from "typebox";

import { COLLECTOR_ELIGIBILITY_MS } from "./collector-evidence.ts";

/** Non-blank string: must contain at least one non-whitespace character. */
const nonBlankString = Type.String({ minLength: 1, pattern: "\\S" });
const nonEmptyString = Type.String({ minLength: 1 });

export const collectorObserveArgsSchema = Type.Object(
  {},
  { additionalProperties: false },
);

export const collectorRequestArgsSchema = Type.Object(
  {
    legId: nonEmptyString,
    snapshotId: nonEmptyString,
  },
  { additionalProperties: false },
);

export const collectorWaitArgsSchema = Type.Object(
  {
    durationMs: Type.Integer({
      minimum: 1,
      maximum: COLLECTOR_ELIGIBILITY_MS,
    }),
  },
  { additionalProperties: false },
);

const collectorValidLegSchema = Type.Object(
  {
    legId: nonEmptyString,
    status: Type.Literal("valid"),
    rationale: nonBlankString,
    evidenceRefs: Type.Array(nonEmptyString, { minItems: 1 }),
  },
  { additionalProperties: false },
);

const collectorUnavailableLegSchema = Type.Object(
  {
    legId: nonEmptyString,
    status: Type.Literal("unavailable"),
    rationale: nonBlankString,
    evidenceRefs: Type.Array(nonEmptyString, { minItems: 1 }),
    unavailableScope: Type.Union([
      Type.Literal("target"),
      Type.Literal("global"),
    ]),
  },
  { additionalProperties: false },
);

const collectorMissingLegSchema = Type.Object(
  {
    legId: nonEmptyString,
    status: Type.Literal("missing"),
    rationale: nonBlankString,
    evidenceRefs: Type.Array(nonEmptyString, { minItems: 1 }),
  },
  { additionalProperties: false },
);

/** Status-discriminated leg union; unavailableScope required only on unavailable. */
export const collectorOutputLegSchema = Type.Union([
  collectorValidLegSchema,
  collectorUnavailableLegSchema,
  collectorMissingLegSchema,
]);

export const collectorOutputArgsSchema = Type.Object(
  {
    legs: Type.Array(collectorOutputLegSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export type CollectorObserveArgs = Static<typeof collectorObserveArgsSchema>;
export type CollectorRequestArgs = Static<typeof collectorRequestArgsSchema>;
export type CollectorWaitArgs = Static<typeof collectorWaitArgsSchema>;
export type CollectorOutputArgs = Static<typeof collectorOutputArgsSchema>;
export type CollectorOutputLegArgs = Static<typeof collectorOutputLegSchema>;
