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
import { Type } from "typebox";
export const INFRASTRUCTURE_FAILURE_DECLARATION_KEY = "infrastructureFailure";
export const INFRASTRUCTURE_FAILURE_DIAGNOSTIC_KEY = "diagnostic";
/** Shared typed declaration fragment: `infrastructureFailure.diagnostic` = non-empty string. */
const infrastructureFailureDeclarationSchema = Type.Object({
    [INFRASTRUCTURE_FAILURE_DECLARATION_KEY]: Type.Object({
        [INFRASTRUCTURE_FAILURE_DIAGNOSTIC_KEY]: Type.String({
            minLength: 1,
            description: "非空基础设施失败诊断",
        }),
    }, {
        additionalProperties: true,
        description: "基础设施失败声明",
    }),
}, { additionalProperties: true });
/**
 * Compose the shared infrastructure-failure declaration into an open output
 * tool-object schema. Returns an open object (additionalProperties: true,
 * required: []) with the base schema's properties plus the shared declaration.
 * Static typing is preserved on the base (`as S`), so existing
 * `Static<typeof ...>` derived parameter types are unchanged.
 */
export function withInfrastructureFailureDeclaration(schema) {
    const baseProperties = schema
        .properties;
    const properties = {
        ...(baseProperties ?? {}),
        [INFRASTRUCTURE_FAILURE_DECLARATION_KEY]: infrastructureFailureDeclarationSchema.properties[INFRASTRUCTURE_FAILURE_DECLARATION_KEY],
    };
    const object = Type.Object(properties, { additionalProperties: true });
    object.required = [];
    return object;
}
/** Safe recognition of the typed declaration; non-shapes / hostile input fail closed. */
function isInfrastructureFailureDeclaration(parameters) {
    if (parameters === null ||
        typeof parameters !== "object" ||
        Array.isArray(parameters)) {
        return false;
    }
    const record = parameters;
    if (!Object.hasOwn(record, INFRASTRUCTURE_FAILURE_DECLARATION_KEY))
        return false;
    const declaration = record[INFRASTRUCTURE_FAILURE_DECLARATION_KEY];
    if (declaration === null ||
        typeof declaration !== "object" ||
        Array.isArray(declaration)) {
        return false;
    }
    const diagnostic = declaration[INFRASTRUCTURE_FAILURE_DIAGNOSTIC_KEY];
    return typeof diagnostic === "string" && diagnostic.trim().length > 0;
}
/** Non-empty trimmed diagnostic from the declaration, else undefined. */
function infrastructureFailureDiagnostic(parameters) {
    if (!isInfrastructureFailureDeclaration(parameters))
        return undefined;
    const declaration = parameters[INFRASTRUCTURE_FAILURE_DECLARATION_KEY];
    const diagnostic = declaration[INFRASTRUCTURE_FAILURE_DIAGNOSTIC_KEY];
    return typeof diagnostic === "string" ? diagnostic.trim() : undefined;
}
/** diagnostic → Error, name stamped so the host error identity is observable. */
function infrastructureFailureError(diagnostic) {
    const error = new Error(diagnostic);
    error.name = "InfrastructureFailure";
    return error;
}
/**
 * The one early call for every terminating output `execute`: if the parameters
 * carry the infra declaration, hand the diagnostic error to the shared host
 * `failInfrastructure` seam (which aborts the run). No-op otherwise.
 */
export function failOnInfrastructureFailureDeclaration(parameters, hostActions, ctx, toolCallId) {
    const diagnostic = infrastructureFailureDiagnostic(parameters);
    if (diagnostic === undefined)
        return;
    hostActions.failInfrastructure(infrastructureFailureError(diagnostic), ctx, toolCallId);
}
