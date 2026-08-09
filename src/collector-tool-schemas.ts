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
    legId: Type.String({ minLength: 1, description: "Configured Collector leg to request." }),
    snapshotId: Type.String({ minLength: 1, description: "Latest retained observation snapshot supporting the request." }),
  },
  { additionalProperties: false },
);

export const collectorWaitArgsSchema = Type.Object(
  {
    durationMs: Type.Integer({
      minimum: 1,
      maximum: COLLECTOR_ELIGIBILITY_MS,
      description: "Bounded wait duration before Collector reassesses current evidence.",
    }),
  },
  { additionalProperties: false },
);

const collectorValidLegSchema = Type.Object(
  {
    legId: Type.String({ minLength: 1, description: "Configured Collector leg being settled." }),
    status: Type.Literal("valid", { description: "Leg has qualifying current-target evidence." }),
    rationale: Type.String({ minLength: 1, pattern: "\\S", description: "Evidence-grounded classification rationale." }),
    evidenceRefs: Type.Array(nonEmptyString, { minItems: 1, description: "Retained ledger evidence supporting this classification." }),
  },
  { additionalProperties: false },
);

const collectorUnavailableLegSchema = Type.Object(
  {
    legId: Type.String({ minLength: 1, description: "Configured Collector leg being settled." }),
    status: Type.Literal("unavailable", { description: "Leg cannot be obtained within an identified scope." }),
    rationale: Type.String({ minLength: 1, pattern: "\\S", description: "Evidence-grounded classification rationale." }),
    evidenceRefs: Type.Array(nonEmptyString, { minItems: 1, description: "Retained ledger evidence supporting this classification." }),
    unavailableScope: Type.Union([
      Type.Literal("target"),
      Type.Literal("global"),
    ], { description: "Whether unavailability applies only to this target or globally." }),
  },
  { additionalProperties: false },
);

const collectorMissingLegSchema = Type.Object(
  {
    legId: Type.String({ minLength: 1, description: "Configured Collector leg being settled." }),
    status: Type.Literal("missing", { description: "Leg lacks qualifying current-target evidence at cutoff." }),
    rationale: Type.String({ minLength: 1, pattern: "\\S", description: "Evidence-grounded classification rationale." }),
    evidenceRefs: Type.Array(nonEmptyString, { minItems: 1, description: "Retained ledger evidence supporting this classification." }),
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
    legs: Type.Optional(Type.Array(collectorOutputLegSchema, { minItems: 1, description: "One truthful result for each admitted Collector leg." })),
  },
  { additionalProperties: true },
);

(collectorOutputArgsSchema as unknown as { required: string[] }).required = [];

export type CollectorObserveArgs = Static<typeof collectorObserveArgsSchema>;
export type CollectorRequestArgs = Static<typeof collectorRequestArgsSchema>;
export type CollectorWaitArgs = Static<typeof collectorWaitArgsSchema>;
export type CollectorOutputArgs = Static<typeof collectorOutputArgsSchema>;
export type CollectorOutputLegArgs = Static<typeof collectorOutputLegSchema>;
