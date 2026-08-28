/**
 * Package-owned shared infrastructure-failure declaration for every primary
 * packaged-role output tool (#541).
 *
 * One module owns the three things the judge mandates be shared (not
 * reimplemented per seat):
 *   1. safe recognition of the typed `infrastructureFailure` variant,
 *   2. diagnostic → Error,
 *   3. the single early host fail call each output `execute` makes before any
 *      role business validation / gate / audit / ledger / Git work.
 *
 * The accepted status sets in `terminating-tools.ts` are intentionally NOT
 * extended: an infra declaration must fail BEFORE accepted validation, never
 * become an accepted receipt, audit/gate candidate, unfinished, or no-receipt.
 * The diagnostic is carried verbatim on the thrown Error so settlement keeps
 * the original cause (kind=failure, exit 1, openable run/session pointers).
 */
import { Type } from "typebox";

export const INFRASTRUCTURE_FAILURE_DECLARATION_KEY =
  "infrastructureFailure" as const;
export const INFRASTRUCTURE_FAILURE_DIAGNOSTIC_KEY = "diagnostic" as const;

/** Shared schema fragment reused by every terminating output tool's parameters. */
export const infrastructureFailureDeclarationSchema = Type.Object(
  {
    [INFRASTRUCTURE_FAILURE_DECLARATION_KEY]: Type.Object(
      {
        [INFRASTRUCTURE_FAILURE_DIAGNOSTIC_KEY]: Type.String({ minLength: 1 }),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);

/** Structural host seam subset shared by all eight terminating execute paths. */
export type TerminatingInfrastructureHostActions = {
  failInfrastructure(error: unknown, ctx: unknown, toolCallId?: string): never;
};

/** Safe recognition of the typed declaration (hostile getters / non-shapes fail closed). */
export function isInfrastructureFailureDeclaration(
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
export function infrastructureFailureDiagnostic(
  parameters: unknown,
): string | undefined {
  if (!isInfrastructureFailureDeclaration(parameters)) return undefined;
  const record = parameters as Record<string, unknown>;
  const declaration = record[INFRASTRUCTURE_FAILURE_DECLARATION_KEY] as Record<
    string,
    unknown
  >;
  const diagnostic = declaration[INFRASTRUCTURE_FAILURE_DIAGNOSTIC_KEY];
  return typeof diagnostic === "string" ? diagnostic.trim() : undefined;
}

/** diagnostic → Error, name stamped so the host error identity is observable. */
export function infrastructureFailureError(diagnostic: string): Error {
  const error = new Error(diagnostic);
  error.name = "InfrastructureFailure";
  return error;
}

/**
 * One early call for every terminating output `execute`: if the parameters
 * carry the infra declaration, hand the diagnostic error to the shared host
 * `failInfrastructure` seam (which aborts the run). No-op otherwise.
 */
export function failOnInfrastructureFailureDeclaration(
  parameters: unknown,
  hostActions: TerminatingInfrastructureHostActions,
  ctx: unknown,
  toolCallId: string,
): void {
  const diagnostic = infrastructureFailureDiagnostic(parameters);
  if (diagnostic === undefined) return;
  hostActions.failInfrastructure(
    infrastructureFailureError(diagnostic),
    ctx,
    toolCallId,
  );
}
