/**
 * Package-owned shared infrastructure-failure declaration for every primary
 * packaged-role output tool (#541).
 *
 * One module owns what the judge mandates be shared (not reimplemented per
 * seat): the typed `infrastructureFailure.diagnostic` declaration composed into
 * each output tool's schema, and the single early host `failInfrastructure`
 * call each output `execute` makes before any role business validation / gate /
 * audit / ledger / Git work. The accepted status sets are intentionally NOT
 * extended: an infra declaration fails BEFORE accepted validation, never
 * becomes an accepted receipt. The diagnostic is carried verbatim on the thrown
 * Error so settlement keeps the original cause (kind=failure, exit 1).
 */
import { Type, type TSchema } from "typebox";
import type { CorrectableSubmissionError } from "../submission-correctable-error.ts";

export const INFRASTRUCTURE_FAILURE_DECLARATION_KEY =
  "infrastructureFailure" as const;
export const INFRASTRUCTURE_FAILURE_DIAGNOSTIC_KEY = "diagnostic" as const;

/** Shared typed declaration fragment: `infrastructureFailure.diagnostic` = non-empty string. */
const infrastructureFailureDeclarationSchema = Type.Object(
  {
    [INFRASTRUCTURE_FAILURE_DECLARATION_KEY]: Type.Object(
      {
        [INFRASTRUCTURE_FAILURE_DIAGNOSTIC_KEY]: Type.String({
          minLength: 1,
          description: "非空基础设施失败诊断",
        }),
      },
      {
        additionalProperties: true,
        description: "基础设施失败声明",
      },
    ),
  },
  { additionalProperties: true },
);

/**
 * Compose the shared infrastructure-failure declaration into an open output
 * tool-object schema. Returns an open object (additionalProperties: true,
 * required: []) with the base schema's properties plus the shared declaration.
 * Static typing is preserved on the base (`as S`), so existing
 * `Static<typeof ...>` derived parameter types are unchanged.
 */
export function withInfrastructureFailureDeclaration<
  S extends TSchema & { properties?: Record<string, TSchema> },
>(schema: S): S {
  const baseProperties = (schema as { properties?: Record<string, TSchema> })
    .properties;
  const properties: Record<string, TSchema> = {
    ...(baseProperties ?? {}),
    [INFRASTRUCTURE_FAILURE_DECLARATION_KEY]:
      infrastructureFailureDeclarationSchema.properties[
        INFRASTRUCTURE_FAILURE_DECLARATION_KEY
      ],
  };
  const object = Type.Object(properties, { additionalProperties: true });
  (object as unknown as { required: string[] }).required = [];
  return object as unknown as S;
}

/** Structural host seam subset shared by every terminating execute path. */
type TerminatingInfrastructureHostActions<C> = {
  failInfrastructure(error: unknown, ctx: C, toolCallId?: string): never;
};

/** Safe recognition of the typed declaration; non-shapes / hostile input fail closed. */
function isInfrastructureFailureDeclaration(
  parameters: unknown,
): boolean {
  if (
    parameters === null ||
    typeof parameters !== "object" ||
    Array.isArray(parameters)
  ) {
    return false;
  }
  const record = parameters as Record<string, unknown>;
  if (!Object.hasOwn(record, INFRASTRUCTURE_FAILURE_DECLARATION_KEY)) return false;
  const declaration = record[INFRASTRUCTURE_FAILURE_DECLARATION_KEY];
  if (
    declaration === null ||
    typeof declaration !== "object" ||
    Array.isArray(declaration)
  ) {
    return false;
  }
  const diagnostic = (declaration as Record<string, unknown>)[
    INFRASTRUCTURE_FAILURE_DIAGNOSTIC_KEY
  ];
  return typeof diagnostic === "string" && diagnostic.trim().length > 0;
}

/** Non-empty trimmed diagnostic from the declaration, else undefined. */
function infrastructureFailureDiagnostic(
  parameters: unknown,
): string | undefined {
  if (!isInfrastructureFailureDeclaration(parameters)) return undefined;
  const declaration = (parameters as Record<string, unknown>)[
    INFRASTRUCTURE_FAILURE_DECLARATION_KEY
  ] as Record<string, unknown>;
  const diagnostic = declaration[INFRASTRUCTURE_FAILURE_DIAGNOSTIC_KEY];
  return typeof diagnostic === "string" ? diagnostic.trim() : undefined;
}

/** diagnostic → Error, name stamped so the host error identity is observable. */
function infrastructureFailureError(diagnostic: string): Error {
  const error = new Error(diagnostic);
  error.name = "InfrastructureFailure";
  return error;
}

/**
 * The one early call for every terminating output `execute`: if the parameters
 * carry the infra declaration, hand the diagnostic error to the shared host
 * `failInfrastructure` seam (which aborts the run). No-op otherwise.
 *
 * #641 chain②: an optional seat-owned bounce hook may intercept the
 * declaration first — when the seat can machine-verify a lawful normal
 * completion, it returns a correctable error and the declaration is treated as
 * model misuse (交件契约封驳) instead of a host failure. Returning undefined
 * keeps the shared failure path.
 */
export function failOnInfrastructureFailureDeclaration<C>(
  parameters: unknown,
  hostActions: TerminatingInfrastructureHostActions<C>,
  ctx: C,
  toolCallId: string,
  bounceInfrastructureDeclaration?: (params: unknown, toolCallId: string, ctx: C) => CorrectableSubmissionError | undefined,
): void {
  const diagnostic = infrastructureFailureDiagnostic(parameters);
  if (diagnostic === undefined) return;
  if (bounceInfrastructureDeclaration !== undefined) {
    const bounce = bounceInfrastructureDeclaration(parameters, toolCallId, ctx);
    if (bounce !== undefined) throw bounce;
  }
  hostActions.failInfrastructure(
    infrastructureFailureError(diagnostic),
    ctx,
    toolCallId,
  );
}
