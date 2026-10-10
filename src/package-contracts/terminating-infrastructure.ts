/**
 * Package-owned shared infrastructure-failure declaration for every primary
 * packaged-role output tool (#541 / #1214 A2).
 *
 * One module owns the typed `infrastructureFailure.diagnostic` declaration
 * composed into each output tool's schema. The field is part of the role's
 * original receipt: ledger records it as-is. Declaration alone does not abort
 * the host (#1214 A2). True host/lifecycle failure still fails honestly on its
 * own channel.
 */
import { Type, type TSchema } from "typebox";
import { isRecord } from "../unknown-value.ts";

export const INFRASTRUCTURE_FAILURE_DECLARATION_KEY =
  "infrastructureFailure" as const;
export const INFRASTRUCTURE_FAILURE_DIAGNOSTIC_KEY = "diagnostic" as const;

/**
 * Shared declaration fragment for model guidance (#541 / #676 C / ADR 0057).
 * Nested field declarations + descriptions only — host must not pure-shape-reject
 * the envelope (仓内 CLAUDE.md 开篇). Readers may recognize a non-empty diagnostic
 * string via `infrastructureFailureDiagnostic`. No required/minLength/type host
 * gates on the declaration fragment.
 */
const infrastructureFailureNested = Type.Object(
  {
    [INFRASTRUCTURE_FAILURE_DIAGNOSTIC_KEY]: Type.Unknown({
      description: "基础设施失败诊断字符串。",
    }),
  },
  {
    additionalProperties: true,
    description: "仅基础设施真实失败时出现。",
  },
);
// Open nested required so host cannot pure-shape-reject the declaration fragment.
(infrastructureFailureNested as unknown as { required: string[] }).required = [];

const infrastructureFailureDeclarationSchema = Type.Object(
  {
    [INFRASTRUCTURE_FAILURE_DECLARATION_KEY]: infrastructureFailureNested,
  },
  { additionalProperties: true },
);

/**
 * Compose declarations shared by terminating output tools: infrastructure failure,
 * the optional role-asserted ticket identity, and the optional seat-written conclusion
 * summary (#1198). Returns an open object (additionalProperties: true) with the base
 * schema's properties plus the shared declarations. Incoming required keys that still
 * exist are kept; every other key stays optional.
 * Static typing is preserved on the base (`as S`), so existing
 * `Static<typeof ...>` derived parameter types are unchanged.
 */
export function withTerminatingOutputDeclarations<
  S extends TSchema & { properties?: Record<string, TSchema> },
>(schema: S): S {
  const baseProperties = (schema as { properties?: Record<string, TSchema> })
    .properties;
  const properties: Record<string, TSchema> = {
    ...(baseProperties ?? {}),
    ...(
      baseProperties?.ticketNumber === undefined
        ? {
            ticketNumber: Type.Unknown({
              description:
                "可选本票号。尚未绑定时由角色在既有回执中申报（正整数、数字串或前导 #N；归位只读本字段）。",
            }),
          }
        : {}
    ),
    ...(
      baseProperties?.summary === undefined
        ? {
            summary: Type.Unknown({
              description:
                "本席自行填写的一两句、20–50 字结论摘要。可选；不因缺失或超长拒收、截断或代填。",
            }),
          }
        : {}
    ),
    [INFRASTRUCTURE_FAILURE_DECLARATION_KEY]:
      infrastructureFailureDeclarationSchema.properties[
        INFRASTRUCTURE_FAILURE_DECLARATION_KEY
      ],
  };
  const object = Type.Object(properties, { additionalProperties: true });
  const incoming = (schema as { required?: unknown }).required;
  const preserved = Array.isArray(incoming)
    ? incoming.filter((key): key is string => typeof key === "string" && Object.hasOwn(properties, key))
    : [];
  (object as unknown as { required: string[] }).required = preserved;
  return object as unknown as S;
}

/** Safe recognition of the typed declaration; non-shapes / hostile input fail closed. */
function isInfrastructureFailureDeclaration(
  parameters: unknown,
): boolean {
  if (!isRecord(parameters)) return false;
  if (!Object.hasOwn(parameters, INFRASTRUCTURE_FAILURE_DECLARATION_KEY)) return false;
  const declaration = parameters[INFRASTRUCTURE_FAILURE_DECLARATION_KEY];
  if (!isRecord(declaration)) return false;
  const diagnostic = declaration[INFRASTRUCTURE_FAILURE_DIAGNOSTIC_KEY];
  return typeof diagnostic === "string" && diagnostic.trim().length > 0;
}

/** Non-empty trimmed diagnostic from the declaration, else undefined. */
export function infrastructureFailureDiagnostic(
  parameters: unknown,
): string | undefined {
  if (!isInfrastructureFailureDeclaration(parameters)) return undefined;
  const declaration = (parameters as Record<string, unknown>)[
    INFRASTRUCTURE_FAILURE_DECLARATION_KEY
  ] as Record<string, unknown>;
  const diagnostic = declaration[INFRASTRUCTURE_FAILURE_DIAGNOSTIC_KEY];
  return typeof diagnostic === "string" ? diagnostic.trim() : undefined;
}
